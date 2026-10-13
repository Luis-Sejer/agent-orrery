import { describe, expect, it } from 'vitest'

import type { FlowOptions } from './layout'
import { buildOrrery, ORB_CENTRE_Y, ORBIT_SIZE, turnsAt, type BackdropNode, type OrreryNode, type System } from './radial'
import { phaseOf } from './rhythm'
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
    expect(folded.find((node) => node.type === 'pile')?.data).toMatchObject({ count: 3 })
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
    const moving = buildOrrery(graph, options()).nodes.filter((node) => node.type === 'orbit' || node.type === 'pile')
    expect(moving.map((node) => node.type).sort()).toEqual(['orbit', 'orbit', 'pile'])
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

  it('draws a pile as one orb-sized slot that overlaps nothing, in both arrangements', () => {
    const graph = graphOf([session('lead'), agent('child'), agent('other'), finished('f1'), finished('f2'), finished('f3')])
    for (const arrangement of ['status', 'room', 'galaxy'] as const) {
      const placed = buildOrrery(graph, options(), arrangement).nodes.filter((node) => node.type !== 'backdrop')
      expect(placed.find((node) => node.type === 'pile')).toMatchObject(ORBIT_SIZE)
      const centres = placed.map((node) => [node.position.x + node.width! / 2, node.position.y + node.height! / 2])
      for (const [i, [x1, y1]] of centres.entries()) {
        for (const [x2, y2] of centres.slice(i + 1)) expect(Math.hypot(x2 - x1, y2 - y1)).toBeGreaterThanOrEqual(ORBIT_SIZE.width)
      }
    }
  })

  it('turns the inner rings faster, and not at all at the start', () => {
    const { rings } = backdrop(buildOrrery(graphOf([session('lead')]), options()).nodes).data
    expect(turnsAt(rings, 0)).toEqual({ waiting: 0, running: 0, finished: 0 })
    const { waiting, running, finished } = turnsAt(rings, 60)
    expect(waiting).toBeGreaterThan(running)
    expect(running).toBeGreaterThan(finished)
  })

  it('shows the status rings when there is nothing to arrange by repository', () => {
    const rings = backdrop(buildOrrery(graphOf([]), options(), 'room').nodes).data.rings
    expect(rings.map((ring) => ring.key)).toEqual(['waiting', 'running', 'finished'])
  })
})

const systemsOf = (graph: GraphSnapshot, fields: Partial<FlowOptions> = {}) =>
  new Map(backdrop(buildOrrery(graph, options(fields), 'galaxy').nodes).data.systems.map((system) => [system.name, system]))
const distance = ({ cx, cy }: System) => Math.hypot(cx, cy)
const angleOf = ({ cx, cy }: System) => Math.atan2(cy, cx)
const sameAngle = (a: number, b: number) => expect(Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))).toBeLessThan(1e-6)
// A repository with a session and some helpers: waiting, running or finished.
function repository(name: string, helpers: number, state: 'waiting' | 'running' | 'finished'): AgentNode[] {
  const fields = { room: name, home: name, ...(state === 'waiting' ? waitingOn() : state === 'finished' ? { lastAt: NOW - 60 * MINUTE } : {}) }
  const helperFields = { room: name, home: name, sessionId: `${name}-lead`, parentId: `${name}-lead`, ...(state === 'finished' ? { lastAt: NOW - 60 * MINUTE } : {}) }
  return [session(`${name}-lead`, fields), ...Array.from({ length: helpers }, (_, index) => agent(`${name}-${index}`, helperFields))]
}

