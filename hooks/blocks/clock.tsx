import type { Block } from './types'

const pad = (n: number) => String(n).padStart(2, '0')

export const clock: Block = {
  name: 'clock',
  band: ({ ui: { Text }, now }) => <Text dimColor>{`${pad(new Date(now).getHours())}:${pad(new Date(now).getMinutes())}`}</Text>,
  pane: ({ ui: { Text }, now }) => <Text bold>{`${pad(new Date(now).getHours())}:${pad(new Date(now).getMinutes())}`}</Text>,
}
