#!/usr/bin/env node
// board — an agent-neutral task board. Any agent (Claude, Codex, a human)
// coordinates through this one CLI; nothing else writes the board.
//
// State:  <repo>/.agent-board/board.json   (current state, replaced atomically)
//         <repo>/.agent-board/ledger.jsonl (append-only audit log)
// Lock:   <repo>/.agent-board/lock/        (mkdir is atomic; one lock per board)
//
// The board lives beside the git *common* dir, so every worktree of a repo
// shares one board. BOARD_DIR overrides.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const LEASE_MS = Number(process.env.BOARD_LEASE_MS ?? 15 * 60 * 1000)
const STALE_LOCK_MS = 10_000

function boardDir() {
  if (process.env.BOARD_DIR) return path.resolve(process.env.BOARD_DIR)
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return path.join(path.dirname(common), '.agent-board')
  } catch {
    return path.resolve('.agent-board')
  }
}

const DIR = boardDir()
const STATE = path.join(DIR, 'board.json')
const LEDGER = path.join(DIR, 'ledger.jsonl')
const LOCK = path.join(DIR, 'lock')

class BoardError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function withLock(fn) {
  fs.mkdirSync(DIR, { recursive: true })
  const deadline = Date.now() + 5000
  for (;;) {
    try {
      fs.mkdirSync(LOCK)
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > STALE_LOCK_MS) fs.rmSync(LOCK, { recursive: true, force: true })
      } catch {}
      if (Date.now() > deadline) throw new BoardError(3, 'board is locked; try again')
      sleep(20 + Math.random() * 30)
    }
  }
  try {
    return fn()
  } finally {
    fs.rmSync(LOCK, { recursive: true, force: true })
  }
}

function load() {
  if (!fs.existsSync(STATE)) return { version: 1, seq: 0, nextId: 1, tasks: {} }
  return JSON.parse(fs.readFileSync(STATE, 'utf8'))
}

