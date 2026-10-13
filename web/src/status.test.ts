import { describe, expect, it } from 'vitest'

import { describeSpend, costOf, mergeUsage, priceOf } from './pricing'
import { awaitAgents, describeStatus, isQuiet, statusOf } from './status'
import type { AgentNode } from './types'

const NOW = Date.parse('2026-10-12T12:00:00Z')
const MINUTE = 60_000

function node(fields: Partial<AgentNode> = {}): AgentNode {
  return {
    id: 'a',
    kind: 'subagent',
    label: 'a',
    branch: null,
    home: 'api',
    room: 'api',
    repos: [],
    activity: 'working',
    lastTool: 'Bash',
    lastAt: NOW,
    waiting: null,
    pendingTool: null,
    usage: {},
    agentType: null,
    model: null,
    sessionId: null,
    parentId: null,
    plans: [],
    ...fields,
  }
}

describe('quiet agents', () => {
  it('stay running for 15 minutes, or 2 hours while a tool call is open', () => {
    const idle = node({ lastAt: NOW - 20 * MINUTE })
    const pending = node({ lastAt: NOW - 20 * MINUTE, pendingTool: { name: 'Bash', since: NOW - 20 * MINUTE } })
    expect(statusOf(idle, NOW)).toBe('finished')
    expect(statusOf(pending, NOW)).toBe('running')
    expect(statusOf({ ...pending, lastAt: NOW - 121 * MINUTE }, NOW)).toBe('finished')
  })

  it('are running agents with no activity for 5 minutes', () => {
    expect(isQuiet(node({ lastAt: NOW - 4 * MINUTE }), NOW)).toBe(false)
    expect(isQuiet(node({ lastAt: NOW - 6 * MINUTE }), NOW)).toBe(true)
    expect(isQuiet(node({ lastAt: NOW - 20 * MINUTE }), NOW)).toBe(false)
  })

  it('say what they may be waiting for', () => {
    const quiet = node({ lastAt: NOW - 7 * MINUTE })
    expect(describeStatus(quiet, NOW)).toBe('Quiet for 7 min')
    const stuck = { ...quiet, pendingTool: { name: 'Bash', since: NOW - 7 * MINUTE } }
    expect(describeStatus(stuck, NOW)).toBe('Bash has run for 7 min, may be waiting for your approval')
  })
})

describe('cost', () => {
  const opus = { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 500_000 }

  it('prices each model with its cache multipliers', () => {
    // 4 + 2 + 0.4 + 5 + 4 dollars at Opus 5.5 rates.
    expect(costOf({ 'claude-opus-5-5': opus })).toBeCloseTo(15.4)
    expect(costOf({ 'claude-sonnet-4-5-20250929': { ...opus, cacheWrite1h: 0 } })).toBeCloseTo(3 + 1.5 + 0.6 + 3.75)
  })

  it('shows tokens only for a model it has no price for', () => {
    expect(costOf({ 'claude-unknown-9': opus })).toBeNull()
    expect(describeSpend({ 'claude-unknown-9': opus })).toBe('4.6 M tokens')
  })

  it('describes spend and merges models', () => {
    const small = { input: 1_000, output: 500, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }
    expect(describeSpend({ 'claude-haiku-4-5': small })).toBe('under $0.01, 2 k tokens')
    expect(describeSpend({})).toBeNull()
    expect(mergeUsage([{ m: small }, { m: small }]).m.input).toBe(2_000)
  })
})

describe('request-dependent prices', () => {
  it('doubles every price in fast mode on Opus 5.5, and ignores fast on models without it', () => {
    expect(priceOf('claude-opus-5-5 fast')).toEqual({ input: 8, output: 40, cacheRead: 0.4 })
    expect(priceOf('claude-sonnet-4-6 fast')).toEqual(priceOf('claude-sonnet-4-6'))
  })

  it('charges Haiku 5.5 long prompts the higher tier, and only Haiku 5.5', () => {
    expect(priceOf('claude-haiku-5-5 long')).toEqual({ input: 0.5, output: 2.5, cacheRead: 0.05 })
    expect(priceOf('claude-opus-5-5 long')).toEqual(priceOf('claude-opus-5-5'))
  })
})

describe('waiting on its own agents', () => {
  const NOW = Date.parse('2026-10-13T08:00:00Z')
  const base = { branch: null, home: 'app', room: 'app', repos: [], activity: null, lastTool: null, pendingTool: null, usage: {}, agentType: null, model: null, plans: [] }
  const session = (fields: Partial<AgentNode> = {}): AgentNode => ({ ...base, id: 'lead', kind: 'session', label: 'Lead', sessionId: 'lead', parentId: null, lastAt: NOW - 4 * 60_000, waiting: { reason: 'reply', since: NOW - 4 * 60_000 }, ...fields })
  const helper = (fields: Partial<AgentNode> = {}): AgentNode => ({ ...base, id: 'helper', kind: 'subagent', label: 'Helper', sessionId: 'lead', parentId: 'lead', lastAt: NOW - 30_000, waiting: null, ...fields })

  it('keeps a session running, not waiting on you, while a subagent it started still runs', () => {
    const lead = awaitAgents({ nodes: [session(), helper()], messages: [] }, NOW).nodes[0]
    expect(statusOf(lead, NOW)).toBe('running')
    expect(describeStatus(lead, NOW)).toBe('Waiting on 1 agent')
    expect(isQuiet(lead, NOW)).toBe(false)
  })

  it('waits on you again once its subagents are done, and always when it asked a question', () => {
    expect(statusOf(awaitAgents({ nodes: [session(), helper({ waiting: { reason: 'reply', since: NOW } })], messages: [] }, NOW).nodes[0], NOW)).toBe('waiting')
    const asked = session({ waiting: { reason: 'question', since: NOW } })
    expect(statusOf(awaitAgents({ nodes: [asked, helper()], messages: [] }, NOW).nodes[0], NOW)).toBe('waiting')
  })
})
