import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Task } from '../types'

// The mod is an adapter: every write goes through bin/board.mjs, the same CLI
// Codex or a human runs. The mod adds what only Claude's host can: the
// session's identity, heartbeats from tool activity, a live pane.

const PANE = 'agent-board'
const HEARTBEAT_MS = 60_000
const POLL_MS = 3_000

const tasks = atom({ plugin: 'agent-board', key: 'tasks' } as const, [])
const me = atom({ plugin: 'agent-board', key: 'me' } as const, '')

let boardFile = ''
let lastBeat = 0

async function board($: EngineInterface, args: string[]) {
  const who = await read($, me)
  const run = await $.process.run(['node', `${$.plugin.root}/bin/board.mjs`, ...args, '--as', who])
  return { ok: run.exitCode === 0, text: (run.exitCode === 0 ? run.stdout : run.stderr || run.stdout).trim() }
}

async function refresh($: EngineInterface) {
  if (!boardFile) return
  const text = await $.fs.read(boardFile).catch(() => '')
  const now = await $.clock.now()
  // Show an expired lease as open even before the CLI next settles it.
  const list: Task[] = (text ? (Object.values(JSON.parse(text).tasks) as Task[]) : []).map(t =>
    t.claim && Date.parse(t.claim.expiresAt) < now ? { ...t, status: 'todo', claim: null } : t,
  )
  await update($, tasks, () => list)
  const who = await read($, me)
  const open = list.filter(t => t.status !== 'done').length
  const mine = list.filter(t => t.claim?.owner === who).map(t => t.id)
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
    description: 'Show one task with its notes and handoffs. Read this before resuming a task someone else released.',
    schema: { id: { type: 'string' } },
    required: ['id'],
    args: (i: any) => ['show', i.id],
  },
  {
    name: 'board_add',
    description: 'Add a task to the shared board.',
    schema: { title: { type: 'string' }, description: { type: 'string' } },
    required: ['title'],
    args: (i: any) => ['add', i.title, ...(i.description ? ['--desc', i.description] : [])],
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
    description: 'Mark a task you hold as done. Only after its acceptance criteria are tested.',
    schema: { id: { type: 'string' }, note: { type: 'string' } },
    required: ['id'],
    args: (i: any) => ['done', i.id, ...(i.note ? ['--note', i.note] : [])],
  },
]

const SYMBOL = { todo: '○', claimed: '◐', done: '●' } as const

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const id = await $.session.id()
    await update($, me, () => `claude:${id.slice(0, 8)}`)

    const where = await $.process.run(['node', `${$.plugin.root}/bin/board.mjs`, 'where'])
    boardFile = `${where.stdout.trim()}/board.json`

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

  on('command.run', { command: 'board' }, async $ => {
    await refresh($)
    const opened = await $.ui.open({ id: PANE, title: 'Agent board' })
    if (opened.isPlaced) return { text: 'Board pane opened.' }
    const list = (await read($, tasks)).filter(t => t.status !== 'done')
    return { text: list.map(t => `${SYMBOL[t.status]} ${t.id}  ${t.title}${t.claim ? `  ${t.claim.owner}` : ''}`).join('\n') || '(no open tasks)' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, tasks)
    const who = await read($, me)
    const width = e.props.bodyColumns ?? 40
    const order = { claimed: 0, todo: 1, done: 2 } as const
    const shown = [...list].sort((a, b) => order[a.status] - order[b.status] || a.id.localeCompare(b.id))

    return (
      <Box flexDirection="column">
        <Text dimColor>you: {who}</Text>
        {shown.length === 0 && <Text dimColor>No tasks. Ask Claude to add some, or run `board add`.</Text>}
        {shown.map(t => {
          const owner = t.claim ? (t.claim.owner === who ? 'you' : t.claim.owner) : ''
          const label = `${SYMBOL[t.status]} ${t.id} ${t.title}`
          return (
            <Box flexDirection="column">
              <Text bold={owner === 'you'} dimColor={t.status === 'done'}>
                {label.slice(0, Math.max(10, width - owner.length - 2))}
              </Text>
              {owner && <Text dimColor>   {owner}</Text>}
            </Box>
          )
        })}
      </Box>
    )
  })
}
