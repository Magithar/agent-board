import type { Block, Ctx } from './types'

const LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const label = (kind: string) => LABEL[kind] ?? kind
const CELLS = 10
const filled = (percent: number) => Math.min(CELLS, Math.round((percent / 100) * CELLS))
// Green while there is room, yellow from 70%, red from 90%: theme colours, so
// they follow the person's terminal theme.
const tone = (percent: number) => (percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'success')

// The bar's used part in the window's colour, the rest dim, then the percent.
function Meter({ Box, Text }: Ctx['ui'], percent: number) {
  return (
    <Box>
      <Text color={tone(percent)}>{'▓'.repeat(filled(percent))}</Text>
      <Text dimColor>{'░'.repeat(CELLS - filled(percent))}</Text>
      <Text color={tone(percent)}>{` ${String(Math.round(percent)).padStart(3)}%`}</Text>
    </Box>
  )
}
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
  band: ({ ui, usage: u }) => {
    const top = [...u.limits].sort((a, b) => b.percentUsed - a.percentUsed)[0]
    if (!top || top.percentUsed < 50) return null
    return (
      <ui.Box gap={1}>
        <ui.Text dimColor>{label(top.kind)}</ui.Text>
        {Meter(ui, top.percentUsed)}
      </ui.Box>
    )
  },
  pane: ({ ui, usage: u, now }) => {
    const { Box, Text } = ui
    if (!u.limits.length) return null
    return (
      <Box flexDirection="column">
        <Text bold>Usage</Text>
        {u.limits.map(l => (
          <Box>
            <Box width={7}>
              <Text dimColor>{label(l.kind)}</Text>
            </Box>
            {Meter(ui, l.percentUsed)}
            {l.resetsAt && <Text dimColor>{`   resets ${when(l.resetsAt, now)}`}</Text>}
          </Box>
        ))}
      </Box>
    )
  },
}
