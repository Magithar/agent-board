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
  assert.equal(b.run(['done', 'T-001', '--as', 'mallory']).code, 5)
  assert.equal(b.run(['done', 'T-001', '--as', 'alice']).code, 0)
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
