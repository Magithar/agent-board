import type { Task } from '../../types'

const QUIET_MS = 5 * 60 * 1000

// A task someone released with a handoff, that nobody has picked up yet.
export const handoffWaiting = (t: Task) => t.status === 'todo' && (t.notes.at(-1)?.text.startsWith('HANDOFF:') ?? false)

// The last agent to hand a task off, read from its handoff note.
export const handedOffBy = (t: Task) => t.notes.at(-1)?.by ?? ''

// A claim whose lease is nearly out: its agent has stopped working, or stopped
// renewing, for most of a lease.
export const goingQuiet = (t: Task, now: number) =>
  t.status === 'claimed' && t.claim !== null && Date.parse(t.claim.expiresAt) - now < QUIET_MS
