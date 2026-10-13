import { describe, expect, it } from 'vitest'

import type { AgentNode } from './types'
import { duration, waitedOnYou, waitSpans } from './waits'

const NOW = Date.parse('2026-10-12T12:00:00Z')
const MINUTE = 60_000

const session = (fields: Partial<AgentNode>): AgentNode => ({
  id: 's',
  kind: 'session',
  label: 's',
  branch: null,
  home: null,
  room: null,
  repos: [],
  activity: null,
  lastTool: null,
  lastAt: NOW,
  waiting: null,
  pendingTool: null,
  usage: {},
  agentType: null,
  model: null,
  sessionId: 's',
  parentId: null,
  plans: [],
  ...fields,
})

describe('time waiting on you', () => {
  it('counts answered waits once each, plus the open one, from the start of the day', () => {
    const node = session({
      youWaits: [
        [NOW - 60 * MINUTE, NOW - 50 * MINUTE],
        // The same question, seen in the transcript and in the status file.
        [NOW - 55 * MINUTE, NOW - 45 * MINUTE],
        [NOW - 30 * 60 * MINUTE, NOW - 29 * 60 * MINUTE],
      ],
      waiting: { reason: 'reply', since: NOW - 5 * MINUTE },
    })
    const since = NOW - 2 * 60 * MINUTE
    expect(waitSpans(node, NOW, since)).toEqual([
      [NOW - 60 * MINUTE, NOW - 45 * MINUTE],
      [NOW - 5 * MINUTE, NOW],
    ])
    expect(waitedOnYou([node], NOW, since)).toBe(20 * MINUTE)
  })

  it('stops counting a wait you dismissed, or a session that has closed', () => {
    const wait = { waiting: { reason: 'reply' as const, since: NOW - 5 * MINUTE } }
    expect(waitedOnYou([session({ ...wait, dismissed: true }), session({ ...wait, live: { status: 'closed' } })], NOW, 0)).toBe(0)
  })

  it('reads as minutes and hours', () => {
    expect(duration(20_000)).toBe('under a minute')
    expect(duration(47 * MINUTE)).toBe('47 min')
    expect(duration(125 * MINUTE)).toBe('2 h 5 min')
    expect(duration(120 * MINUTE)).toBe('2 h')
  })
})
