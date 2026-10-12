// The board's rules, written once. Storage is a Store (see lib/store-file.mjs
// for the contract): the engine reads a snapshot, decides, and commits its
// writes conditionally, each guarded by the version it read. A commit that
// finds a version moved fails as a whole and the engine decides again from a
// fresh snapshot. That is the one property every backend must give: local
// files under a lock, or a database in one transaction.

export class BoardError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const ATTEMPTS = 50

export function createEngine(store, { leaseMs = 15 * 60 * 1000, presenceMs = 3 * 60 * 1000 } = {}) {
  async function transact(decide) {
    for (let i = 0; i < ATTEMPTS; i++) {
      const snap = await store.snapshot()
      const tx = newTx(snap, await store.now())
      settle(snap, tx)
      const result = decide(tx)
      if (tx.writes.length || tx.events.length) {
        const committed = await store.commit({ writes: tx.writes, events: tx.events })
        if (!committed.ok) {
          await new Promise(resolve => setTimeout(resolve, 5 + Math.random() * 20))
          continue
        }
      }
      if (tx.refusal) throw tx.refusal
      return result
    }
    throw new BoardError(3, 'the board is busy; try again')
  }

  const lease = tx => new Date(tx.now + leaseMs).toISOString()
  const stamp = tx => new Date(tx.now).toISOString()

  function owned(tx, id, actor) {
    const t = tx.task(id)
    if (t.status !== 'claimed' || t.claim.owner !== actor)
      throw new BoardError(5, `${t.id} is not claimed by ${actor}${t.claim ? ` (owner: ${t.claim.owner})` : ''}`)
    return t
  }

  return {
    list: ({ all = false } = {}) =>
      transact(tx => tx.tasks().filter(t => all || t.status !== 'done')),

    show: id => transact(tx => tx.task(id)),

    add: (actor, { title, description = '', accept = '' }) =>
      transact(tx => {
        const id = `T-${String(tx.nextNumber()).padStart(3, '0')}`
        const task = { id, title, description, accept, status: 'todo', claim: null, notes: [], createdBy: actor }
        tx.put('task', id, task)
        tx.event(actor, 'add', id)
        return task
      }),

    claim: (id, actor) =>
      transact(tx => {
        const t = tx.task(id)
        if (t.status === 'done') throw new BoardError(5, `${t.id} is done`)
        if (t.status === 'claimed' && t.claim.owner !== actor) {
          // A lost race is evidence too: keep it in the ledger, not only in a transcript.
          tx.event(actor, 'claim-rejected', t.id, { holder: t.claim.owner })
          tx.refusal = new BoardError(6, `${t.id} is already claimed by ${t.claim.owner} until ${t.claim.expiresAt}`)
          return null
        }
        const claimed = { ...t, status: 'claimed', claim: { owner: actor, since: t.claim?.since ?? stamp(tx), expiresAt: lease(tx) } }
        tx.put('task', t.id, claimed)
        tx.event(actor, 'claim', t.id)
        return claimed
      }),

    // Renew every lease this actor holds, and its presence.
    heartbeat: actor =>
      transact(tx => {
        const mine = tx.tasks().filter(t => t.claim?.owner === actor)
        for (const t of mine) tx.put('task', t.id, { ...t, claim: { ...t.claim, expiresAt: lease(tx) } })
        const agent = tx.agent(actor)
        if (agent) tx.put('agent', actor, { ...agent, lastSeen: tx.now })
        return { renewed: mine.map(t => t.id) }
      }),

    note: (id, actor, text) =>
      transact(tx => {
        const t = owned(tx, id, actor)
        tx.put('task', t.id, { ...t, notes: [...t.notes, { at: stamp(tx), by: actor, text }], claim: { ...t.claim, expiresAt: lease(tx) } })
        tx.event(actor, 'note', t.id)
        return tx.task(t.id)
      }),

    release: (id, actor, handoff) =>
      transact(tx => {
        const t = owned(tx, id, actor)
        const notes = handoff ? [...t.notes, { at: stamp(tx), by: actor, text: `HANDOFF: ${handoff}` }] : t.notes
        tx.put('task', t.id, { ...t, status: 'todo', claim: null, notes })
        tx.event(actor, 'release', t.id)
        return tx.task(t.id)
      }),

    // Done means verified: the note says how, against the task's acceptance if it has one.
    done: (id, actor, note) =>
      transact(tx => {
        const t = owned(tx, id, actor)
        if (!note?.trim())
          throw new BoardError(2, `done needs --note saying how you verified ${t.id}` + (t.accept ? ` against: ${t.accept}` : ''))
        tx.put('task', t.id, { ...t, status: 'done', claim: null, notes: [...t.notes, { at: stamp(tx), by: actor, text: `VERIFIED: ${note}` }] })
        tx.event(actor, 'done', t.id)
        return tx.task(t.id)
      }),

    // Free everything this actor holds and give up its name, e.g. when its session ends.
    releaseAll: (actor, { handoff, session } = {}) =>
      transact(tx => {
        const text = `HANDOFF: ${handoff ?? `${actor} ended without releasing; read the notes above`}`
        const mine = tx.tasks().filter(t => t.claim?.owner === actor)
        for (const t of mine) {
          tx.put('task', t.id, { ...t, status: 'todo', claim: null, notes: [...t.notes, { at: stamp(tx), by: actor, text }] })
          tx.event(actor, 'release', t.id)
        }
        const agent = tx.agent(actor)
        if (agent && (!session || agent.session === session)) tx.put('agent', actor, null)
        return { released: mine.map(t => t.id) }
      }),

    // Take or keep a name. Refused while another live session holds it, since two
    // sessions under one name would share every claim.
    register: (name, session) =>
      transact(tx => {
        const agent = tx.agent(name)
        if (agent && agent.session !== session && tx.now - agent.lastSeen < presenceMs)
          throw new BoardError(7, `the name ${name} is in use by another live session`)
        tx.put('agent', name, { session, lastSeen: tx.now })
        if (agent?.session !== session) tx.event(name, 'register', undefined, { session })
        return { name }
      }),

    agents: () =>
      transact(tx => Object.entries(tx.agentsLive(presenceMs)).map(([name, a]) => ({ name, lastSeen: new Date(a.lastSeen).toISOString() }))),

    events: since => store.events(since),
    doctor: () => store.verify(),
  }
}

