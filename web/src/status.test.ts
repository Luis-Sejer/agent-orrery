import { describe, expect, it } from 'vitest'

import { describeSpend, costOf, formatTokens, mergeUsage, priceOf } from './pricing'
import { awaitAgents, describeStatus, isFreshWait, isQuiet, statusOf, waitingLine, withoutFinished } from './status'
import { applyDismissals } from './useDismissed'
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
    expect(describeSpend({ 'claude-unknown-9': opus })).toBe('4.6M tokens')
  })

  it('describes spend and merges models', () => {
    const small = { input: 1_000, output: 500, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }
    expect(describeSpend({ 'claude-haiku-4-5': small })).toBe('under $0.01, 2k tokens')
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
    expect(describeStatus(lead, NOW)).toBe('Waiting on an agent')
    expect(isQuiet(lead, NOW)).toBe(false)
  })

  it('waits on you again once its subagents are done, and always when it asked a question', () => {
    expect(statusOf(awaitAgents({ nodes: [session(), helper({ waiting: { reason: 'reply', since: NOW } })], messages: [] }, NOW).nodes[0], NOW)).toBe('waiting')
    const asked = session({ waiting: { reason: 'question', since: NOW } })
    expect(statusOf(awaitAgents({ nodes: [asked, helper()], messages: [] }, NOW).nodes[0], NOW)).toBe('waiting')
  })
})

describe('waits', () => {
  const waiting = (minutes: number, reason: 'question' | 'reply' = 'reply') =>
    node({ kind: 'session', lastAt: NOW - minutes * MINUTE, waiting: { reason, since: NOW - minutes * MINUTE } })

  it('are fresh for their first two minutes, then rest', () => {
    expect(isFreshWait(waiting(1), NOW)).toBe(true)
    expect(isFreshWait(waiting(3), NOW)).toBe(false)
    expect(isFreshWait(node(), NOW)).toBe(false)
  })

  it('read the same in Your turn and on cards, and say who they wait on elsewhere', () => {
    expect(waitingLine(waiting(20), NOW)).toBe('Finished, 20 min ago')
    expect(waitingLine(waiting(7, 'question'), NOW)).toBe('Asked you a question, 7 min ago')
    expect(describeStatus(waiting(20), NOW)).toBe('Finished, waiting on you, 20 min ago')
  })
})

describe('token counts', () => {
  it('read as 689k and 3.1M tokens', () => {
    expect(formatTokens(689_400)).toBe('689k tokens')
    expect(formatTokens(3_140_000)).toBe('3.1M tokens')
    expect(formatTokens(900)).toBe('900 tokens')
  })
})

describe('waiting on background shells', () => {
  const NOW = Date.parse('2026-10-13T08:00:00Z')
  const base = { branch: null, home: 'app', room: 'app', repos: [], activity: null, lastTool: null, pendingTool: null, usage: {}, agentType: null, model: null, plans: [] }
  const lead = (fields: Partial<AgentNode>): AgentNode => ({ ...base, id: 'lead', kind: 'session', label: 'Lead', sessionId: 'lead', parentId: null, lastAt: NOW - 60_000, waiting: { reason: 'reply', since: NOW - 60_000 }, ...fields })

  it('keeps a session running while a shell it started in the background still runs', () => {
    const node = awaitAgents({ nodes: [lead({ background: [{ name: 'Bash', since: NOW - 5 * 60_000 }] })], messages: [] }, NOW).nodes[0]
    expect(statusOf(node, NOW)).toBe('running')
    expect(describeStatus(node, NOW)).toBe('Waiting on a shell')
  })

  it('shows a session gone quiet mid-turn while its subagents work as waiting on them, not as quiet', () => {
    const quiet = lead({ waiting: null, lastAt: NOW - 7 * 60_000 })
    const helper: AgentNode = { ...base, id: 'helper', kind: 'subagent', label: 'Helper', sessionId: 'lead', parentId: 'lead', lastAt: NOW - 10_000, waiting: null }
    const node = awaitAgents({ nodes: [quiet, helper], messages: [] }, NOW).nodes[0]
    expect(isQuiet(node, NOW)).toBe(false)
    expect(describeStatus(node, NOW)).toBe('Waiting on an agent')
  })

  it('stops waiting on a shell that never reported back after half an hour', () => {
    const node = awaitAgents({ nodes: [lead({ background: [{ name: 'Bash', since: NOW - 31 * 60_000 }] })], messages: [] }, NOW).nodes[0]
    expect(statusOf(node, NOW)).toBe('waiting')
  })
})

