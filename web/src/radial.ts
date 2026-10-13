import type { CSSProperties } from 'react'
import { Position, type Edge, type Node, type NodeHandle } from '@xyflow/react'

import {
  buildEdges,
  foldId,
  groupIntoRooms,
  matches,
  relatedTo,
  Z_CARD,
  Z_FOCUSED,
  Z_RELATED,
  Z_ROOM,
  type CardData,
  type FlowOptions,
  type FoldData,
} from './layout'
import { phaseOf } from './rhythm'
import { AREA_SEPARATOR, repositoryOf } from './rooms'
import { statusOf } from './status'
import type { AgentNode, GraphSnapshot, Status } from './types'

// The orrery: you at the centre, agents further out the less they need you. Arranged by status, the rings
// are waiting, running and finished, with a sector per repository. Arranged by repository, each repository
// gets a ring of its own, and the rooms that need you most sit innermost. As a galaxy, each repository is
// a small solar system with status rings of its own, and the systems that need you most sit innermost.
// An orbit node's box is just its orb; the name hangs outside it, pointing away from the centre.
export const ORBIT_SIZE = { width: 56, height: 56 }
export const ORB_CENTRE_Y = ORBIT_SIZE.height / 2
const HANDLE_PX = 6

// The orbit hands React Flow new node objects about 30 times a second. A node without a size
// is re-measured, and its edges are dropped until then, so they flicker; the size and the
// handles (centred, as the stylesheet draws them) are given up front instead.
function fixedFrame(size: { width: number; height: number }, source: Position, target: Position) {
  const box = { x: size.width / 2 - HANDLE_PX / 2, y: size.height / 2 - HANDLE_PX / 2, width: HANDLE_PX, height: HANDLE_PX }
  const handles: NodeHandle[] = [
    { ...box, type: 'source', position: source },
    { ...box, type: 'target', position: target },
  ]
  return { measured: size, handles }
}
// The inner ring clears the core (its constellation reaches 131 px, its dial and caption about 190 px),
// even for an orb staggered inwards.
const RINGS: Record<Status, number> = { waiting: 255, running: 375, finished: 495 }
// Seconds per lap: like a real orrery, the inner rings turn faster.
const LAP_SECONDS: Record<Status, number> = { waiting: 240, running: 360, finished: 540 }
const RING_ORDER: Status[] = ['waiting', 'running', 'finished']
const RING_LABELS: Record<Status, string> = { waiting: 'Waiting on you', running: 'Running', finished: 'Finished' }
// By repository: room rings start where the waiting ring would, at least this far apart, and turn
// like planets do (Kepler: a lap takes longer in proportion to the radius to the power 1.5).
const ROOM_RING_GAP = 120
const KEPLER = 1.5
const URGENCY: Record<Status, number> = { waiting: 0, running: 1, finished: 2 }
// Average arc each agent gets on the running ring; with more agents than fit, every ring grows.
const SLOT_ARC = 72
// An empty wedge at the top carries the ring labels; sectors start after it, clockwise.
const LABEL_GAP = 0.75
const SECTOR_GAP = 0.06
const MIN_SECTOR_SLOTS = 3
// Neighbours on a ring closer than this along the arc take turns sitting in and out.
const STAGGER_ARC = 84
const STAGGER = 36
// A selected finished agent comes out of its pile and sits just beyond it, so nothing else moves.
const POPPED_OUT = 76
const ROOM_LABEL_OFFSET = 64
// Agents' names run sideways, so room names sit further out at the sides to clear them.
export const ROOM_LABEL_SIDE_REACH = 110
// Room for most room names, which reach outwards from their anchor; wide screens have more at the sides.
const BACKDROP_MARGIN = 160
const TOP = -Math.PI / 2
const BOTTOM = Math.PI / 2
// Galaxy: a system's inner ring clears its sun's glow, and grows so that no two of its orbs sit closer
// than SYSTEM_SLOT_ARC along any ring. Inner rings turn faster, as in the orrery.
const SYSTEM_INNER = 76
const SYSTEM_RING_GAP = 66
const SYSTEM_SLOT_ARC = 58
const SYSTEM_LAPS = [240, 360, 540]
// Room beyond a system's outer ring for its area labels and the names hanging off its orbs.
const SYSTEM_MARGIN = 64
const SYSTEM_GAP = 24
const AREA_LABEL_OFFSET = 34
// A monorepo's name hangs below the area labels at the bottom of its rings.
const AREA_LABEL_CLEARANCE = 20
// The innermost lane clears the core's dial and caption; each lane after it is at least LANE_STEP
// further out, and moves out by LANE_GROWTH until its systems clear every system inside it.
const CORE_CLEARANCE = 200
const LANE_STEP = 150
const LANE_GROWTH = 12
// Lanes start roomier than a tight fit, so nudging systems apart settles in a few rounds.
const LANE_SLACK = 0.8
const NUDGE_ROUNDS = 400
const NUDGE_EPSILON = 1e-9
const GALAXY_MARGIN = 60
const ROOT_AREA = 'root'

