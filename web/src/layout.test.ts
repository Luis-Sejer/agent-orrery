import { describe, expect, it } from 'vitest'

import { buildFlow, relatedTo, type CardNode, type FlowOptions } from './layout'
import { statusOf } from './status'
import type { AgentNode, GraphSnapshot } from './types'
import { applyDismissals } from './useDismissed'

const NOW = Date.parse('2026-10-12T12:00:00Z')
const MINUTE = 60_000

function agent(id: string, fields: Partial<AgentNode> = {}): AgentNode {
  return {
    id,
    kind: 'subagent',
    label: id,
    branch: null,
    home: 'api',
    room: 'api',
    repos: [],
    activity: 'working',
    lastTool: 'Bash',
    lastAt: NOW - MINUTE,
    waiting: null,
    agentType: 'general-purpose',
    model: null,
    sessionId: 'lead',
    parentId: 'lead',
    plans: [],
    ...fields,
  }
}

const lead = agent('lead', { kind: 'session', parentId: null, sessionId: 'lead' })
const finished = (id: string, room = 'web') => agent(id, { room, waiting: { reason: 'reply', since: NOW - 30 * MINUTE } })

function graphOf(nodes: AgentNode[], messages: GraphSnapshot['messages'] = []): GraphSnapshot {
  return { nodes, messages }
}

function options(fields: Partial<FlowOptions> = {}): FlowOptions {
  return { now: NOW, selectedId: null, expandedRooms: new Set(), filter: 'all', search: '', onExpand: () => {}, ...fields }
}

const cards = (nodes: ReturnType<typeof buildFlow>['nodes']) => nodes.filter((node): node is CardNode => node.type === 'session' || node.type === 'agent')

describe('statusOf', () => {
  it('reads a session that ended its turn as waiting, and a subagent that did as finished', () => {
    expect(statusOf(agent('s', { kind: 'session', waiting: { reason: 'reply', since: NOW } }), NOW)).toBe('waiting')
    expect(statusOf(agent('a', { waiting: { reason: 'reply', since: NOW } }), NOW)).toBe('finished')
  })

  it('keeps an agent running through a long quiet tool call, then calls it finished', () => {
    expect(statusOf(agent('a', { lastAt: NOW - 10 * MINUTE }), NOW)).toBe('running')
    expect(statusOf(agent('a', { lastAt: NOW - 20 * MINUTE }), NOW)).toBe('finished')
  })
})

describe('relatedTo', () => {
  it('includes the parent, the children and anyone it messaged', () => {
    const graph = graphOf([lead, agent('child'), agent('other', { parentId: null, sessionId: 'x' }), agent('peer', { kind: 'peer', parentId: null, sessionId: null })], [
      { from: 'child', to: 'peer', count: 1, lastAt: NOW },
    ])
    expect([...relatedTo(graph, 'child')].sort()).toEqual(['child', 'lead', 'peer'])
    expect(relatedTo(graph, null).size).toBe(0)
  })
})

describe('buildFlow', () => {
  it('puts each agent in its own room and folds a pile of finished ones', () => {
    const graph = graphOf([lead, agent('live', { room: 'web' }), finished('done-1'), finished('done-2'), finished('done-3')])
    const { nodes } = buildFlow(graph, options())
    const rooms = nodes.filter((node) => node.type === 'room').map((node) => node.id)
    expect(rooms).toEqual(['room:api', 'room:web'])
    expect(cards(nodes).map((node) => node.id).sort()).toEqual(['lead', 'live'])
    expect(nodes.find((node) => node.type === 'fold')?.data).toMatchObject({ count: 3 })
  })

  it('unfolds a room on request, and shows finished agents related to the selection', () => {
    const graph = graphOf([lead, finished('done-1'), finished('done-2'), finished('done-3')])
    expect(cards(buildFlow(graph, options({ expandedRooms: new Set(['web']) })).nodes)).toHaveLength(4)
    expect(cards(buildFlow(graph, options({ selectedId: 'lead' })).nodes)).toHaveLength(4)
  })

  it('dims what is unrelated to the selection and lifts the selected edges', () => {
    const graph = graphOf([lead, agent('child'), agent('stranger', { parentId: null, sessionId: 'x' })])
    const { nodes, edges } = buildFlow(graph, options({ selectedId: 'child' }))
    const byId = new Map(cards(nodes).map((node) => [node.id, node]))
    expect(byId.get('stranger')?.data.dimmed).toBe(true)
    expect(byId.get('lead')?.data.dimmed).toBe(false)
    const litEdge = edges.find((edge) => edge.target === 'child')
    expect(litEdge?.className).toContain('lit')
    expect(byId.get('child')!.zIndex!).toBeGreaterThan(litEdge!.zIndex!)
    expect(litEdge!.zIndex!).toBeGreaterThan(byId.get('lead')!.zIndex!)
  })

  it('gives every node a size, so the minimap can draw it', () => {
    const { nodes } = buildFlow(graphOf([lead, agent('child')]), options())
    for (const node of nodes) expect(node.width && node.height).toBeTruthy()
  })
})

describe('applyDismissals', () => {
  const waiting = agent('s', { kind: 'session', waiting: { reason: 'reply', since: NOW }, lastAt: NOW })

  it('stops a dismissed session waiting on you', () => {
    const [node] = applyDismissals(graphOf([waiting]), { s: NOW }).nodes
    expect(statusOf(node, NOW)).toBe('finished')
  })

  it('brings it back once it does something new', () => {
    const [node] = applyDismissals(graphOf([{ ...waiting, lastAt: NOW + MINUTE }]), { s: NOW }).nodes
    expect(statusOf(node, NOW)).toBe('waiting')
  })
})
