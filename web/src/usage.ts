import type { Usage, UsageWindow } from './types'

// Past these, a window is close to its limit, then at it.
const WARN_PERCENT = 80
const FULL_PERCENT = 95
// A status line redraws every few seconds while any session is busy; older than this, say how old.
export const USAGE_STALE_MS = 15 * 60_000
const DAY_MS = 24 * 3_600_000

export type UsageTone = 'calm' | 'warn' | 'full'

export function toneOf(percent: number): UsageTone {
  if (percent >= FULL_PERCENT) return 'full'
  return percent >= WARN_PERCENT ? 'warn' : 'calm'
}

// A window whose reset time has passed has started again, whatever was last seen.
export function current(window: UsageWindow | null, now: number): UsageWindow | null {
  if (!window) return null
  return window.resetsAt !== null && window.resetsAt <= now ? { percent: 0, resetsAt: null } : window
}

// "resets 18:30" today, "resets Sat 09:00" later in the week.
export function resetText(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return ''
  const time = new Date(resetsAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (resetsAt - now < DAY_MS && new Date(resetsAt).getDate() === new Date(now).getDate()) return `resets ${time}`
  return `resets ${new Date(resetsAt).toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`
}

export const isStale = (usage: Usage, now: number) => now - usage.at > USAGE_STALE_MS

const clock = (at: number) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

// The session's forecast, if it's fresh and going anywhere: its tone, and a line to say it.
export function forecastOf(usage: Usage, now: number): { tone: UsageTone; text: string; limitAt: number | null; atReset: number } | null {
  const window = current(usage.fiveHour, now)
  const forecast = window?.forecast
  if (!window || !forecast || forecast.perHour <= 0 || isStale(usage, now)) return null
  if (forecast.limitAt !== null) return { tone: 'full', text: `At this pace, you'll reach the limit around ${clock(forecast.limitAt)}`, limitAt: forecast.limitAt, atReset: forecast.atReset }
  const by = window.resetsAt === null ? '' : ` by ${clock(window.resetsAt)}`
  return { tone: toneOf(forecast.atReset), text: `At this pace, about ${Math.round(forecast.atReset)}%${by}`, limitAt: null, atReset: forecast.atReset }
}

// The windows worth showing, named as /usage names them.
export function windowsOf(usage: Usage, now: number): { name: string; window: UsageWindow }[] {
  return [
    { name: 'Session', window: current(usage.fiveHour, now) },
    { name: 'Week', window: current(usage.sevenDay, now) },
  ].filter((entry): entry is { name: string; window: UsageWindow } => entry.window !== null)
}