describe('a held-back question', () => {
  const NOW = Date.parse('2026-10-13T08:30:00Z')
  const base = { branch: null, home: 'app', room: 'app', repos: [], activity: null, lastTool: null, pendingTool: null, usage: {}, agentType: null, model: null, plans: [] }
  const session = (fields: Partial<AgentNode>): AgentNode => ({ ...base, id: 's', kind: 'session', label: 'Layout', sessionId: 's', parentId: null, waiting: null, lastAt: NOW - 7 * 60_000, owesReply: true, ...fields })

  it('reads a session silent right after a tool result as probably asking you a question', () => {
    const node = awaitAgents({ nodes: [session({})], messages: [] }, NOW).nodes[0]
    expect(statusOf(node, NOW)).toBe('waiting')
    expect(describeStatus(node, NOW)).toBe('Probably asking you a question, 7 min ago')
  })

  it('can be dismissed like any wait', () => {
    const asked = awaitAgents({ nodes: [session({})], messages: [] }, NOW)
    const node = applyDismissals(asked, { s: NOW - 7 * 60_000 }).nodes[0]
    expect(statusOf(node, NOW)).toBe('finished')
  })

  it('does not when the silence is short, a tool is still running, or the model spoke last', () => {
    for (const fields of [{ lastAt: NOW - 60_000 }, { pendingTool: { name: 'Bash', since: NOW - 7 * 60_000 } }, { owesReply: false }]) {
      expect(statusOf(awaitAgents({ nodes: [session(fields)], messages: [] }, NOW).nodes[0], NOW)).not.toBe('waiting')
    }
  })
})

describe("Claude Code's own status", () => {
  const session = (fields: Partial<AgentNode> = {}) => node({ id: 's', kind: 'session', sessionId: 's', ...fields })
  const settle = (...nodes: AgentNode[]) => awaitAgents({ nodes, messages: [] }, NOW).nodes
  const turnOver = { reason: 'reply' as const, since: NOW - 10 * MINUTE }

  it('waits on you for a permission prompt, even mid-turn, and says what it needs', () => {
    const [prompt] = settle(session({ live: { status: 'waiting', reason: 'permission', since: NOW - 2 * MINUTE } }))
    expect(statusOf(prompt, NOW)).toBe('waiting')
    expect(waitingLine(prompt, NOW)).toBe('Needs your permission, 2 min ago')
  })

  it('is busy after its turn ended while background agents run, even ones Orrery cannot see', () => {
    const [busy] = settle(session({ waiting: turnOver, live: { status: 'busy', since: NOW } }))
    expect(statusOf(busy, NOW)).toBe('running')
    expect(describeStatus(busy, NOW)).toBe('Waiting on its agents')
  })

  it('waits on a background shell, and on you once idle', () => {
    const [shell] = settle(session({ waiting: turnOver, live: { status: 'shell', since: NOW } }))
    expect(describeStatus(shell, NOW)).toBe('Waiting on a shell')
    const [idle] = settle(session({ lastAt: NOW - 30 * MINUTE, live: { status: 'idle', since: NOW - MINUTE } }))
    expect(statusOf(idle, NOW)).toBe('waiting')
  })

  it('is finished once its session is closed, subagents too, whatever the transcript says', () => {
    const [closed, child] = settle(session({ waiting: turnOver, live: { status: 'closed' } }), node({ id: 'c', sessionId: 's', live: { status: 'closed' } }))
    expect(statusOf(closed, NOW)).toBe('finished')
    expect(statusOf(child, NOW)).toBe('finished')
  })

  it('no longer guesses at a held-back question or an approval when the status is known', () => {
    const silent = { owesReply: true, lastAt: NOW - 10 * MINUTE, pendingTool: { name: 'Bash', since: NOW - 10 * MINUTE } }
    const [known] = settle(session({ ...silent, live: { status: 'busy', since: NOW } }))
    expect(describeStatus(known, NOW)).toBe('Bash has run for 10 min')
    const [guessed] = settle(session(silent))
    expect(describeStatus(guessed, NOW)).toBe('Bash has run for 10 min, may be waiting for your approval')
  })
})

describe('hiding finished agents', () => {
  it('drops them and their lines from the canvas, but keeps the selected one', () => {
    const done = node({ id: 'done', lastAt: NOW - 30 * MINUTE })
    const kept = node({ id: 'kept', lastAt: NOW - 30 * MINUTE })
    const busy = node({ id: 'busy' })
    const graph = { nodes: [done, kept, busy], messages: [{ from: 'busy', to: 'done', count: 1, lastAt: NOW }], collisions: [{ a: 'busy', b: 'kept', files: ['a.ts'], repo: null, at: NOW }] }
    const shown = withoutFinished(graph, NOW, 'kept')
    expect(shown.nodes.map(({ id }) => id)).toEqual(['kept', 'busy'])
    expect(shown.messages).toEqual([])
    expect(shown.collisions).toHaveLength(1)
  })

  it('can drop only the archived ones', () => {
    const archived = node({ id: 'archived', lastAt: NOW - 30 * MINUTE, archived: true })
    const done = node({ id: 'done', lastAt: NOW - 30 * MINUTE })
    const shown = withoutFinished({ nodes: [archived, done], messages: [] }, NOW, null, (n) => !!n.archived)
    expect(shown.nodes.map(({ id }) => id)).toEqual(['done'])
  })
})