export type Arrangement = 'status' | 'room' | 'galaxy'
export type OrbitNode = Node<CardData, 'orbit'>
// A room's finished agents, folded into one orb-sized pile, so it takes one slot like an agent.
export type PileNode = Node<FoldData, 'pile'>
// A ring: its key (a status, or a room's name), its label along the top when it has one, and the most
// urgent status on it, which colours it.
// In a galaxy a ring circles its system's sun instead of you.
export type Ring = { key: string; label: string | null; r: number; lap: number; tone: Status; system?: string }
// A room's name and its "Hide finished" button. By status it marks a sector, turning with the outer
// ring; by repository it rides its own ring. In a galaxy it is a monorepo's area, turning with its
// system's outer ring, and labelled with the area alone.
export type Sector = { name: string; start: number; mid: number; foldable: boolean; ring: string; r: number; system?: string; label?: string | null }
// A repository's solar system in a galaxy: where its sun sits, its outer ring, how far below the sun
// its name hangs, how far it reaches with names and labels, and what its agents are doing.
export type System = { name: string; cx: number; cy: number; r: number; drop: number; reach: number; tone: Status; waiting: number; running: number; finished: number }
// A faint galactic ring that systems of one urgency sit on.
export type Lane = { r: number; tone: Status }
export type Turns = Record<string, number>
export type Box = { x: number; y: number; width: number; height: number }
export type BackdropData = {
  arrangement: Arrangement
  // What the backdrop spans, with you at (0, 0): a square around the rings, or a galaxy's extent.
  box: Box
  rings: Ring[]
  sectors: Sector[]
  systems: System[]
  lanes: Lane[]
  // How far each ring has turned, by key.
  turns: Turns
  waiting: number
  onCollapse: (room: string) => void
}
export type BackdropNode = Node<BackdropData, 'backdrop'>
export type OrreryNode = OrbitNode | PileNode | BackdropNode
// Where a node sits before the rings turn, and which ring carries it. In a galaxy the angle and
// radius are around its system's sun at (cx, cy), not around you.
export type Polar = { angle: number; r: number; ring: string; cx?: number; cy?: number }

export const turnsAt = (rings: Ring[], seconds: number): Turns =>
  Object.fromEntries(rings.map((ring) => [ring.key, (2 * Math.PI * seconds) / ring.lap]))

// Centres a node's box on a point; its label reads the direction away from the centre.
export function placeAt<T extends OrreryNode>(node: T, angle: number, r: number, cx = 0, cy = 0): T {
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)]
  return { ...node, position: { x: cx + cos * r - node.width! / 2, y: cy + sin * r - node.height! / 2 }, style: { '--cos': cos, '--sin': sin } as CSSProperties }
}

interface Slot {
  id: string
  angle: number
  ring: string
  offset: number
  system?: string
}

// Parents first, each followed by its subagents, so a session's helpers sit beside it. Ordered by
// things that rarely change (never by status), so an agent keeps its angle as it moves between rings.
function treeOrder(members: AgentNode[]): AgentNode[] {
  const ids = new Set(members.map((node) => node.id))
  const byLabel = (a: AgentNode, b: AgentNode) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)
  const children = new Map<string, AgentNode[]>()
  const roots: AgentNode[] = []
  for (const node of members) {
    if (node.parentId && ids.has(node.parentId)) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node])
    else roots.push(node)
  }
  // Sessions first; helpers whose session works elsewhere stay together, grouped by that session.
  roots.sort((a, b) => Number(b.kind === 'session') - Number(a.kind === 'session') || (a.parentId ?? '').localeCompare(b.parentId ?? '') || byLabel(a, b))
  const ordered: AgentNode[] = []
  const visit = (node: AgentNode) => {
    ordered.push(node)
    for (const child of (children.get(node.id) ?? []).sort(byLabel)) visit(child)
  }
  roots.forEach(visit)
  return ordered
}

