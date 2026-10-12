import type { Task } from '../../types'
import type { Block, Ctx } from './types'
import { goingQuiet, handedOffBy, handoffWaiting, minutesLeft } from './attention'

function Row({ ui: { Box, Text }, width, now, who }: Ctx, t: Task) {
  const isMine = t.claim?.owner === who
  const owner = t.claim ? (isMine ? 'you' : t.claim.owner) : ''
  const right =
    t.status === 'claimed'
      ? `${minutesLeft(t, now)}m left${goingQuiet(t, now) ? '  ⚠' : ''}`
      : handoffWaiting(t)
        ? `← handoff from ${handedOffBy(t)}`
        : ''
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
          <Text color={goingQuiet(t, now) || handoffWaiting(t) ? 'warning' : undefined} dimColor={!goingQuiet(t, now) && !handoffWaiting(t)}>
            {right}
          </Text>
        </Box>
      )}
    </Box>
  )
}

// Working first, then open, with room between them; done tasks become a count.
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
            <Text bold>Working</Text>
            {working.map(t => Row(c, t))}
          </Box>
        )}
        {open.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Open</Text>
            {open.map(t => Row(c, t))}
          </Box>
        )}
        {done > 0 && <Text dimColor>{`${done} done`}</Text>}
      </Box>
    )
  },
}
