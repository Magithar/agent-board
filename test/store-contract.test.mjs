// Every storage block must pass this file. A new block (a database, a server)
// adds itself to BLOCKS and is held to the same rules as the local one.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { createEngine } from '../lib/engine.mjs'
import { fileStore } from '../lib/store-file.mjs'

// The smallest block that keeps the contract: the reference for writing one.
function memoryStore() {
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

const BLOCKS = {
  file: () => fileStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'board-')), '.agent-board')),
  memory: () => memoryStore(),
}

const refused = async (promise, code) => assert.equal(await promise.then(() => 0, err => err.code), code)

for (const [name, make] of Object.entries(BLOCKS)) {
  describe(`the ${name} block`, () => {
    test('one of many concurrent claims wins; the rest are refused and recorded', async () => {
      const store = make()
      const board = createEngine(store)
      await board.add('human', { title: 'contested' })
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, (_, i) => board.claim('T-001', `a${i}`).then(() => 'won', err => err.code)),
      )
      assert.equal(outcomes.filter(o => o === 'won').length, 1)
      assert.equal(outcomes.filter(o => o === 6).length, 9)
      const events = await store.events(0)
      assert.equal(events.filter(e => e.type === 'claim-rejected').length, 9)
    })

    test('concurrent adds get distinct ids', async () => {
      const board = createEngine(make())
      const added = await Promise.all(Array.from({ length: 8 }, (_, i) => board.add('human', { title: `t${i}` })))
      assert.equal(new Set(added.map(t => t.id)).size, 8)
    })

    test('a write from an agent that no longer owns the task is refused', async () => {
      const board = createEngine(make(), { leaseMs: 50 })
      await board.add('human', { title: 'x' })
      await board.claim('T-001', 'alice')
      await new Promise(resolve => setTimeout(resolve, 80))
      await board.claim('T-001', 'bob')
      await refused(board.note('T-001', 'alice', 'stale write'), 5)
      assert.equal((await board.show('T-001')).claim.owner, 'bob')
    })

    test('a name is refused while another live session holds it, and freed when it ends', async () => {
      const board = createEngine(make())
      await board.register('frontend', 'session-a')
      await board.register('frontend', 'session-a')
      await refused(board.register('frontend', 'session-b'), 7)
      await board.releaseAll('frontend', { session: 'session-a' })
      await board.register('frontend', 'session-b')
      assert.deepEqual((await board.agents()).map(a => a.name), ['frontend'])
    })

    test('a name whose session went silent can be taken over', async () => {
      const board = createEngine(make(), { presenceMs: 50 })
      await board.register('frontend', 'session-a')
      await new Promise(resolve => setTimeout(resolve, 80))
      await board.register('frontend', 'session-b')
    })
  })
}