// Alternate neighbours in and out wherever a ring gets crowded.
function stagger(slots: Slot[], rings: Ring[]) {
  for (const { key, r } of rings) {
    const onRing = slots.filter((slot) => slot.ring === key).sort((a, b) => a.angle - b.angle)
    const close = (a?: Slot, b?: Slot) => !!a && !!b && (b.angle - a.angle) * r < STAGGER_ARC
    let run = 0
    onRing.forEach((slot, index) => {
      const crowded = close(onRing[index - 1], slot) || close(slot, onRing[index + 1])
      run = close(onRing[index - 1], slot) ? run + 1 : 0
      slot.offset = crowded ? (run % 2 === 0 ? -STAGGER : STAGGER) : 0
    })
  }
}

type Room = ReturnType<typeof groupIntoRooms>[number]
type Planned = { room: Room; members: AgentNode[]; ids: string[] }
type Plan = { slots: Slot[]; rings: Ring[]; sectors: Sector[]; systems?: System[]; lanes?: Lane[] }
type Share = { room: Room; ids: string[]; start: number; span: number }

// The status of each slot: an agent's own, and finished for a pile.
const statusIn = (nodesById: Map<string, AgentNode>, now: number) => (id: string): Status => {
  const node = nodesById.get(id)
  return node ? statusOf(node, now) : 'finished'
}

// Three rings by status, and a sector per room around them.
function byStatus(planned: Planned[], status: (id: string) => Status): Plan {
  const totalSlots = planned.reduce((sum, { ids }) => sum + ids.length, 0)
  const scale = Math.max(1, (totalSlots * SLOT_ARC) / (2 * Math.PI * RINGS.running))
  const rings: Ring[] = RING_ORDER.map((key) => ({ key, label: RING_LABELS[key], r: RINGS[key] * scale, lap: LAP_SECONDS[key], tone: key }))
  const outer = rings[rings.length - 1]
  const shares = shareOut(planned, TOP + LABEL_GAP / 2, 2 * Math.PI - LABEL_GAP)
  const slots = shares.flatMap((share) => slotsOf(share).map(({ id, angle }) => ({ id, angle, ring: status(id), offset: 0 })))
  const sectors = shares.map(({ room, start, span }) => ({ name: room.name, start, mid: start + span / 2, foldable: room.foldable, ring: outer.key, r: outer.r + ROOM_LABEL_OFFSET }))
  stagger(slots, rings)
  return { slots, rings, sectors }
}

// Shares a sweep between rooms in proportion to their slots, with a gap between rooms.
function shareOut(planned: Planned[], from: number, sweep: number): Share[] {
  const weights = planned.map(({ ids }) => Math.max(MIN_SECTOR_SLOTS, ids.length))
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0)
  const usable = sweep - SECTOR_GAP * Math.max(0, planned.length - 1)
  let start = from
  return planned.map(({ room, ids }, index) => {
    const span = (usable * weights[index]) / weightSum
    const share = { room, ids, start, span }
    start += span + SECTOR_GAP
    return share
  })
}

// A room's slots, spread evenly across its share.
const slotsOf = ({ ids, start, span }: Share) => ids.map((id, slot) => ({ id, angle: start + ((slot + 0.5) * span) / ids.length }))

// A ring per room, the rooms that need you most innermost. Each ring is wide enough for its agents,
// and its name rides the gap at the top.
function byRoom(planned: Planned[], status: (id: string) => Status): Plan {
  const urgency = (ids: string[]) => Math.min(...ids.map((id) => URGENCY[status(id)]))
  const ordered = [...planned].sort((a, b) => urgency(a.ids) - urgency(b.ids) || a.room.name.localeCompare(b.room.name))
  const sweep = 2 * Math.PI - LABEL_GAP
  const slots: Slot[] = []
  const rings: Ring[] = []
  const sectors: Sector[] = []
  let r = RINGS.waiting - ROOM_RING_GAP
  for (const { room, ids } of ordered) {
    r = Math.max(r + ROOM_RING_GAP, (ids.length * SLOT_ARC) / sweep)
    const key = `room:${room.name}`
    // Each ring starts at its own angle, kept from its name, so rings with one agent each don't
    // line up in a column, and their names spread around the orrery.
    const gapAt = TOP + 2 * Math.PI * phaseOf(key)
    rings.push({ key, label: null, r, lap: LAP_SECONDS.waiting * (r / RINGS.waiting) ** KEPLER, tone: RING_ORDER[urgency(ids)] })
    ids.forEach((id, slot) => slots.push({ id, angle: gapAt + LABEL_GAP / 2 + ((slot + 0.5) * sweep) / ids.length, ring: key, offset: 0 }))
    sectors.push({ name: room.name, start: gapAt, mid: gapAt, foldable: room.foldable, ring: key, r })
  }
  stagger(slots, rings)
  return { slots, rings, sectors }
}

