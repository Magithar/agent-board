import type { Block } from './types'

// Who is live on the board. Off by default: each task row already names its owner.
export const agents: Block = {
  name: 'agents',
  pane: ({ ui: { Text }, agents: list, who }) =>
    list.length ? <Text dimColor>{`live: ${list.map(a => (a.name === who ? `${a.name} (you)` : a.name)).join(', ')}`}</Text> : null,
}