function save(state) {
  const tmp = `${STATE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
  fs.renameSync(tmp, STATE)
}

// Mutate under the lock: ledger line first, then the state file. A crash
// between the two leaves an event the state lacks, which `doctor` reports.
function mutate(actor, type, fn) {
  return withLock(() => {
    const state = load()
    expireLeases(state)
    const result = fn(state)
    record(state, actor, type, result?.id)
    save(state)
    return result
  })
}

function record(state, actor, type, task, extra = {}) {
  state.seq += 1
  const event = { seq: state.seq, at: new Date().toISOString(), actor, type, task, ...extra }
  fs.appendFileSync(LEDGER, JSON.stringify(event) + '\n')
}

// Expiry is a real transition: recorded in the ledger and saved, so every
// reader (show, the Claude pane reading board.json) sees the same board.
function expireLeases(state) {
  const now = Date.now()
  let changed = false
  for (const t of Object.values(state.tasks)) {
    if (t.status === 'claimed' && Date.parse(t.claim.expiresAt) < now) {
      t.notes.push({ at: new Date().toISOString(), by: 'board', text: `lease of ${t.claim.owner} expired` })
      record(state, 'board', 'expire', t.id)
      t.status = 'todo'
      t.claim = null
      changed = true
    }
  }
  return changed
}

// Read the board, first settling any expired leases.
function current() {
  return withLock(() => {
    const state = load()
    if (expireLeases(state)) save(state)
    return state
  })
}

function getTask(state, id) {
  const t = state.tasks[id.toUpperCase()]
  if (!t) throw new BoardError(4, `no task ${id}`)
  return t
}

function requireOwner(t, actor) {
  if (t.status !== 'claimed' || t.claim.owner !== actor)
    throw new BoardError(5, `${t.id} is not claimed by ${actor}${t.claim ? ` (owner: ${t.claim.owner})` : ''}`)
}

function lease() {
  return new Date(Date.now() + LEASE_MS).toISOString()
}

function parseArgs(argv) {
  const pos = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true
      flags[key] = val
    } else pos.push(a)
  }
  return { pos, flags }
}

function actorOf(flags) {
  const a = flags.as ?? process.env.BOARD_AGENT
  if (!a || a === true) throw new BoardError(2, 'who are you? pass --as <agent> or set BOARD_AGENT')
  return a
}

const SYMBOL = { todo: '○', claimed: '◐', done: '●' }

function line(t) {
  const who = t.claim ? `  ${t.claim.owner}` : ''
  return `${SYMBOL[t.status]} ${t.id}  ${t.title}${who}`
}

const commands = {
  list(_, flags) {
    const state = current()
    const tasks = Object.values(state.tasks).filter(t => flags.all || t.status !== 'done')
    if (flags.json) return tasks
    return tasks.length ? tasks.map(line).join('\n') : '(no open tasks)'
  },

  show([id], flags) {
    const t = getTask(current(), id)
    if (flags.json) return t
    const out = [line(t), '']
    if (t.description) out.push(t.description, '')
    if (t.accept) out.push(`Accept when: ${t.accept}`, '')
    if (t.claim) out.push(`claimed by ${t.claim.owner} until ${t.claim.expiresAt}`)
    for (const n of t.notes) out.push(`- [${n.at.slice(0, 16)}] ${n.by}: ${n.text}`)
    return out.join('\n')
  },

  add([title], flags) {
    if (!title) throw new BoardError(2, 'usage: board add "<title>" [--desc "..."] [--accept "how to tell it is done"]')
    const actor = flags.as ?? process.env.BOARD_AGENT ?? 'human'
    return mutate(actor, 'add', state => {
      const id = `T-${String(state.nextId++).padStart(3, '0')}`
      state.tasks[id] = {
        id,
        title,
        description: typeof flags.desc === 'string' ? flags.desc : '',
        accept: typeof flags.accept === 'string' ? flags.accept : '',
        status: 'todo',
        claim: null,
        notes: [],
        createdBy: actor,
      }
      return state.tasks[id]
    })
  },

  claim([id], flags) {
    const actor = actorOf(flags)
    return withLock(() => {
      const state = load()
      expireLeases(state)
      const t = getTask(state, id)
      if (t.status === 'done') throw new BoardError(5, `${t.id} is done`)
      if (t.status === 'claimed' && t.claim.owner !== actor) {
        // A lost race is evidence too: keep it in the ledger, not only in a transcript.
        record(state, actor, 'claim-rejected', t.id, { holder: t.claim.owner })
        save(state)
        throw new BoardError(6, `${t.id} is already claimed by ${t.claim.owner} until ${t.claim.expiresAt}`)
      }
      t.status = 'claimed'
      t.claim = { owner: actor, since: t.claim?.since ?? new Date().toISOString(), expiresAt: lease() }
      record(state, actor, 'claim', t.id)
      save(state)
      return t
    })
  },

  // Renew every lease this actor holds. Called by hooks, not by hand.
  heartbeat(_, flags) {
    const actor = actorOf(flags)
    return withLock(() => {
      const state = load()
      const expired = expireLeases(state)
      const mine = Object.values(state.tasks).filter(t => t.claim?.owner === actor)
      for (const t of mine) t.claim.expiresAt = lease()
      if (expired || mine.length) save(state)
      return { renewed: mine.map(t => t.id) }
    })
  },

  note([id, text], flags) {
    const actor = actorOf(flags)
    if (!text) throw new BoardError(2, 'usage: board note <id> "<text>"')
    return mutate(actor, 'note', state => {
      const t = getTask(state, id)
      requireOwner(t, actor)
      t.notes.push({ at: new Date().toISOString(), by: actor, text })
      t.claim.expiresAt = lease()
      return t
    })
  },

  release([id], flags) {
    const actor = actorOf(flags)
    return mutate(actor, 'release', state => {
      const t = getTask(state, id)
      requireOwner(t, actor)
      if (typeof flags.handoff === 'string')
        t.notes.push({ at: new Date().toISOString(), by: actor, text: `HANDOFF: ${flags.handoff}` })
      t.status = 'todo'
      t.claim = null
      return t
    })
  },

  // Done means verified: the note says how, against the task's acceptance if it has one.
  done([id], flags) {
    const actor = actorOf(flags)
    return mutate(actor, 'done', state => {
      const t = getTask(state, id)
      requireOwner(t, actor)
      if (typeof flags.note !== 'string' || !flags.note.trim())
        throw new BoardError(
          2,
          `done needs --note saying how you verified ${t.id}` + (t.accept ? ` against: ${t.accept}` : ''),
        )
      t.notes.push({ at: new Date().toISOString(), by: actor, text: `VERIFIED: ${flags.note}` })
      t.status = 'done'
      t.claim = null
      return t
    })
  },

  // Release everything this actor holds, e.g. when its session ends.
  'release-all'(_, flags) {
    const actor = actorOf(flags)
    const handoff = typeof flags.handoff === 'string' ? flags.handoff : `${actor} ended without releasing; read the notes above`
    return withLock(() => {
      const state = load()
      expireLeases(state)
      const mine = Object.values(state.tasks).filter(t => t.claim?.owner === actor)
      for (const t of mine) {
        t.notes.push({ at: new Date().toISOString(), by: actor, text: `HANDOFF: ${handoff}` })
        t.status = 'todo'
        t.claim = null
        record(state, actor, 'release', t.id)
      }
      save(state)
      return { released: mine.map(t => t.id) }
    })
  },

  doctor() {
    const state = load()
    const events = fs.existsSync(LEDGER)
      ? fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
      : []
    const last = events.at(-1)?.seq ?? 0
    const problems = []
    if (last !== state.seq) problems.push(`ledger is at seq ${last}, state at ${state.seq}`)
    return { dir: DIR, tasks: Object.keys(state.tasks).length, events: events.length, ok: !problems.length, problems }
  },

  where() {
    return DIR
  },
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const { pos, flags } = parseArgs(rest)
  const run = commands[cmd]
  if (!run) {
    console.error(`usage: board <${Object.keys(commands).join('|')}> ...   (--json for machine output)`)
    process.exit(2)
  }
  try {
    const out = run(pos, flags)
    if (flags.json || typeof out !== 'string') console.log(JSON.stringify(out, null, 2))
    else console.log(out)
  } catch (err) {
    if (flags.json) console.log(JSON.stringify({ error: err.message, code: err.code ?? 1 }))
    else console.error(`board: ${err.message}`)
    process.exit(typeof err.code === 'number' ? err.code : 1)
  }
}

main()
