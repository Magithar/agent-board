// The board's display blocks. To add one: write it as its own file beside
// these (see types.ts for the shape), import it here, and add it to the list.
// It can then be named in the `band` or `pane` setting.

import { agents } from './agents'
import { clock } from './clock'
import { context } from './context'
import { summary } from './summary'
import { tasks } from './tasks'
import { usage } from './usage'
import type { Block } from './types'

export const BLOCKS: Block[] = [summary, tasks, usage, clock, context, agents]

export type { Block, Ctx } from './types'
