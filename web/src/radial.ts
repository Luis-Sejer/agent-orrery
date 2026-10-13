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
import { statusOf } from './status'
import type { AgentNode, GraphSnapshot, Status } from './types'

// The orrery: you at the centre, agents further out the less they need you. Arranged by status, the rings
// are waiting, running and finished, with a sector per repository. Arranged by repository, each repository
// gets a ring of its own, and the rooms that need you most sit innermost.
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

export type Arrangement = 'status' | 'room'
export type OrbitNode = Node<CardData, 'orbit'>
// A room's finished agents, folded into one orb-sized pile, so it takes one slot like an agent.
export type PileNode = Node<FoldData, 'pile'>
// A ring: its key (a status, or a room's name), its label along the top when it has one, and the most
// urgent status on it, which colours it.
export type Ring = { key: string; label: string | null; r: number; lap: number; tone: Status }
// A room's name and its "Hide finished" button. By status it marks a sector, turning with the outer
// ring; by repository it rides its own ring.
export type Sector = { name: string; start: number; mid: number; foldable: boolean; ring: string; r: number }
export type Turns = Record<string, number>
export type BackdropData = {
  arrangement: Arrangement
  radius: number
  rings: Ring[]
  sectors: Sector[]
  // How far each ring has turned, by key.
  turns: Turns
  waiting: number
  onCollapse: (room: string) => void
}
export type BackdropNode = Node<BackdropData, 'backdrop'>
export type OrreryNode = OrbitNode | PileNode | BackdropNode
// Where a node sits before the rings turn, and which ring carries it.
export type Polar = { angle: number; r: number; ring: string }

export const turnsAt = (rings: Ring[], seconds: number): Turns =>
  Object.fromEntries(rings.map((ring) => [ring.key, (2 * Math.PI * seconds) / ring.lap]))

// Centres a node's box on a point; its label reads the direction away from the centre.
export function placeAt<T extends OrreryNode>(node: T, angle: number, r: number): T {
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)]
  return { ...node, position: { x: cos * r - node.width! / 2, y: sin * r - node.height! / 2 }, style: { '--cos': cos, '--sin': sin } as CSSProperties }
}

interface Slot {
  id: string
  angle: number
  ring: string
  offset: number
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
type Plan = { slots: Slot[]; rings: Ring[]; sectors: Sector[] }

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
  const weights = planned.map(({ ids }) => Math.max(MIN_SECTOR_SLOTS, ids.length))
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0)
  const sweep = 2 * Math.PI - LABEL_GAP - SECTOR_GAP * Math.max(0, planned.length - 1)
  const slots: Slot[] = []
  const sectors: Sector[] = []
  let start = TOP + LABEL_GAP / 2
  planned.forEach(({ room, ids }, index) => {
    const span = (sweep * weights[index]) / weightSum
    ids.forEach((id, slot) => slots.push({ id, angle: start + ((slot + 0.5) * span) / ids.length, ring: status(id), offset: 0 }))
    sectors.push({ name: room.name, start, mid: start + span / 2, foldable: room.foldable, ring: outer.key, r: outer.r + ROOM_LABEL_OFFSET })
    start += span + SECTOR_GAP
  })
  return { slots, rings, sectors }
}

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
    rings.push({ key, label: null, r, lap: LAP_SECONDS.waiting * (r / RINGS.waiting) ** KEPLER, tone: RING_ORDER[urgency(ids)] })
    ids.forEach((id, slot) => slots.push({ id, angle: TOP + LABEL_GAP / 2 + ((slot + 0.5) * sweep) / ids.length, ring: key, offset: 0 }))
    sectors.push({ name: room.name, start: TOP, mid: TOP, foldable: room.foldable, ring: key, r })
  }
  return { slots, rings, sectors }
}

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
  // With no rooms yet there are no room rings, so an empty orrery shows the status rings.
  const { slots, rings, sectors } = (arrangement === 'room' && planned.length > 0 ? byRoom : byStatus)(planned, status)
  stagger(slots, rings)
  const radiusOf = new Map(rings.map((ring) => [ring.key, ring.r]))

  const radius = rings[rings.length - 1].r + ROOM_LABEL_OFFSET + BACKDROP_MARGIN
  const waiting = graph.nodes.filter((node) => statusOf(node, now) === 'waiting').length
  const nodes: OrreryNode[] = [
    {
      id: 'orrery:backdrop',
      type: 'backdrop',
      position: { x: -radius, y: -radius },
      width: radius * 2,
      height: radius * 2,
      zIndex: Z_ROOM,
      selectable: false,
      focusable: false,
      data: {
        arrangement,
        radius,
        rings,
        sectors,
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
    } satisfies OrbitNode, at.angle, at.r)
  }

  const foldedInto = new Map<string, string>()
  const roomsByFold = new Map(rooms.map((room) => [foldId(room.name), room]))
  for (const slot of slots) {
    const at = { angle: slot.angle, r: radiusOf.get(slot.ring)! + slot.offset, ring: slot.ring }
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
    } satisfies PileNode, at.angle, at.r))
    for (const member of room.folded) {
      if (member.id === selectedId) nodes.push(orbit(member, { ...at, r: at.r + POPPED_OUT }))
      else foldedInto.set(member.id, slot.id)
    }
  }

  // Straight spokes read better than curves between orbs on a circle.
  const edges = buildEdges(graph, foldedInto, selectedId, now).map((edge) => (edge.type ? edge : { ...edge, type: 'straight' }))
  return { nodes, edges, polar: polars }
}
