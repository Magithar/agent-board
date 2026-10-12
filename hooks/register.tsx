import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Agent, Task, Usage } from '../types'

// The mod is an adapter: every board read and write goes through bin/board.mjs,
// the same CLI Codex or a human runs, so it works whatever storage block holds
// the board. The mod adds what only Claude's host can: the session's identity,
// heartbeats, usage readings, and a pane built from blocks.

const PANE = 'agent-board'
const HEARTBEAT_MS = 60_000
const PRESENCE_MS = 60_000
const POLL_MS = 3_000
const NAME_TRIES = 9

const tasks = atom({ plugin: 'agent-board', key: 'tasks' } as const, [])
const agents = atom({ plugin: 'agent-board', key: 'agents' } as const, [])
const me = atom({ plugin: 'agent-board', key: 'me' } as const, '')
const usage = atom({ plugin: 'agent-board', key: 'usage' } as const, { limits: [] })

let session = ''
let lastBeat = 0

async function cli($: EngineInterface, args: string[]) {
  const run = await $.process.run(['node', `${$.plugin.root}/bin/board.mjs`, ...args])
  return { ok: run.exitCode === 0, code: run.exitCode, text: (run.exitCode === 0 ? run.stdout : run.stderr || run.stdout).trim() }
}

async function board($: EngineInterface, args: string[]) {
  return cli($, [...args, '--as', await read($, me)])
}

// Take the name asked for in BOARD_AGENT, or the next free one after it; with
// none asked for, a name from the session id, which no other session has.
async function takeName($: EngineInterface, wanted: string | undefined) {
  if (!wanted) {
    const name = `claude:${session.slice(0, 8)}`
    await cli($, ['register', name, '--session', session])
    return name
  }
  for (let i = 1; i <= NAME_TRIES; i++) {
    const name = i === 1 ? wanted : `${wanted}-${i}`
    const taken = await cli($, ['register', name, '--session', session])
    if (taken.ok) {
      if (i > 1) $.ui.toast(`board: "${wanted}" is in use by another live session, so this one is "${name}"`)
      return name
    }
    if (taken.code !== 7) break
  }
  const name = `claude:${session.slice(0, 8)}`
  $.ui.toast(`board: could not take the name "${wanted}", so this session is "${name}"`)
  await cli($, ['register', name, '--session', session])
  return name
}

async function refresh($: EngineInterface) {
  const out = await cli($, ['view', '--json'])
  if (!out.ok) return
  const view = JSON.parse(out.text) as { tasks: Task[]; agents: Agent[] }
  await update($, tasks, () => view.tasks)
  await update($, agents, () => view.agents)
  const who = await read($, me)
  const open = view.tasks.filter(t => t.status !== 'done').length
  const mine = view.tasks.filter(t => t.claim?.owner === who).map(t => t.id)
  $.ui.status(open ? `board: ${open} open${mine.length ? ` · mine ${mine.join(',')}` : ''}` : undefined)
}

const TOOLS = [
  {
    name: 'board_list',
    description:
      'List open tasks on the shared board several agents work from at once (○ todo, ◐ claimed, with owner). ' +
      'Protocol: claim a task before working on it, note progress, release with a handoff if you stop, never touch a task another agent holds.',
    args: () => ['list'],
  },
  {
    name: 'board_show',
    description: 'Show one task with its acceptance criteria, notes and handoffs. Read this before resuming a task someone else released.',
    schema: { id: { type: 'string' } },
    required: ['id'],
    args: (i: any) => ['show', i.id],
  },
  {
    name: 'board_add',
    description: 'Add a task to the shared board. Give it acceptance criteria: how to tell it is done.',
    schema: { title: { type: 'string' }, description: { type: 'string' }, accept: { type: 'string' } },
    required: ['title'],
    args: (i: any) => [
      'add',
      i.title,
      ...(i.description ? ['--desc', i.description] : []),
      ...(i.accept ? ['--accept', i.accept] : []),
    ],
  },
  {
    name: 'board_claim',
    description:
      'Claim a task before working on it. Fails if another agent holds it — then pick another task. Your lease renews automatically while you work.',
    schema: { id: { type: 'string' } },
    required: ['id'],
    args: (i: any) => ['claim', i.id],
  },
  {
    name: 'board_note',
    description: 'Record progress on a task you hold (what is done, what is next, decisions).',
    schema: { id: { type: 'string' }, text: { type: 'string' } },
    required: ['id', 'text'],
    args: (i: any) => ['note', i.id, i.text],
  },
  {
    name: 'board_release',
    description:
      'Give up a task you hold without finishing it. Always write a handoff: what is done, what is left, where to look — the next agent starts from it.',
    schema: { id: { type: 'string' }, handoff: { type: 'string' } },
    required: ['id', 'handoff'],
    args: (i: any) => ['release', i.id, '--handoff', i.handoff],
  },
  {
    name: 'board_done',
    description:
      'Mark a task you hold as done. Only after you have checked it against its acceptance criteria (board_show lists them). ' +
      'The note says how you verified it: what you ran or checked and what you saw.',
    schema: { id: { type: 'string' }, note: { type: 'string' } },
    required: ['id', 'note'],
    args: (i: any) => ['done', i.id, '--note', i.note ?? ''],
  },
]

const SYMBOL = { todo: '○', claimed: '◐', done: '●' } as const

const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// The pane is a stack of blocks. Each block is one function drawing one part;
// the `blocks` setting picks which, in which order. A new block is a new entry.
type Ctx = { Box: any; Text: any; width: number; now: number; who: string; tasks: Task[]; agents: Agent[]; usage: Usage }

