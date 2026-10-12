import type { Task } from '../../types'
import type { Block, Ctx } from './types'
import { goingQuiet, handedOffBy, handoffWaiting } from './attention'

function Row({ ui: { Box, Text }, width, now, who }: Ctx, t: Task) {
  const isMine = t.claim?.owner === who
  const owner = t.claim ? (isMine ? 'you' : t.claim.owner) : ''
  // Said only when it needs you: an agent that stopped, or work left with notes.
  const right = goingQuiet(t, now) ? 'stopped responding' : handoffWaiting(t) ? `left by ${handedOffBy(t)}, with notes` : ''
  const wide = width >= 64
  return (
    <Box>
      <Box width={3}>
        <Text color={t.status === 'claimed' ? 'claude' : undefined} dimColor={t.status === 'todo'}>
          {t.status === 'claimed' ? '◐' : '○'}
        </Text>
      </Box>
      <Box width={7}>
        <Text dimColor>{t.id}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text bold={isMine} wrap="truncate">
          {t.title}
        </Text>
      </Box>
      {wide && owner && (
        <Box width={14} marginLeft={2}>
          <Text dimColor wrap="truncate">
            {owner}
          </Text>
        </Box>
      )}
      {right && (
        <Box marginLeft={2}>
          <Text color="warning">{right}</Text>
        </Box>
      )}
    </Box>
  )
}

// In progress first, then waiting, with room between them; done tasks become a count.
export const tasks: Block = {
  name: 'tasks',
  pane: c => {
    const { Box, Text } = c.ui
    const working = c.tasks.filter(t => t.status === 'claimed')
    const open = c.tasks.filter(t => t.status === 'todo')
    const done = c.tasks.filter(t => t.status === 'done').length
    if (!c.tasks.length) return <Text dimColor>No tasks yet. Ask Claude to add some, or run `board add`.</Text>
    return (
      <Box flexDirection="column" gap={1}>
        {working.length > 0 && (
          <Box flexDirection="column">
            <Text bold>In progress</Text>
            {working.map(t => Row(c, t))}
          </Box>
        )}
        {open.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Waiting</Text>
            {open.map(t => Row(c, t))}
          </Box>
        )}
        {done > 0 && <Text dimColor>{`${done} done`}</Text>}
      </Box>
    )
  },
}
