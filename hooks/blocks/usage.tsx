import type { Block } from './types'

const LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const label = (kind: string) => LABEL[kind] ?? kind
const bar = (percent: number, cells = 10) => {
  const filled = Math.min(cells, Math.round((percent / 100) * cells))
  return '▓'.repeat(filled) + '░'.repeat(cells - filled)
}
const tone = (percent: number) => (percent >= 90 ? 'error' : percent >= 70 ? 'warning' : undefined)
const pad = (n: number) => String(n).padStart(2, '0')
const when = (iso: string, now: number) => {
  const d = new Date(iso)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const days = Math.floor((d.getTime() - now) / 86_400_000)
  return days >= 1 ? `in ${days}d` : time
}

// This session's plan usage. In the band only once a window passes half, since
// below that it is noise; in the pane, every window with its reset.
export const usage: Block = {
  name: 'usage',
  band: ({ ui: { Text }, usage: u }) => {
    const top = [...u.limits].sort((a, b) => b.percentUsed - a.percentUsed)[0]
    if (!top || top.percentUsed < 50) return null
    return <Text color={tone(top.percentUsed)}>{`${label(top.kind)} ${bar(top.percentUsed)} ${Math.round(top.percentUsed)}%`}</Text>
  },
  pane: ({ ui: { Box, Text }, usage: u, now }) => {
    if (!u.limits.length) return null
    return (
      <Box flexDirection="column">
        <Text bold>Usage</Text>
        {u.limits.map(l => (
          <Box>
            <Box width={7}>
              <Text dimColor>{label(l.kind)}</Text>
            </Box>
            <Text color={tone(l.percentUsed)}>{`${bar(l.percentUsed)} ${String(Math.round(l.percentUsed)).padStart(3)}%`}</Text>
            {l.resetsAt && <Text dimColor>{`   resets ${when(l.resetsAt, now)}`}</Text>}
          </Box>
        ))}
      </Box>
    )
  },
}
