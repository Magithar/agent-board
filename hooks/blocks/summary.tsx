import type { Block } from './types'
import { goingQuiet, handoffWaiting } from './attention'

const tasksWord = (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`

// The band's main line: how much is waiting and in progress, and the one thing
// that needs you. Plain words: the reader need not know the board's terms.
export const summary: Block = {
  name: 'summary',
  band: ({ ui: { Box, Text }, tasks, now }) => {
    const working = tasks.filter(t => t.status === 'claimed').length
    const open = tasks.filter(t => t.status === 'todo').length
    if (!working && !open) return null
    const waiting = tasks.filter(handoffWaiting)
    const quiet = tasks.filter(t => goingQuiet(t, now))
    const counts = [open && `${tasksWord(open)} waiting`, working && `${working} in progress`].filter(Boolean).join(' · ')
    const alert = waiting.length
      ? `${waiting[0]!.id} needs someone to continue it${waiting.length > 1 ? ` (+${waiting.length - 1} more)` : ''}`
      : quiet.length
        ? `${quiet[0]!.id}: ${quiet[0]!.claim!.owner} stopped responding`
        : ''
    return (
      <Box gap={3}>
        <Text dimColor>{counts}</Text>
        {alert && <Text color="warning">{alert}</Text>}
      </Box>
    )
  },
}