describe('buildOrrery as a galaxy', () => {
  it('puts the systems that wait on you innermost, then the running ones, then the idle ones', () => {
    const systems = systemsOf(graphOf([...repository('alpha', 2, 'finished'), ...repository('beta', 1, 'running'), ...repository('gamma', 0, 'waiting')]))
    expect(systems.get('gamma')).toMatchObject({ tone: 'waiting', waiting: 1 })
    expect(systems.get('beta')).toMatchObject({ tone: 'running', running: 2 })
    expect(systems.get('alpha')).toMatchObject({ tone: 'finished', finished: 3 })
    expect(distance(systems.get('gamma')!)).toBeLessThan(distance(systems.get('beta')!))
    expect(distance(systems.get('beta')!)).toBeLessThan(distance(systems.get('alpha')!))
  })

  it('never lets two systems overlap, or one cover you, however many there are and whatever their size', () => {
    const states = ['waiting', 'running', 'running', 'finished'] as const
    const graph = graphOf(Array.from({ length: 18 }, (_, index) => repository(`repo-${index}`, (index * 7) % 30, states[index % states.length])).flat())
    const systems = [...systemsOf(graph).values()]
    expect(systems).toHaveLength(18)
    expect(new Set(systems.map((system) => Math.round(system.reach))).size).toBeGreaterThan(3)
    for (const [index, a] of systems.entries()) {
      expect(distance(a) - a.reach).toBeGreaterThan(166)
      for (const b of systems.slice(index + 1)) expect(Math.hypot(a.cx - b.cx, a.cy - b.cy)).toBeGreaterThanOrEqual(a.reach + b.reach)
    }
  })

  it("keeps a system at the angle its name gives it, while other systems change and as it moves between lanes", () => {
    const calm = graphOf([...repository('beta', 0, 'running'), ...repository('alpha', 2, 'finished'), ...repository('gamma', 0, 'waiting')])
    const busier = graphOf([...repository('beta', 0, 'waiting'), ...repository('alpha', 5, 'running'), ...repository('gamma', 0, 'waiting')])
    const before = systemsOf(calm).get('beta')!
    const after = systemsOf(busier).get('beta')!
    sameAngle(angleOf(before), -Math.PI / 2 + 2 * Math.PI * phaseOf('beta'))
    sameAngle(angleOf(after), angleOf(before))
    expect(distance(after)).toBeLessThan(distance(before))
  })

  it('grows a busy system, and turns its inner rings faster', () => {
    const graph = graphOf([...repository('small', 1, 'running'), ...repository('busy', 24, 'running'), session('asks', { room: 'busy', home: 'busy', ...waitingOn() })])
    const systems = systemsOf(graph)
    expect(systems.get('busy')!.r).toBeGreaterThan(systems.get('small')!.r)
    const rings = backdrop(buildOrrery(graph, options(), 'galaxy').nodes).data.rings.filter((ring) => ring.system === 'busy')
    expect(rings.map((ring) => ring.tone)).toEqual(['waiting', 'running'])
    expect(rings[0].r).toBeLessThan(rings[1].r)
    expect(rings[0].lap).toBeLessThan(rings[1].lap)
  })

  it('never moves anything when you select something', () => {
    const graph = graphOf([...repository('alpha', 2, 'running'), ...repository('beta', 4, 'finished'), ...repository('gamma', 1, 'waiting')])
    const positions = (selectedId: string | null) => new Map(buildOrrery(graph, options({ selectedId }), 'galaxy').nodes.map((node) => [node.id, node.position]))
    const unselected = positions(null)
    for (const selectedId of ['alpha-lead', 'gamma-0', 'beta-2']) {
      const selected = positions(selectedId)
      for (const [id, position] of unselected) expect(selected.get(id)).toEqual(position)
    }
  })

  it("puts a monorepo's areas in one system, as sectors named by area, and a worktree's room in a system of its own", () => {
    const graph = graphOf([
      session('web', { room: 'shop › apps/web' }),
      session('api', { room: 'shop › apps/api', ...waitingOn() }),
      session('root', { room: 'shop' }),
      session('branch', { room: 'shop ⎇ feat/x › apps/web' }),
      session('notes', { room: 'docs' }),
    ])
    const { nodes, polar } = buildOrrery(graph, options(), 'galaxy')
    const { systems, sectors } = backdrop(nodes).data
    expect(systems.map((system) => system.name).sort()).toEqual(['docs', 'shop', 'shop ⎇ feat/x'])
    const centre = (id: string) => [polar.get(id)?.cx, polar.get(id)?.cy]
    expect(centre('web')).toEqual(centre('api'))
    expect(centre('web')).toEqual(centre('root'))
    expect(centre('web')).not.toEqual(centre('branch'))
    expect(sectors.filter((sector) => sector.system === 'shop').map((sector) => sector.label)).toEqual(['root', 'apps/api', 'apps/web'])
    expect(sectors.find((sector) => sector.system === 'docs')?.label).toBeNull()
    expect(systems.find((system) => system.name === 'shop')).toMatchObject({ waiting: 1, running: 2, tone: 'waiting' })
  })
})
