import type { Block } from './types'
import { goingQuiet, handoffWaiting } from './attention'

// The band's main line: how much is moving, and the one thing that needs you.
export const summary: Block = {
  name: 'summary',
  band: ({ ui: { Box, Text }, tasks, now }) => {
    const working = tasks.filter(t => t.status === 'claimed').length
    const open = tasks.filter(t => t.status === 'todo').length
    if (!working && !open) return null
    const waiting = tasks.filter(handoffWaiting)
    const quiet = tasks.filter(t => goingQuiet(t, now))
    const counts = [working && `${working} working`, open && `${open} open`].filter(Boolean).join(' · ')
    const alert = waiting.length
      ? `! ${waiting[0]!.id} handoff waiting${waiting.length > 1 ? ` +${waiting.length - 1}` : ''}`
      : quiet.length
        ? `! ${quiet[0]!.id} ${quiet[0]!.claim!.owner} went quiet`
        : ''
    return (
      <Box gap={3}>
        <Text dimColor>{counts}</Text>
        {alert && <Text color="warning">{alert}</Text>}
      </Box>
    )
  },
}
