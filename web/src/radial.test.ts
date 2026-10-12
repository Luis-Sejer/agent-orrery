import { describe, expect, it } from 'vitest'

import type { FlowOptions } from './layout'
import { buildOrrery, ORB_CENTRE_Y, ORBIT_SIZE, turnsAt, type BackdropNode, type OrreryNode } from './radial'
import type { AgentNode, GraphSnapshot } from './types'

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
    pendingTool: null,
    usage: {},
    ...fields,
  }
}

const session = (id: string, fields: Partial<AgentNode> = {}) => agent(id, { kind: 'session', parentId: null, sessionId: id, ...fields })
const waitingOn = (fields: Partial<AgentNode> = {}) => ({ waiting: { reason: 'reply' as const, since: NOW }, lastAt: NOW, ...fields })
const finished = (id: string, fields: Partial<AgentNode> = {}) => agent(id, { waiting: { reason: 'reply', since: NOW - 30 * MINUTE }, ...fields })

function options(fields: Partial<FlowOptions> = {}): FlowOptions {
  return { now: NOW, selectedId: null, expandedRooms: new Set(), filter: 'all', onExpand: () => {}, onCollapse: () => {}, ...fields }
}

const graphOf = (nodes: AgentNode[]): GraphSnapshot => ({ nodes, messages: [] })

// Where a node's orb (or pile) centre sits, in polar coordinates around you.
function polarOf(nodes: OrreryNode[], id: string) {
  const node = nodes.find((candidate) => candidate.id === id)!
  const x = node.position.x + node.width! / 2
  const y = node.position.y + (node.type === 'orbit' ? ORB_CENTRE_Y : node.height! / 2)
  return { angle: Math.atan2(y, x), r: Math.hypot(x, y) }
}

const backdrop = (nodes: OrreryNode[]) => nodes.find((node): node is BackdropNode => node.type === 'backdrop')!