type Solar = { system: System; urgency: number; slots: Slot[]; rings: Ring[]; sectors: Sector[] }

// One repository's system: its rooms (a monorepo's areas) as sectors around its sun, and its agents
// on status rings, waiting innermost. The rings grow until no two orbs crowd each other, so a busy
// system is bigger. Its place in the galaxy is set later.
function planSystem(name: string, planned: Planned[], status: (id: string) => Status): Solar {
  const areas = planned.length > 1
  // Slots start from the bottom, below which the system's name hangs, so a lone agent and its name sit
  // opposite it. A gap follows every area, the last one included, as they go all the way round.
  const shares = shareOut(planned, BOTTOM + (areas ? SECTOR_GAP / 2 : 0), 2 * Math.PI - (areas ? SECTOR_GAP : 0))
  const pitch = Math.min(...shares.map(({ ids, span }) => span / ids.length))
  const inner = Math.max(SYSTEM_INNER, SYSTEM_SLOT_ARC / pitch)
  const present = new Set(planned.flatMap(({ ids }) => ids.map(status)))
  const rings: Ring[] = RING_ORDER.filter((tone) => present.has(tone)).map((tone, index) => ({
    key: `system:${name}:${tone}`,
    label: null,
    r: inner + index * SYSTEM_RING_GAP,
    lap: SYSTEM_LAPS[index],
    tone,
    system: name,
  }))
  const outer = rings[rings.length - 1]
  const ringOf = new Map(rings.map((ring) => [ring.tone, ring.key]))
  const slots = shares.flatMap((share) => slotsOf(share).map(({ id, angle }) => ({ id, angle, ring: ringOf.get(status(id))!, offset: 0, system: name })))
  const sectors = shares.map(({ room, start, span }) => ({
    name: room.name,
    start,
    mid: start + span / 2,
    foldable: room.foldable,
    ring: outer.key,
    r: outer.r + AREA_LABEL_OFFSET,
    system: name,
    label: areas ? room.name.slice(name.length + AREA_SEPARATOR.length) || ROOT_AREA : null,
  }))
  const members = planned.flatMap(({ room }) => [...room.sessions, ...room.agents, ...room.folded])
  const count = (tone: Status) => members.filter((node) => status(node.id) === tone).length
  const urgency = Math.min(...rings.map((ring) => URGENCY[ring.tone]))
  const drop = outer.r + (areas ? AREA_LABEL_OFFSET + AREA_LABEL_CLEARANCE : 0)
  const system = { name, cx: 0, cy: 0, r: outer.r, drop, reach: outer.r + SYSTEM_MARGIN, tone: RING_ORDER[urgency], waiting: count('waiting'), running: count('running'), finished: count('finished') }
  return { system, urgency, slots, rings, sectors }
}

// Each system at the angle its name gives it, pushed apart only as far as it must be to clear its
// neighbours on a lane of this radius. Null when they can't all fit.
function spreadOnLane(systems: Pick<System, 'name' | 'reach'>[], r: number): Map<string, number> | null {
  const items = systems.map(({ name, reach }) => ({ name, reach, angle: TOP + 2 * Math.PI * phaseOf(name) })).sort((a, b) => a.angle - b.angle)
  const need = (a: { reach: number }, b: { reach: number }) => {
    const chord = (a.reach + b.reach + SYSTEM_GAP) / (2 * r)
    return chord >= 1 ? Infinity : 2 * Math.asin(chord)
  }
  const needed = items.reduce((sum, item, index) => sum + (items.length > 1 ? need(item, items[(index + 1) % items.length]) : 0), 0)
  if (needed > 2 * Math.PI) return null
  for (let round = 0; round < NUDGE_ROUNDS; round++) {
    let moved = false
    items.forEach((a, index) => {
      if (items.length < 2) return
      const b = items[(index + 1) % items.length]
      const gap = b.angle - a.angle + (index === items.length - 1 ? 2 * Math.PI : 0)
      const deficit = need(a, b) - gap
      if (deficit <= NUDGE_EPSILON) return
      a.angle -= deficit / 2
      b.angle += deficit / 2
      moved = true
    })
    if (!moved) return new Map(items.map(({ name, angle }) => [name, angle]))
  }
  return null
}

