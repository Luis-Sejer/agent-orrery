import { describe, expect, it } from 'vitest'

import { current, forecastOf, resetText, toneOf, windowsOf } from './usage'

const NOW = new Date(2026, 9, 13, 15, 0).getTime()
const HOUR = 3_600_000

describe('plan usage', () => {
  it('turns amber near the limit and red at it', () => {
    expect([toneOf(64), toneOf(80), toneOf(95)]).toEqual(['calm', 'warn', 'full'])
  })

  it('starts a window again once its reset time has passed', () => {
    expect(current({ percent: 98, resetsAt: NOW - 1 }, NOW)).toEqual({ percent: 0, resetsAt: null })
    expect(current({ percent: 64, resetsAt: NOW + HOUR }, NOW)?.percent).toBe(64)
  })

  it('says when a window resets, with the day when it is not today', () => {
    expect(resetText(new Date(2026, 9, 13, 19, 50).getTime(), NOW)).toBe('resets 19:50')
    expect(resetText(new Date(2026, 9, 17, 9, 0).getTime(), NOW)).toBe('resets Sat 09:00')
    expect(resetText(null, NOW)).toBe('')
  })

  it('shows only the windows it knows, as /usage names them', () => {
    const usage = { at: NOW, fiveHour: { percent: 64, resetsAt: NOW + HOUR }, sevenDay: null }
    expect(windowsOf(usage, NOW).map(({ name }) => name)).toEqual(['Session'])
  })
})

describe('the session forecast', () => {
  const at = NOW
  const window = (forecast: { perHour: number; atReset: number; limitAt: number | null }) => ({ at, fiveHour: { percent: 60, resetsAt: NOW + 2 * HOUR, forecast }, sevenDay: null })

  it('warns, in red, when the limit comes before the reset', () => {
    const ahead = forecastOf(window({ perHour: 30, atReset: 100, limitAt: new Date(2026, 9, 13, 16, 20).getTime() }), NOW)
    expect(ahead).toMatchObject({ tone: 'full', text: "At this pace, you'll reach the limit around 16:20" })
  })

  it('otherwise says where it will be at the reset', () => {
    expect(forecastOf(window({ perHour: 5, atReset: 70, limitAt: null }), NOW)?.text).toBe('At this pace, about 70% by 17:00')
  })

  it('says nothing when idle, or when the numbers are old', () => {
    expect(forecastOf(window({ perHour: 0, atReset: 60, limitAt: null }), NOW)).toBeNull()
    expect(forecastOf({ ...window({ perHour: 5, atReset: 70, limitAt: null }), at: NOW - 60 * 60_000 }, NOW)).toBeNull()
  })
})
