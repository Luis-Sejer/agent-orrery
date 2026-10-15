import { describe, expect, it } from 'vitest'

import { describeModes, isPrUrl, modeChips, prLabel } from './modes'
import type { AgentNode, GraphSnapshot } from './types'
import { newComets } from './useComets'

const NOW = Date.parse('2026-10-12T12:00:00Z')

const agent = (id: string, fields: Partial<AgentNode> = {}): AgentNode => ({
  id,
  kind: 'session',
  label: id,
  branch: null,
  home: null,
  room: null,
  repos: [],
  activity: 'working',
  lastTool: null,
  lastAt: NOW,
  waiting: null,
  pendingTool: null,
  usage: {},
  agentType: null,
  model: null,
  sessionId: id,
  parentId: null,
  plans: [],
  ...fields,
})

const graph = (nodes: AgentNode[], collisions: GraphSnapshot['collisions'] = []): GraphSnapshot => ({ nodes, messages: [], collisions })

describe('comets', () => {
  it('fly only for news: a new wait, artifact, pull request or collision, never what was there at the start', () => {
    const first = newComets(null, graph([agent('a', { artifacts: [{ title: 't', url: 'https://claude.ai/artifact/abcdef', at: NOW }] })]), NOW)
    expect(first.comets).toEqual([])

    const pr = { number: 7, repo: 'acme/shop', url: 'https://github.com/acme/shop/pull/7', at: NOW }
    const next = graph(
      [
        agent('a', { artifacts: [{ title: 't', url: 'https://claude.ai/artifact/abcdef', at: NOW }], prs: [pr] }),
        agent('b', { waiting: { reason: 'reply', since: NOW }, activity: 'listening' }),
      ],
      [{ a: 'a', b: 'b', files: ['cart.ts'], repo: null, at: NOW }],
    )
    const second = newComets(first.seen, next, NOW)
    expect(second.comets.map(({ kind, agentId }) => `${kind}:${agentId}`).sort()).toEqual(['clash:a', 'clash:b', 'pr:a', 'wait:b'])
    // The same news isn't news twice.
    expect(newComets(second.seen, next, NOW).comets).toEqual([])
  })
})

describe('modes', () => {
  it('names the modes, leaves the default out, and flags bypass', () => {
    const node = agent('a', { modes: { permission: 'bypassPermissions', effort: 'high', fast: true } })
    expect(describeModes(node)).toEqual(['Bypass permissions', 'High effort', 'Fast mode'])
    expect(modeChips(node)).toEqual([
      { label: 'bypass', tone: 'warn' },
      { label: 'fast', tone: 'plain' },
    ])
    expect(modeChips(agent('b', { modes: { permission: 'default', effort: null, fast: false } }))).toEqual([])
  })

  it('links only GitHub pull requests', () => {
    expect(isPrUrl('https://github.com/acme/shop/pull/7')).toBe(true)
    expect(isPrUrl('https://github.com.evil.example/acme/shop/pull/7')).toBe(false)
    expect(isPrUrl('javascript:alert(1)//github.com/a/b/pull/1')).toBe(false)
    expect(prLabel({ number: 7, repo: 'acme/shop', url: '', at: 0 })).toBe('shop #7')
  })
})
