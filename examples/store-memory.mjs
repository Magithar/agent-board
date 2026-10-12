// A storage block in one small file: the reference for writing your own.
//
// It keeps the board in memory, so it lasts only as long as one process and
// is useful for tests, not for a real board. A real block (a database, a
// server) has the same five methods; the hard one is commit, which must apply
// all of its writes or none, and only where every version still matches.
//
// Check a block with the contract suite:
//   import { storeContract } from 'agent-board/lib/contract.mjs'
//   storeContract('my block', () => createStore(config, { dir }))

export const createStore = () => memoryStore()

export function memoryStore() {
  const state = { tasks: {}, agents: {} }
  const ledger = []
  return {
    now: () => Date.now(),
    snapshot: async () => structuredClone(state),
    commit: async ({ writes, events }) => {
      const table = kind => (kind === 'task' ? state.tasks : state.agents)
      for (const w of writes) if ((table(w.kind)[w.key]?.version ?? 0) !== w.expect) return { ok: false, conflict: w.key }
      for (const w of writes) {
        if (w.value === null) delete table(w.kind)[w.key]
        else table(w.kind)[w.key] = { ...structuredClone(w.value), version: w.expect + 1 }
      }
      for (const e of events) ledger.push({ seq: ledger.length + 1, at: new Date().toISOString(), ...e })
      return { ok: true }
    },
    events: async (since = 0) => ledger.filter(e => e.seq > since),
    verify: async () => ({ ok: true, problems: [] }),
  }
}

