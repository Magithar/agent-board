// Holds every block this repo ships, and the loader, to the store contract.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { storeContract } from '../lib/contract.mjs'
import { fileStore } from '../lib/store-file.mjs'
import { createStore as memory } from '../examples/store-memory.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'board-'))

storeContract('file', () => fileStore(path.join(tmp(), '.agent-board')))
storeContract('memory (example)', () => memory())

function board(dir, args) {
  try {
    return { code: 0, out: execFileSync('node', [path.join(ROOT, 'bin/board.mjs'), ...args], { env: { ...process.env, BOARD_DIR: dir }, encoding: 'utf8', stdio: 'pipe' }) }
  } catch (err) {
    return { code: err.status, out: String(err.stderr) }
  }
}

test('config.json can name a block file, which the CLI loads', () => {
  const dir = path.join(tmp(), '.agent-board')
  fs.mkdirSync(dir, { recursive: true })
  // A block of its own: the file block, saving under a folder of its choosing.
  fs.writeFileSync(
    path.join(dir, 'my-block.mjs'),
    `import { fileStore } from ${JSON.stringify(path.join(ROOT, 'lib/store-file.mjs'))}\n` +
      `export const createStore = (config, { dir }) => fileStore(dir + '/' + config.folder)\n`,
  )
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ store: './my-block.mjs', folder: 'elsewhere' }))
  assert.equal(board(dir, ['add', 'hello']).code, 0)
  assert.ok(fs.existsSync(path.join(dir, 'elsewhere', 'board.json')))
  assert.equal(JSON.parse(board(dir, ['doctor']).out).block, './my-block.mjs')
})

test('a block that cannot load, or breaks the contract shape, is refused by name', () => {
  const dir = path.join(tmp(), '.agent-board')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ store: './missing.mjs' }))
  const missing = board(dir, ['list'])
  assert.equal(missing.code, 2)
  assert.match(missing.out, /cannot load storage block "\.\/missing\.mjs"/)

  fs.writeFileSync(path.join(dir, 'half.mjs'), 'export const createStore = () => ({ now: () => 0, snapshot: () => ({}) })\n')
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ store: './half.mjs' }))
  const half = board(dir, ['list'])
  assert.equal(half.code, 2)
  assert.match(half.out, /is missing: commit, events, verify/)
})