describe('buildOrrery', () => {
  it('puts what waits on you innermost, then what runs, then what finished', () => {
    const graph = graphOf([session('waits', waitingOn()), session('runs', { room: 'web' }), session('done', { room: 'docs', lastAt: NOW - 60 * MINUTE })])
    const { nodes } = buildOrrery(graph, options())
    const r = (id: string) => polarOf(nodes, id).r
    expect(r('waits')).toBeLessThan(r('runs'))
    expect(r('runs')).toBeLessThan(r('done'))
    expect(backdrop(nodes).data).toMatchObject({ waiting: 1 })
  })

  it('keeps an agent at its angle when its status changes', () => {
    const before = graphOf([session('lead'), agent('a'), agent('b'), agent('c')])
    const after = graphOf([session('lead', waitingOn()), agent('a'), finished('b'), agent('c')])
    for (const id of ['lead', 'b']) {
      const was = polarOf(buildOrrery(before, options()).nodes, id)
      const is = polarOf(buildOrrery(after, options()).nodes, id)
      expect(is.angle).toBeCloseTo(was.angle)
      expect(is.r).not.toBeCloseTo(was.r)
    }
  })

  it('gives each repository its own sector, in alphabetical order, with subagents beside their parent', () => {
    const graph = graphOf([session('w', { room: 'web' }), session('lead'), agent('helper'), session('d', { room: 'docs' })])
    const { nodes } = buildOrrery(graph, options())
    expect(backdrop(nodes).data.sectors.map((sector) => sector.name)).toEqual(['api', 'docs', 'web'])
    const angle = (id: string) => polarOf(nodes, id).angle
    expect(angle('lead')).toBeLessThan(angle('helper'))
    expect(angle('helper')).toBeLessThan(angle('d'))
  })

  it('folds finished agents into one pile on the outer ring, and unfolds it on request', () => {
    const graph = graphOf([session('lead'), finished('f1'), finished('f2'), finished('f3')])
    const folded = buildOrrery(graph, options()).nodes
    expect(folded.filter((node) => node.type === 'orbit').map((node) => node.id)).toEqual(['lead'])
    expect(folded.find((node) => node.type === 'fold')?.data).toMatchObject({ count: 3 })
    const open = buildOrrery(graph, options({ expandedRooms: new Set(['api']) })).nodes
    expect(open.filter((node) => node.type === 'orbit')).toHaveLength(4)
    expect(backdrop(open).data.sectors[0].foldable).toBe(true)
  })

  it('never moves anything when you select something, even an agent in a pile', () => {
    const graph = graphOf([session('lead'), agent('live', { room: 'web' }), finished('f1'), finished('f2'), finished('f3'), session('other', { room: 'web' })])
    const positions = (selectedId: string | null) => new Map(buildOrrery(graph, options({ selectedId })).nodes.map((node) => [node.id, node.position]))
    const unselected = positions(null)
    for (const selectedId of ['lead', 'live', 'f2']) {
      const selected = positions(selectedId)
      for (const [id, position] of unselected) expect(selected.get(id)).toEqual(position)
    }
    // The selected agent comes out of its pile and appears beside it.
    expect(positions('f2').has('f2')).toBe(true)
  })

  it('staggers crowded neighbours in and out', () => {
    const helpers = Array.from({ length: 30 }, (_, index) => agent(`h${index}`))
    const elsewhere = ['a', 'b', 'c', 'd', 'e', 'f'].map((room) => session(room, { room }))
    const { nodes } = buildOrrery(graphOf([session('lead'), ...helpers, ...elsewhere]), options())
    const radii = new Set(helpers.map((helper) => Math.round(polarOf(nodes, helper.id).r)))
    expect(radii.size).toBe(2)
  })

  it('gives every node a size, so the minimap and fit-to-view can draw it', () => {
    const { nodes } = buildOrrery(graphOf([session('lead'), agent('child')]), options())
    for (const node of nodes) expect(node.width && node.height).toBeTruthy()
    expect(nodes.find((node) => node.id === 'child')).toMatchObject(ORBIT_SIZE)
  })

  it('gives orbiting nodes a measured size and handles, so their edges stay drawn while they move', () => {
    const graph = graphOf([session('lead'), agent('child'), finished('f1'), finished('f2'), finished('f3')])
    const moving = buildOrrery(graph, options()).nodes.filter((node) => node.type === 'orbit' || node.type === 'fold')
    expect(moving.map((node) => node.type).sort()).toEqual(['fold', 'orbit', 'orbit'])
    for (const node of moving) {
      expect(node.measured).toEqual({ width: node.width, height: node.height })
      expect(node.handles?.map((handle) => handle.type).sort()).toEqual(['source', 'target'])
    }
  })

  it('gives each repository its own ring by repository, innermost the ones that need you', () => {
    const graph = graphOf([
      session('quiet', { room: 'alpha', home: 'alpha', lastAt: NOW - 30 * MINUTE }),
      session('busy', { room: 'beta', home: 'beta' }),
      session('asks', { room: 'gamma', home: 'gamma', ...waitingOn() }),
    ])
    const { nodes, polar } = buildOrrery(graph, options(), 'room')
    const rings = backdrop(nodes).data.rings
    expect(rings.map((ring) => ring.key)).toEqual(['room:gamma', 'room:beta', 'room:alpha'])
    expect(rings.map((ring) => ring.tone)).toEqual(['waiting', 'running', 'finished'])
    expect(rings[0].r).toBeLessThan(rings[1].r)
    expect(rings[0].lap).toBeLessThan(rings[1].lap)
    expect(polar.get('asks')?.ring).toBe('room:gamma')
  })

  it('shows the status rings when there is nothing to arrange by repository', () => {
    const rings = backdrop(buildOrrery(graphOf([]), options(), 'room').nodes).data.rings
    expect(rings.map((ring) => ring.key)).toEqual(['waiting', 'running', 'finished'])
  })

  it('turns the inner rings faster, and not at all at the start', () => {
    const { rings } = backdrop(buildOrrery(graphOf([session('lead')]), options()).nodes).data
    expect(turnsAt(rings, 0)).toEqual({ waiting: 0, running: 0, finished: 0 })
    const { waiting, running, finished } = turnsAt(rings, 60)
    expect(waiting).toBeGreaterThan(running)
    expect(running).toBeGreaterThan(finished)
  })
})
