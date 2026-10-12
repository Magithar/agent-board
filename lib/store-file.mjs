// The local block: a board in a directory.
//
// The Store contract every block implements (all methods may be async):
//
//   now()               the store's clock, in ms. Leases use it, so every
//                       device agrees on time (a database answers its own).
//   snapshot()          { tasks: {id: Task}, agents: {name: Agent} }, each
//                       record carrying the `version` it stands at.
//   commit({ writes, events })
//                       writes: [{ kind: 'task'|'agent', key, value|null, expect }]
//                       Applies every write and appends every event, or
//                       nothing: all-or-none, and only if each record still
//                       stands at `expect` (0 = must not exist). Answers
//                       { ok: true } or { ok: false, conflict }. Each applied
//                       record's version becomes expect + 1; null deletes.
//   events(since)       ledger events with seq > since.
//   verify()            { ok, problems, ... }: does the history match the state?
//
// Here a commit runs under one lock per board (mkdir is atomic), the ledger
// line is appended before the state file is replaced (rename is atomic), so a
// crash between the two leaves an event the state lacks, which verify reports.

import fs from 'node:fs'
import path from 'node:path'

const STALE_LOCK_MS = 10_000

export function fileStore(dir) {
  const STATE = path.join(dir, 'board.json')
  const LEDGER = path.join(dir, 'ledger.jsonl')
  const LOCK = path.join(dir, 'lock')

  function load() {
    if (!fs.existsSync(STATE)) return { version: 2, seq: 0, tasks: {}, agents: {} }
    const state = JSON.parse(fs.readFileSync(STATE, 'utf8'))
    // 0.1 boards had no versions or agents.
    for (const t of Object.values(state.tasks)) t.version ??= 1
    state.agents ??= {}
    delete state.nextId
    return state
  }

  function save(state) {
    const tmp = `${STATE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ ...state, version: 2 }, null, 2) + '\n')
    fs.renameSync(tmp, STATE)
  }

  function withLock(fn) {
    fs.mkdirSync(dir, { recursive: true })
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
        if (Date.now() > deadline) return { ok: false, conflict: 'lock' }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + Math.random() * 20)
      }
    }
    try {
      return fn()
    } finally {
      fs.rmSync(LOCK, { recursive: true, force: true })
    }
  }

  function readLedger() {
    if (!fs.existsSync(LEDGER)) return []
    return fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  }

  return {
    now: () => Date.now(),

    snapshot: () => {
      const { tasks, agents } = load()
      return { tasks, agents }
    },

    commit: ({ writes, events }) =>
      withLock(() => {
        const state = load()
        const table = kind => (kind === 'task' ? state.tasks : state.agents)
        for (const w of writes) {
          if ((table(w.kind)[w.key]?.version ?? 0) !== w.expect) return { ok: false, conflict: `${w.kind}:${w.key}` }
        }
        for (const w of writes) {
          if (w.value === null) delete table(w.kind)[w.key]
          else table(w.kind)[w.key] = { ...w.value, version: w.expect + 1 }
        }
        const at = new Date().toISOString()
        const lines = events.map(e => JSON.stringify({ seq: ++state.seq, at, ...e }) + '\n').join('')
        if (lines) fs.appendFileSync(LEDGER, lines)
        save(state)
        return { ok: true }
      }),

    events: (since = 0) => readLedger().filter(e => e.seq > since),

    verify: () => {
      const state = load()
      const events = readLedger()
      const last = events.at(-1)?.seq ?? 0
      const problems = []
      if (last !== state.seq) problems.push(`ledger is at seq ${last}, state at ${state.seq}`)
      return { store: 'file', dir, tasks: Object.keys(state.tasks).length, events: events.length, ok: !problems.length, problems }
    },
  }
}