const clear = (a: System, b: System) => Math.hypot(a.cx - b.cx, a.cy - b.cy) >= a.reach + b.reach + SYSTEM_GAP

// Puts a lane's systems at their angles on a lane of this radius, if they fit there.
function settle(onLane: System[], r: number, placed: System[]): boolean {
  const angles = spreadOnLane(onLane, r)
  if (!angles) return false
  for (const system of onLane) {
    const angle = angles.get(system.name)!
    system.cx = Math.cos(angle) * r
    system.cy = Math.sin(angle) * r
  }
  return onLane.every((system) => placed.every((other) => clear(system, other)))
}

// Systems on galactic lanes by urgency: waiting innermost, then running, then idle. A lane moves out
// until its systems fit around it and clear every system already placed, so no two systems meet,
// yet a lane can tuck in where the lane inside it has a gap.
function placeSystems(solars: Solar[]): Lane[] {
  const lanes: Lane[] = []
  const placed: System[] = []
  for (const urgency of RING_ORDER.map((tone) => URGENCY[tone])) {
    const onLane = solars.filter((solar) => solar.urgency === urgency).map(({ system }) => system)
    if (onLane.length === 0) continue
    const widest = Math.max(...onLane.map(({ reach }) => reach))
    const around = onLane.reduce((sum, { reach }) => sum + 2 * reach + SYSTEM_GAP, 0)
    let r = Math.max(CORE_CLEARANCE + widest, (lanes.at(-1)?.r ?? 0) + LANE_STEP, around / (2 * Math.PI * LANE_SLACK))
    while (!settle(onLane, r, placed)) r += LANE_GROWTH
    placed.push(...onLane)
    lanes.push({ r, tone: RING_ORDER[urgency] })
  }
  return lanes
}

// A solar system per repository, a monorepo's areas sharing theirs, around you.
function byGalaxy(planned: Planned[], status: (id: string) => Status): Plan {
  const byRepository = new Map<string, Planned[]>()
  for (const entry of planned) {
    const name = repositoryOf(entry.room.name)
    byRepository.set(name, [...(byRepository.get(name) ?? []), entry])
  }
  const solars = [...byRepository].map(([name, members]) => planSystem(name, members, status))
  const lanes = placeSystems(solars)
  return {
    slots: solars.flatMap((solar) => solar.slots),
    rings: solars.flatMap((solar) => solar.rings),
    sectors: solars.flatMap((solar) => solar.sectors),
    systems: solars.map((solar) => solar.system),
    lanes,
  }
}

// Every system with its names, and you, so fitting the view fills it with the galaxy rather than its empty lanes.
function galaxyBox(systems: System[]): Box {
  const x = Math.min(-CORE_CLEARANCE, ...systems.map(({ cx, reach }) => cx - reach)) - GALAXY_MARGIN
  const y = Math.min(-CORE_CLEARANCE, ...systems.map(({ cy, reach }) => cy - reach)) - GALAXY_MARGIN
  const right = Math.max(CORE_CLEARANCE, ...systems.map(({ cx, reach }) => cx + reach)) + GALAXY_MARGIN
  const bottom = Math.max(CORE_CLEARANCE, ...systems.map(({ cy, reach }) => cy + reach)) + GALAXY_MARGIN
  return { x, y, width: right - x, height: bottom - y }
}

const ARRANGE: Record<Arrangement, (planned: Planned[], status: (id: string) => Status) => Plan> = { status: byStatus, room: byRoom, galaxy: byGalaxy }