// Expiry is a real transition, written like any other, so every reader sees it.
function settle(snap, tx) {
  for (const t of Object.values(snap.tasks)) {
    if (t.status === 'claimed' && Date.parse(t.claim.expiresAt) < tx.now) {
      const note = { at: new Date(tx.now).toISOString(), by: 'board', text: `lease of ${t.claim.owner} expired` }
      tx.put('task', t.id, { ...t, status: 'todo', claim: null, notes: [...t.notes, note] })
      tx.event('board', 'expire', t.id)
    }
  }
}

function newTx(snap, now) {
  const pending = new Map()
  const current = (kind, key) => {
    const write = pending.get(`${kind}:${key}`)
    if (write) return write.value ?? undefined
    return (kind === 'task' ? snap.tasks : snap.agents)[key]
  }
  return {
    now,
    events: [],
    refusal: null,
    get writes() {
      return [...pending.values()]
    },
    // Each write carries the version this decision read, not a later one.
    put(kind, key, value) {
      const base = (kind === 'task' ? snap.tasks : snap.agents)[key]
      pending.set(`${kind}:${key}`, { kind, key, value, expect: base?.version ?? 0 })
    },
    event(actor, type, task, extra = {}) {
      this.events.push({ actor, type, task, ...extra })
    },
    task(id) {
      const t = current('task', String(id).toUpperCase())
      if (!t) throw new BoardError(4, `no task ${id}`)
      return t
    },
    tasks() {
      return Object.keys({ ...snap.tasks, ...Object.fromEntries([...pending.values()].filter(w => w.kind === 'task').map(w => [w.key, 1])) })
        .map(id => current('task', id))
        .filter(Boolean)
        .sort((a, b) => a.id.localeCompare(b.id))
    },
    agent: name => current('agent', name),
    agentsLive(presenceMs) {
      return Object.fromEntries(Object.entries(snap.agents).filter(([, a]) => now - a.lastSeen < presenceMs))
    },
    nextNumber() {
      return Math.max(0, ...Object.keys(snap.tasks).map(id => Number(id.replace(/\D/g, '')) || 0)) + 1
    },
  }
}
