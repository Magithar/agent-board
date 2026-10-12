// Finds the storage block a board's config.json names and plugs it in.
//
//   { "store": "file" }                    the built-in block (the default)
//   { "store": "./stores/supabase.mjs" }   a block file, relative to .agent-board/
//   { "store": "agent-board-supabase" }    a block published as a package
//
// A block is a module exporting createStore(config, { dir }), which returns a
// Store (the contract is written out in lib/store-file.mjs). The rest of
// config.json is the block's own: a URL, which env var holds its key, and so on.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { BoardError } from './engine.mjs'
import * as file from './store-file.mjs'

const BUILT_IN = { file }
const METHODS = ['now', 'snapshot', 'commit', 'events', 'verify']

export async function loadStore(dir) {
  const configFile = path.join(dir, 'config.json')
  const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {}
  const spec = config.store ?? 'file'

  let block = BUILT_IN[spec]
  if (!block) {
    const target = spec.startsWith('.') || path.isAbsolute(spec) ? pathToFileURL(path.resolve(dir, spec)).href : spec
    try {
      block = await import(target)
    } catch (err) {
      throw new BoardError(2, `cannot load storage block "${spec}": ${err.message}`)
    }
  }
  if (typeof block.createStore !== 'function') throw new BoardError(2, `storage block "${spec}" does not export createStore`)

  const store = await block.createStore(config, { dir })
  const missing = METHODS.filter(m => typeof store?.[m] !== 'function')
  if (missing.length) throw new BoardError(2, `storage block "${spec}" is missing: ${missing.join(', ')}`)
  return { store, name: spec }
}
