import type { Block } from './types'

// The context window's fill and what the session has cost. Off by default:
// Claude Code shows the context already.
export const context: Block = {
  name: 'context',
  band: ({ ui: { Text }, usage: u }) =>
    u.context === undefined ? null : <Text dimColor>{`ctx ${Math.round(u.context)}%`}</Text>,
  pane: ({ ui: { Text }, usage: u }) => {
    const parts = [
      u.context !== undefined && `context ${Math.round(u.context)}% full`,
      u.costUsd !== undefined && `cost $${u.costUsd.toFixed(2)}`,
    ].filter(Boolean)
    return parts.length ? <Text dimColor>{parts.join(' · ')}</Text> : null
  },
}
