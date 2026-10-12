import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const BOARD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'board.mjs')

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-'))
  const env = { ...process.env, BOARD_DIR: path.join(dir, '.agent-board') }
  const run = (args, extra = {}) => {
    try {
      return { code: 0, out: execFileSync('node', [BOARD, ...args], { env: { ...env, ...extra }, encoding: 'utf8', stdio: 'pipe' }) }
    } catch (err) {
      return { code: err.status, out: String(err.stderr) }
    }
  }
  const json = (args, extra) => JSON.parse(run([...args, '--json'], extra).out)
  return { env, run, json }
}

test('exactly one of twenty simultaneous claims wins', async () => {
  const b = fresh()
  b.run(['add', 'contested'])
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      new Promise(resolve => execFile('node', [BOARD, 'claim', 'T-001', '--as', `a${i}`], { env: b.env }, err => resolve(err ? err.code : 0))),
    ),
  )
  assert.equal(results.filter(code => code === 0).length, 1)
  assert.ok(results.filter(code => code !== 0).every(code => code === 6))
  assert.equal(b.json(['doctor']).ok, true)
})

test('only the owner can note, release or finish a task', () => {
  const b = fresh()
  b.run(['add', 'mine'])
  b.run(['claim', 'T-001', '--as', 'alice'])
  assert.equal(b.run(['note', 'T-001', 'hi', '--as', 'mallory']).code, 5)
  assert.equal(b.run(['release', 'T-001', '--as', 'mallory']).code, 5)
  assert.equal(b.run(['done', 'T-001', '--as', 'mallory', '--note', 'x']).code, 5)
  assert.equal(b.run(['done', 'T-001', '--as', 'alice', '--note', 'ran it']).code, 0)
})

test('a handoff written on release reaches the next agent', () => {
  const b = fresh()
  b.run(['add', 'two parts'])
  b.run(['claim', 'T-001', '--as', 'alice'])
  b.run(['release', 'T-001', '--as', 'alice', '--handoff', 'part 1 done, part 2 left'])
  b.run(['claim', 'T-001', '--as', 'bob'])
  const t = b.json(['show', 'T-001'])
  assert.equal(t.claim.owner, 'bob')
  assert.match(t.notes.at(-1).text, /^HANDOFF: part 1 done/)
})

test('an expired lease frees the task for every reader and is recorded', async () => {
  const b = fresh()
  b.run(['add', 'abandoned'])
  b.run(['claim', 'T-001', '--as', 'ghost'], { BOARD_LEASE_MS: '200' })
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(b.json(['show', 'T-001']).status, 'todo')
  const state = JSON.parse(fs.readFileSync(path.join(b.env.BOARD_DIR, 'board.json'), 'utf8'))
  assert.equal(state.tasks['T-001'].status, 'todo')
  const ledger = fs.readFileSync(path.join(b.env.BOARD_DIR, 'ledger.jsonl'), 'utf8')
  assert.match(ledger, /"type":"expire"/)
  assert.equal(b.run(['claim', 'T-001', '--as', 'bob']).code, 0)
})

test('a heartbeat keeps a lease alive', async () => {
  const b = fresh()
  b.run(['add', 'long'])
  b.run(['claim', 'T-001', '--as', 'alice'], { BOARD_LEASE_MS: '400' })
  await new Promise(resolve => setTimeout(resolve, 250))
  b.run(['heartbeat', '--as', 'alice'], { BOARD_LEASE_MS: '400' })
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(b.json(['show', 'T-001']).claim.owner, 'alice')
})

test('a lost claim is recorded in the ledger with who held the task', () => {
  const b = fresh()
  b.run(['add', 'contested'])
  b.run(['claim', 'T-001', '--as', 'alice'])
  assert.equal(b.run(['claim', 'T-001', '--as', 'bob']).code, 6)
  const events = fs.readFileSync(path.join(b.env.BOARD_DIR, 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(
    { type: events.at(-1).type, actor: events.at(-1).actor, holder: events.at(-1).holder },
    { type: 'claim-rejected', actor: 'bob', holder: 'alice' },
  )
  assert.equal(b.json(['doctor']).ok, true)
})

test('done needs a note saying how the task was verified, against its acceptance', () => {
  const b = fresh()
  b.run(['add', 'greet', '--accept', './greet.sh prints hello'])
  assert.match(b.run(['show', 'T-001']).out, /Accept when: \.\/greet\.sh prints hello/)
  b.run(['claim', 'T-001', '--as', 'alice'])
  const refused = b.run(['done', 'T-001', '--as', 'alice'])
  assert.equal(refused.code, 2)
  assert.match(refused.out, /against: \.\/greet\.sh prints hello/)
  assert.equal(b.run(['done', 'T-001', '--as', 'alice', '--note', 'ran ./greet.sh, got hello']).code, 0)
  assert.equal(b.json(['show', 'T-001']).notes.at(-1).text, 'VERIFIED: ran ./greet.sh, got hello')
})

test('release-all frees every task an ending session holds, with a handoff', () => {
  const b = fresh()
  for (const title of ['one', 'two', 'three']) b.run(['add', title])
  b.run(['claim', 'T-001', '--as', 'alice'])
  b.run(['claim', 'T-002', '--as', 'alice'])
  b.run(['claim', 'T-003', '--as', 'bob'])
  assert.deepEqual(b.json(['release-all', '--as', 'alice']).released, ['T-001', 'T-002'])
  assert.equal(b.json(['show', 'T-001']).status, 'todo')
  assert.match(b.json(['show', 'T-002']).notes.at(-1).text, /^HANDOFF: alice ended without releasing/)
  assert.equal(b.json(['show', 'T-003']).claim.owner, 'bob')
  assert.equal(b.json(['doctor']).ok, true)
})
