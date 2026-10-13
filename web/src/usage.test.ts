import { describe, expect, it } from 'vitest'

import { current, resetText, toneOf, windowsOf } from './usage'

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
