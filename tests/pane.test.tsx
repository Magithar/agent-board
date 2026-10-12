import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import type { Task } from '../types'

const task = (id: string, status: Task['status'], owner?: string): Task => ({
  id,
  title: `title of ${id}`,
  description: '',
  status,
  claim: owner ? { owner, since: '2026-10-12T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' } : null,
  notes: [],
})

const NOW = Date.parse('2026-10-12T09:41:00')

// The test stands for the host: the clock, the session, the environment and the
// board CLI, which answers from `tasks` and refuses the names in `taken`.
function host(on: On, tasks: Task[], { agent, taken = [] }: { agent?: string; taken?: string[] } = {}) {
  const calls: string[][] = []
  on('session.start', (_$, e: any) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e: any) => ({ value: { tool: `mcp__agent-board__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('clock.now', () => ({ value: NOW }))
  on('session.id', () => ({ value: 'aaaa1111-2222-3333-4444-555566667777' }))
  on('env.get', (_$, e: any) => ({ value: e.name === 'BOARD_AGENT' ? agent : undefined }))
  on('process.run', (_$, e: any) => {
    const argv: string[] = [...e.argv]
    calls.push(argv)
    const refused = argv[2] === 'register' && taken.includes(argv[3]!)
    const stdout = argv[2] === 'view' ? JSON.stringify({ tasks, agents: [{ name: 'codex', lastSeen: '' }] }) : 'ok'
    return {
      value: {
        exitCode: refused ? 7 : 0,
        stdout: refused ? '' : stdout,
        stderr: refused ? 'board: the name is in use' : '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  return calls
}

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const PANE = { component: 'Pane', requestId: 'agent-board', props: { title: 'Agent board', bodyColumns: 60 } } as const
const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)

test('the pane lists claimed tasks first and marks the ones this session holds', async ($, on) => {
  host(on, [task('T-002', 'todo'), task('T-001', 'claimed', 'claude:aaaa1111'), task('T-003', 'claimed', 'codex')])
  await $.session.start(START)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-board', surface, ...PANE } as any)
    const shown = await texts(ui)
    expect(shown).toContain('agents: codex')
    expect(shown.indexOf('◐ T-001 title of T-001')).toBeLessThan(shown.indexOf('○ T-002 title of T-002'))
    expect(shown).toContain('   you')
    expect(shown).toContain('   codex')
    await ui.unmount()
  }
})

test('a session takes the name it was started with', async ($, on) => {
  const calls = host(on, [], { agent: 'frontend' })
  await $.session.start(START)
  await $.tool.call({ tool: 'mcp__agent-board__board_claim', id: 'T-001' } as any)
  expect(calls.find(argv => argv.includes('claim'))?.slice(-4)).toEqual(['claim', 'T-001', '--as', 'frontend'])
})

test('a name another live session holds falls back to the next free one', async ($, on) => {
  const calls = host(on, [], { agent: 'frontend', taken: ['frontend'] })
  await $.session.start(START)
  await $.tool.call({ tool: 'mcp__agent-board__board_list' } as any)
  expect(calls.find(argv => argv.includes('list'))?.slice(-2)).toEqual(['--as', 'frontend-2'])
})

test('with no name asked for, the session is named from its id', async ($, on) => {
  const calls = host(on, [])
  await $.session.start(START)
  await $.tool.call({ tool: 'mcp__agent-board__board_list' } as any)
  expect(calls.find(argv => argv.includes('list'))?.slice(-2)).toEqual(['--as', 'claude:aaaa1111'])
})

test('board_done passes the verification note through', async ($, on) => {
  const calls = host(on, [task('T-001', 'claimed', 'claude:aaaa1111')])
  await $.session.start(START)
  await $.tool.call({ tool: 'mcp__agent-board__board_done', id: 'T-001', note: 'ran it, saw hello' } as any)
  expect(calls.find(argv => argv.includes('done'))?.slice(-6)).toEqual(['done', 'T-001', '--note', 'ran it, saw hello', '--as', 'claude:aaaa1111'])
})

test('ending the session releases what it holds and gives up its name', async ($, on) => {
  const calls = host(on, [], { agent: 'frontend' })
  on('session.end', () => ({ sessionId: 'aaaa1111-2222-3333-4444-555566667777' }))
  await $.session.start(START)
  await $.session.end({ reason: 'logout' } as any)
  expect(calls.find(argv => argv.includes('release-all'))?.slice(-5)).toEqual([
    'release-all',
    '--session',
    'aaaa1111-2222-3333-4444-555566667777',
    '--as',
    'frontend',
  ])
})

test('the usage block shows the latest reading', async ($, on) => {
  host(on, [])
  on('session.measure', (_$, e: any) => ({ changed: e.changed }))
  await $.session.start(START)
  await $.session.measure({
    context: { window: 200000, percent: 41.6 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 72.4, resetsAt: '2026-10-12T12:00:00', source: 'x' }],
    cost: { usd: 1.234 },
    changed: ['context', 'rateLimits', 'cost'],
  } as any)
  const ui = await $.ui.mount({ plugin: 'agent-board', surface: 'terminal', ...PANE } as any)
  const shown = await texts(ui)
  expect(shown).toContain('five_hour: 72% used · resets 12:00')
  expect(shown).toContain('context: 42% full')
  expect(shown).toContain('cost: $1.23')
})

test('the blocks setting picks the blocks and their order', { options: { blocks: 'clock,tasks' } } as any, async ($, on) => {
  host(on, [task('T-001', 'todo')])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'agent-board', surface: 'terminal', ...PANE } as any)
  const shown = await texts(ui)
  expect(shown[0]).toBe('09:41')
  expect(shown[1]).toBe('○ T-001 title of T-001')
  expect(shown.some((t: string) => t.startsWith('agents:') || t.startsWith('usage'))).toBe(false)
})

test('an empty board says how to add a task', async ($, on) => {
  host(on, [])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'agent-board', surface: 'terminal', ...PANE } as any)
  expect(await ui.find({ type: 'Text', text: /No tasks/ })).toBeDefined()
})