const BLOCKS: Record<string, (c: Ctx) => any> = {
  clock: ({ Text, now }) => <Text bold>{hhmm(now)}</Text>,

  usage: ({ Box, Text, usage: u, now }) => {
    if (!u.limits.length && u.context === undefined && u.costUsd === undefined)
      return <Text dimColor>usage: no reading yet</Text>
    return (
      <Box flexDirection="column">
        {u.limits.map(l => (
          <Text color={l.percentUsed >= 90 ? 'red' : l.percentUsed >= 70 ? 'yellow' : undefined}>
            {`${l.kind}: ${Math.round(l.percentUsed)}% used`}
            {l.resetsAt ? ` · resets ${hhmm(Date.parse(l.resetsAt))}${Date.parse(l.resetsAt) - now > 86_400_000 ? '+' : ''}` : ''}
          </Text>
        ))}
        {u.context !== undefined && <Text dimColor>{`context: ${Math.round(u.context)}% full`}</Text>}
        {u.costUsd !== undefined && <Text dimColor>{`cost: $${u.costUsd.toFixed(2)}`}</Text>}
      </Box>
    )
  },

  agents: ({ Text, who, agents: list }) => (
    <Text dimColor>{`agents: ${list.map(a => (a.name === who ? `${a.name} (you)` : a.name)).join(', ') || who}`}</Text>
  ),

  tasks: ({ Box, Text, who, width, tasks: list }) => {
    const order = { claimed: 0, todo: 1, done: 2 } as const
    const shown = [...list].sort((a, b) => order[a.status] - order[b.status] || a.id.localeCompare(b.id))
    if (!shown.length) return <Text dimColor>No tasks. Ask Claude to add some, or run `board add`.</Text>
    return (
      <Box flexDirection="column">
        {shown.map(t => {
          const owner = t.claim ? (t.claim.owner === who ? 'you' : t.claim.owner) : ''
          const label = `${SYMBOL[t.status]} ${t.id} ${t.title}`
          return (
            <Box flexDirection="column">
              <Text bold={owner === 'you'} dimColor={t.status === 'done'}>
                {label.slice(0, Math.max(10, width - 2))}
              </Text>
              {owner && <Text dimColor>   {owner}</Text>}
            </Box>
          )
        })}
      </Box>
    )
  },
}

export const register: Register = (on, options) => {
  const chosen = String(options.blocks ?? 'agents,usage,tasks')
    .split(',')
    .map(b => b.trim())
    .filter(b => b in BLOCKS)

  on('session.start', async ($, e, next) => {
    session = await $.session.id()
    const name = await takeName($, await $.env.get('BOARD_AGENT'))
    await update($, me, () => name)

    for (const t of TOOLS)
      await $.tool.register({
        name: t.name,
        description: t.description,
        inputSchema: { type: 'object', properties: t.schema ?? {}, required: t.required ?? [] },
        isDeferred: false,
      })
    await $.command.register({ name: 'board', description: 'Open the shared agent board pane' })

    await refresh($)
    $.clock.every(POLL_MS, () => refresh($).catch(() => {}))
    // Presence: keeps this session's name while it is open, so no other
    // session can take it; leases stay tied to work (see tool.call below).
    $.clock.every(PRESENCE_MS, () => cli($, ['register', name, '--session', session]).catch(() => {}))

    return next(e)
  })

  for (const t of TOOLS)
    on('tool.call', { tool: `mcp__agent-board__${t.name}` }, async ($, e) => {
      const out = await board($, t.args(e))
      await refresh($)
      return { result: out.ok ? out.text : `error: ${out.text}` }
    }).catch(() => ({ result: 'error: the board CLI could not run (is node on PATH?)' }))

  // Leases need a heartbeat; an LLM won't send one, so tool activity does.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const now = await $.clock.now()
    if (now - lastBeat > HEARTBEAT_MS) {
      lastBeat = now
      const who = await read($, me)
      // A failed heartbeat must never fail the tool call it rode in on.
      if ((await read($, tasks)).some(t => t.claim?.owner === who)) await board($, ['heartbeat']).catch(() => {})
    }
    return ran
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, () => ({
      limits: e.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
      context: e.context.percent,
      costUsd: e.cost?.usd,
    }))
    return next(e)
  })

  // A session that ends (exit, /clear, resume, logout) releases what it holds
  // and gives up its name, so neither sits orphaned until a lease runs out.
  on('session.end', async ($, e, next) => {
    await board($, ['release-all', '--session', session]).catch(() => {})
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'board' }, async $ => {
    await refresh($)
    const opened = await $.ui.open({ id: PANE, title: 'Agent board' })
    if (opened.isPlaced) return { text: 'Board pane opened.' }
    const list = (await read($, tasks)).filter(t => t.status !== 'done')
    return { text: list.map(t => `${SYMBOL[t.status]} ${t.id}  ${t.title}${t.claim ? `  ${t.claim.owner}` : ''}`).join('\n') || '(no open tasks)' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const ctx: Ctx = {
      Box,
      Text,
      width: e.props.bodyColumns ?? 40,
      now: await $.clock.now(),
      who: await read($, me),
      tasks: await read($, tasks),
      agents: await read($, agents),
      usage: await read($, usage),
    }
    return <Box flexDirection="column">{chosen.map(name => BLOCKS[name]!(ctx))}</Box>
  })
}
