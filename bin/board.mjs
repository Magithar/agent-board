#!/usr/bin/env node
// board — an agent-neutral task board. Any agent (Claude, Codex, a human)
// coordinates through this one CLI; nothing else writes the board.
//
// The board lives in <repo>/.agent-board/, beside the git *common* dir so
// every worktree of a repo shares one board (BOARD_DIR overrides). Which
// storage block holds it is read from .agent-board/config.json; the default,
// and the only block built in, is "file".

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { BoardError, createEngine } from '../lib/engine.mjs'
import { fileStore } from '../lib/store-file.mjs'

const STORES = { file: dir => fileStore(dir) }

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

function openStore(dir) {
  const file = path.join(dir, 'config.json')
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  const kind = config.store ?? 'file'
  const make = STORES[kind]
  if (!make) throw new BoardError(2, `no storage block "${kind}" (known: ${Object.keys(STORES).join(', ')})`)
  return make(dir, config)
}

function parseArgs(argv) {
  const pos = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const val = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true
      flags[a.slice(2)] = val
    } else pos.push(a)
  }
  return { pos, flags }
}

const text = v => (typeof v === 'string' ? v : undefined)

function actorOf(flags) {
  const a = text(flags.as) ?? process.env.BOARD_AGENT
  if (!a) throw new BoardError(2, 'who are you? pass --as <agent> or set BOARD_AGENT')
  return a
}

const SYMBOL = { todo: '○', claimed: '◐', done: '●' }
const line = t => `${SYMBOL[t.status]} ${t.id}  ${t.title}${t.claim ? `  ${t.claim.owner}` : ''}`

function describe(t) {
  const out = [line(t), '']
  if (t.description) out.push(t.description, '')
  if (t.accept) out.push(`Accept when: ${t.accept}`, '')
  if (t.claim) out.push(`claimed by ${t.claim.owner} until ${t.claim.expiresAt}`)
  for (const n of t.notes) out.push(`- [${n.at.slice(0, 16)}] ${n.by}: ${n.text}`)
  return out.join('\n')
}

const DIR = boardDir()

const commands = {
  async list(board, _, flags) {
    const tasks = await board.list({ all: !!flags.all })
    if (flags.json) return tasks
    return tasks.length ? tasks.map(line).join('\n') : '(no open tasks)'
  },
  async show(board, [id], flags) {
    const t = await board.show(id)
    return flags.json ? t : describe(t)
  },
  add(board, [title], flags) {
    if (!title) throw new BoardError(2, 'usage: board add "<title>" [--desc "..."] [--accept "how to tell it is done"]')
    return board.add(text(flags.as) ?? process.env.BOARD_AGENT ?? 'human', {
      title,
      description: text(flags.desc),
      accept: text(flags.accept),
    })
  },
  claim: (board, [id], flags) => board.claim(id, actorOf(flags)),
  heartbeat: (board, _, flags) => board.heartbeat(actorOf(flags)),
  note(board, [id, note], flags) {
    if (!note) throw new BoardError(2, 'usage: board note <id> "<text>"')
    return board.note(id, actorOf(flags), note)
  },
  release: (board, [id], flags) => board.release(id, actorOf(flags), text(flags.handoff)),
  done: (board, [id], flags) => board.done(id, actorOf(flags), text(flags.note)),
  'release-all': (board, _, flags) => board.releaseAll(actorOf(flags), { handoff: text(flags.handoff), session: text(flags.session) }),
  register(board, [name], flags) {
    const session = text(flags.session)
    if (!name || !session) throw new BoardError(2, 'usage: board register <name> --session <id>')
    return board.register(name, session)
  },
  agents: board => board.agents(),
  // Everything a display needs, in one call: every task and the live agents.
  view: async board => ({ tasks: await board.list({ all: true }), agents: await board.agents() }),
  events: (board, [since]) => board.events(Number(since ?? 0)),
  doctor: board => board.doctor(),
  where: () => DIR,
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const { pos, flags } = parseArgs(rest)
  const run = commands[cmd]
  if (!run) {
    console.error(`usage: board <${Object.keys(commands).join('|')}> ...   (--json for machine output)`)
    process.exit(2)
  }
  try {
    const board = createEngine(openStore(DIR), { leaseMs: Number(process.env.BOARD_LEASE_MS ?? 15 * 60 * 1000) })
    const out = await run(board, pos, flags)
    console.log(flags.json || typeof out !== 'string' ? JSON.stringify(out, null, 2) : out)
  } catch (err) {
    if (!(err instanceof BoardError)) throw err
    if (flags.json) console.log(JSON.stringify({ error: err.message, code: err.code }))
    else console.error(`board: ${err.message}`)
    process.exit(err.code)
  }
}

main()