export function buildOrrery(
  graph: GraphSnapshot,
  options: FlowOptions,
  arrangement: Arrangement = 'status',
): { nodes: OrreryNode[]; edges: Edge[]; polar: Map<string, Polar> } {
  const { now, selectedId } = options
  const related = relatedTo(graph, selectedId)
  const isDimmed = (node: AgentNode) => (selectedId !== null && !related.has(node.id)) || !matches(node, options.filter, now)
  // Grouped as if nothing were selected, so selecting can never move anything.
  const rooms = groupIntoRooms(graph, { ...options, selectedId: null }).sort((a, b) => a.name.localeCompare(b.name))
  const planned = rooms.map((room) => {
    const members = treeOrder([...room.sessions, ...room.agents])
    const ids = members.map((node) => node.id)
    if (room.folded.length > 0) ids.push(foldId(room.name))
    return { room, members, ids }
  })
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]))
  const status = statusIn(nodesById, now)
  // With no rooms yet there are no room rings or systems, so an empty orrery shows the status rings.
  const { slots, rings, sectors, systems = [], lanes = [] } = (planned.length > 0 ? ARRANGE[arrangement] : byStatus)(planned, status)
  const radiusOf = new Map(rings.map((ring) => [ring.key, ring.r]))
  const centreOf = new Map(systems.map(({ name, cx, cy }) => [name, { cx, cy }]))

  const radius = rings[rings.length - 1].r + ROOM_LABEL_OFFSET + BACKDROP_MARGIN
  const box = systems.length > 0 ? galaxyBox(systems) : { x: -radius, y: -radius, width: radius * 2, height: radius * 2 }
  const waiting = graph.nodes.filter((node) => statusOf(node, now) === 'waiting').length
  const nodes: OrreryNode[] = [
    {
      id: 'orrery:backdrop',
      type: 'backdrop',
      position: { x: box.x, y: box.y },
      width: box.width,
      height: box.height,
      zIndex: Z_ROOM,
      selectable: false,
      focusable: false,
      data: {
        arrangement,
        box,
        rings,
        sectors,
        systems,
        lanes,
        turns: turnsAt(rings, 0),
        waiting,
        onCollapse: options.onCollapse,
      },
    },
  ]

  const polars = new Map<string, Polar>()
  const orbit = (node: AgentNode, at: Polar): OrbitNode => {
    const focused = node.id === selectedId
    polars.set(node.id, at)
    return placeAt({
      id: node.id,
      type: 'orbit',
      position: { x: 0, y: 0 },
      ...ORBIT_SIZE,
      ...fixedFrame(ORBIT_SIZE, Position.Top, Position.Top),
      className: 'orrery-node',
      zIndex: focused ? Z_FOCUSED : related.has(node.id) ? Z_RELATED : Z_CARD,
      data: { node, now, dimmed: isDimmed(node), focused, related: related.has(node.id), alsoIn: [] },
    } satisfies OrbitNode, at.angle, at.r, at.cx, at.cy)
  }

  const foldedInto = new Map<string, string>()
  const roomsByFold = new Map(rooms.map((room) => [foldId(room.name), room]))
  for (const slot of slots) {
    const at: Polar = { angle: slot.angle, r: radiusOf.get(slot.ring)! + slot.offset, ring: slot.ring, ...(slot.system && centreOf.get(slot.system)) }
    const node = nodesById.get(slot.id)
    if (node) {
      nodes.push(orbit(node, at))
      continue
    }
    const room = roomsByFold.get(slot.id)!
    polars.set(slot.id, at)
    nodes.push(placeAt({
      id: slot.id,
      type: 'pile',
      position: { x: 0, y: 0 },
      ...ORBIT_SIZE,
      ...fixedFrame(ORBIT_SIZE, Position.Top, Position.Top),
      className: 'orrery-node',
      zIndex: Z_CARD,
      data: {
        room: room.name,
        count: room.folded.length,
        dimmed: selectedId !== null && !room.folded.some((member) => related.has(member.id)),
        related: room.folded.some((member) => related.has(member.id)),
        onExpand: options.onExpand,
      },
    } satisfies PileNode, at.angle, at.r, at.cx, at.cy))
    for (const member of room.folded) {
      if (member.id === selectedId) nodes.push(orbit(member, { ...at, r: at.r + POPPED_OUT }))
      else foldedInto.set(member.id, slot.id)
    }
  }

  // Straight spokes read better than curves between orbs on a circle.
  const edges = buildEdges(graph, foldedInto, selectedId, now).map((edge) => (edge.type ? edge : { ...edge, type: 'straight' }))
  return { nodes, edges, polar: polars }
}
