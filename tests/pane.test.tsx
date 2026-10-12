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

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100 } } as const
const inMinutes = (m: number) => new Date(NOW + m * 60_000).toISOString()
const handedOff = (id: string, by: string): Task => ({ ...task(id, 'todo'), notes: [{ at: '', by, text: 'HANDOFF: part 1 done' }] })

test('the pane groups in progress above waiting, and counts done', async ($, on) => {
  host(on, [
    task('T-002', 'todo'),
    { ...task('T-001', 'claimed', 'claude:aaaa1111'), claim: { owner: 'claude:aaaa1111', since: '', expiresAt: inMinutes(11) } },
    task('T-003', 'claimed', 'codex'),
    task('T-004', 'done'),
  ])
  await $.session.start(START)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-board', surface, ...PANE, props: { ...PANE.props, bodyColumns: 80 } } as any)
    const shown = await texts(ui)
    expect(shown.indexOf('In progress')).toBeLessThan(shown.indexOf('title of T-001'))
    expect(shown.indexOf('title of T-003')).toBeLessThan(shown.indexOf('Waiting'))
    expect(shown.indexOf('Waiting')).toBeLessThan(shown.indexOf('title of T-002'))
    expect(shown).toContain('you')
    expect(shown).toContain('codex')
    // A lease with time to spare says nothing; only one that needs you does.
    expect(shown.some((t: string) => /left|responding/.test(t))).toBe(false)
    expect(shown).toContain('1 done')
    expect(shown).not.toContain('title of T-004')
    await ui.unmount()
  }
})

test('the pane flags a handoff nobody picked up and a claim going quiet', async ($, on) => {
  host(on, [
    handedOff('T-005', 'frontend'),
    { ...task('T-006', 'claimed', 'codex'), claim: { owner: 'codex', since: '', expiresAt: inMinutes(3) } },
  ])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'agent-board', surface: 'terminal', ...PANE } as any)
  const shown = await texts(ui)
  expect(shown).toContain('left by frontend, with notes')
  expect(shown).toContain('stopped responding')
})

test('the band says in plain words what is waiting, and the one thing that needs you', async ($, on) => {
  host(on, [handedOff('T-005', 'frontend'), task('T-001', 'claimed', 'codex'), task('T-002', 'todo')])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'agent-board', surface: 'terminal', ...BAND } as any)
  expect(await texts(ui)).toEqual(['2 tasks waiting · 1 in progress', 'T-005 needs someone to continue it'])
})

test('the band names a claim going quiet when no handoff waits', async ($, on) => {
  host(on, [{ ...task('T-006', 'claimed', 'codex'), claim: { owner: 'codex', since: '', expiresAt: inMinutes(2) } }])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'agent-board', surface: 'terminal', ...BAND } as any)
  expect(await texts(ui)).toContain('T-006: codex stopped responding')
})

test('the band stays out of the way when nothing is waiting or in progress', async ($, on) => {
  host(on, [task('T-001', 'done')])
  // Stands for Claude Code's own band beneath the mod.
  on('ui.render', { component: 'AbovePrompt' } as any, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine's own</Text>
  })
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'agent-board', surface: 'terminal', ...BAND } as any)
  expect(await texts(ui)).toEqual(["engine's own"])
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

const measure = (percentUsed: number) => ({
  context: { window: 200000, percent: 41.6 },
  rateLimits: [
    { kind: 'five_hour', percentUsed, resetsAt: '2026-10-12T12:00:00' },
    { kind: 'seven_day', percentUsed: 20, resetsAt: '2026-10-15T12:00:00' },
  ],
  cost: { usd: 1.234 },
  changed: ['context', 'rateLimits', 'cost'],
})

test('usage shows in the pane with resets, and in the band only past half', async ($, on) => {
  host(on, [task('T-001', 'todo')])
  on('session.measure', (_$, e: any) => ({ changed: e.changed }))
  await $.session.start(START)

  await $.session.measure(measure(31) as any)
  const pane = await $.ui.mount({ plugin: 'agent-board', surface: 'terminal', ...PANE } as any)
  const inPane = await texts(pane)
  expect(inPane).toContain('▓▓▓')
  expect(inPane).toContain('░░░░░░░')
  expect(inPane).toContain('  31%')
  expect(inPane).toContain('   resets 12:00')
  expect(inPane).toContain('   resets in 3d')
  expect(inPane).toContain('5-hour limit')
  expect(inPane).toContain('weekly limit')
  let band = await $.ui.mount({ plugin: 'agent-board', surface: 'terminal', ...BAND } as any)
  expect((await texts(band)).some((t: string) => t.endsWith('limit'))).toBe(false)
  await band.unmount()

  await $.session.measure(measure(72.4) as any)
  band = await $.ui.mount({ plugin: 'agent-board', surface: 'terminal', ...BAND } as any)
  expect(await texts(band)).toEqual(expect.arrayContaining(['5-hour limit', '▓▓▓▓▓▓▓', '░░░', '  72%']))
})

test('usage is green with room, yellow from 70%, red from 90%', async ($, on) => {
  host(on, [task('T-001', 'todo')])
  on('session.measure', (_$, e: any) => ({ changed: e.changed }))
  await $.session.start(START)
  for (const [percent, color] of [[64, 'success'], [72, 'warning'], [93, 'error']] as const) {
    await $.session.measure(measure(percent) as any)
    const band = await $.ui.mount({ plugin: 'agent-board', surface: 'terminal', ...BAND } as any)
    const used = await band.find({ type: 'Text', text: /^▓+$/ })
    expect(used?.props.color).toBe(color)
    expect((await band.find({ type: 'Text', text: /^░+$/ }))?.props.dimColor).toBe(true)
    await band.unmount()
  }
})

test('the band and pane settings pick blocks and their order', { options: { band: 'clock', pane: 'clock,tasks,context' } } as any, async ($, on) => {
  host(on, [task('T-001', 'todo')])
  on('session.measure', (_$, e: any) => ({ changed: e.changed }))
  await $.session.start(START)
  await $.session.measure(measure(72) as any)
  const band = await $.ui.mount({ plugin: 'agent-board', surface: 'terminal', ...BAND } as any)
  expect(await texts(band)).toEqual(['09:41'])
  const pane = await $.ui.mount({ plugin: 'agent-board', surface: 'terminal', ...PANE } as any)
  const shown = await texts(pane)
  expect(shown[0]).toBe('09:41')
  expect(shown.at(-1)).toBe('context 42% full · cost $1.23')
  expect(shown.some((t: string) => t.includes('%  ') || t === 'Usage')).toBe(false)
})

test('an empty board says how to add a task', async ($, on) => {
  host(on, [])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'agent-board', surface: 'terminal', ...PANE } as any)
  expect(await ui.find({ type: 'Text', text: /No tasks yet/ })).toBeDefined()
})

test('one task reads as one task', async ($, on) => {
  host(on, [task('T-001', 'todo')])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'agent-board', surface: 'terminal', ...BAND } as any)
  expect(await texts(ui)).toEqual(['1 task waiting'])
})
