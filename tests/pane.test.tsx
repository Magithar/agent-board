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

// The test stands for the host: the session id, the board CLI and the board file.
function host(on: On, tasks: Task[], calls: string[][] = []) {
  on('session.start', (_$, e: any) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e: any) => ({ value: { tool: `mcp__agent-board__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('clock.now', () => ({ value: Date.parse('2026-10-12T00:00:00Z') }))
  on('session.id', () => ({ value: 'aaaa1111-2222-3333-4444-555566667777' }))
  on('process.run', (_$, e: any) => {
    calls.push(e.argv)
    return { value: { exitCode: 0, stdout: e.argv.includes('where') ? '/repo/.agent-board\n' : 'ok\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.read', (_$, e: any, next) =>
    e.path === '/repo/.agent-board/board.json'
      ? { value: JSON.stringify({ tasks: Object.fromEntries(tasks.map(t => [t.id, t])) }) }
      : next(e),
  )
  return calls
}

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const
const PANE = { component: 'Pane', requestId: 'agent-board', props: { title: 'Agent board', bodyColumns: 60 } } as const

test('the pane lists claimed tasks first and marks the ones this session holds', async ($, on) => {
  host(on, [task('T-002', 'todo'), task('T-001', 'claimed', 'claude:aaaa1111'), task('T-003', 'claimed', 'codex')])
  await $.session.start(START)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-board', surface, ...PANE } as any)
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts[0]).toBe('you: claude:aaaa1111')
    expect(texts.indexOf('◐ T-001 title of T-001')).toBeLessThan(texts.indexOf('○ T-002 title of T-002'))
    expect(texts).toContain('   you')
    expect(texts).toContain('   codex')
    await ui.unmount()
  }
})

test('board tools run the shared CLI as this session', async ($, on) => {
  const calls = host(on, [task('T-001', 'todo')])
  await $.session.start(START)

  const ran = await $.tool.call({ tool: 'mcp__agent-board__board_claim', id: 'T-001' } as any)
  const claim = calls.find(argv => argv.includes('claim'))
  expect(claim?.slice(-4)).toEqual(['claim', 'T-001', '--as', 'claude:aaaa1111'])
  expect((ran as any).result).toBe('ok')
})

test('a claim whose lease ran out shows as open, not held', async ($, on) => {
  const ghost = task('T-009', 'claimed', 'ghost')
  host(on, [{ ...ghost, claim: { ...ghost.claim!, expiresAt: '2026-10-11T23:00:00Z' } }])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'agent-board', surface: 'terminal', ...PANE } as any)
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('○ T-009 title of T-009')
  expect(texts).not.toContain('   ghost')
})

test('an empty board says how to add a task', async ($, on) => {
  host(on, [])
  await $.session.start(START)
  const ui = await $.ui.mount({ plugin: 'agent-board', surface: 'terminal', ...PANE } as any)
  expect(await ui.find({ type: 'Text', text: /No tasks/ })).toBeDefined()
})
