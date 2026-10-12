import type { Agent, Task, Usage } from '../../types'

// What every block draws from. `ui` is the surface's own element table.
export type Ctx = {
  ui: { Box: any; Text: any }
  width: number
  now: number
  who: string
  tasks: Task[]
  agents: Agent[]
  usage: Usage
}

// A block is one part of the board's display. It may draw in the band above
// the prompt (one short piece of a line), in the /board pane, or both; it
// returns null when it has nothing worth showing, and then takes no space.
export type Block = {
  name: string
  band?: (c: Ctx) => any
  pane?: (c: Ctx) => any
}
