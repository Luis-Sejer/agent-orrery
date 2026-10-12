import type { CSSProperties } from 'react'
import { Position, type Edge, type Node, type NodeHandle } from '@xyflow/react'

import {
  buildEdges,
  FOLD_SIZE,
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
  type FoldNode,
} from './layout'
import { statusOf } from './status'
import type { AgentNode, GraphSnapshot, Status } from './types'

// The orrery: you at the centre, agents further out the less they need you, one sector per repository.
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

export type OrbitNode = Node<CardData, 'orbit'>
export type Sector = { name: string; start: number; mid: number; foldable: boolean }
export type Turns = Record<Status, number>
export type BackdropData = {
  radius: number
  rings: { status: Status; r: number }[]
  sectors: Sector[]
  labelRadius: number
  // How far each ring has turned; room names turn with the outer ring.
  turns: Turns
  waiting: number
  onCollapse: (room: string) => void
}
export type BackdropNode = Node<BackdropData, 'backdrop'>
export type OrreryNode = OrbitNode | FoldNode | BackdropNode
// Where a node sits before the rings turn, and which ring carries it.
export type Polar = { angle: number; r: number; ring: Status }

export const turnsAt = (seconds: number): Turns => ({
  waiting: (2 * Math.PI * seconds) / LAP_SECONDS.waiting,
  running: (2 * Math.PI * seconds) / LAP_SECONDS.running,
  finished: (2 * Math.PI * seconds) / LAP_SECONDS.finished,
})

// Centres a node's box on a point; its label reads the direction away from the centre.
export function placeAt<T extends OrreryNode>(node: T, angle: number, r: number): T {
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)]
  return { ...node, position: { x: cos * r - node.width! / 2, y: sin * r - node.height! / 2 }, style: { '--cos': cos, '--sin': sin } as CSSProperties }
}

interface Slot {
  id: string
  angle: number
  ring: Status
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
function stagger(slots: Slot[], radii: Record<Status, number>) {
  for (const ring of RING_ORDER) {
    const onRing = slots.filter((slot) => slot.ring === ring).sort((a, b) => a.angle - b.angle)
    const close = (a?: Slot, b?: Slot) => !!a && !!b && (b.angle - a.angle) * radii[ring] < STAGGER_ARC
    let run = 0
    onRing.forEach((slot, index) => {
      const crowded = close(onRing[index - 1], slot) || close(slot, onRing[index + 1])
      run = close(onRing[index - 1], slot) ? run + 1 : 0
      slot.offset = crowded ? (run % 2 === 0 ? -STAGGER : STAGGER) : 0
    })
  }
}

export function buildOrrery(graph: GraphSnapshot, options: FlowOptions): { nodes: OrreryNode[]; edges: Edge[]; polar: Map<string, Polar> } {
  const { now, selectedId } = options
  const related = relatedTo(graph, selectedId)
  const isDimmed = (node: AgentNode) => (selectedId !== null && !related.has(node.id)) || !matches(node, options.filter, now)
  // Grouped as if nothing were selected, so selecting can never move anything.
  const rooms = groupIntoRooms(graph, { ...options, selectedId: null }).sort((a, b) => a.name.localeCompare(b.name))
  const ordered = rooms.map((room) => ({ room, members: treeOrder([...room.sessions, ...room.agents]) }))
  const slotCount = (index: number) => ordered[index].members.length + (ordered[index].room.folded.length > 0 ? 1 : 0)

  const totalSlots = ordered.reduce((sum, _, index) => sum + slotCount(index), 0)
  const scale = Math.max(1, (totalSlots * SLOT_ARC) / (2 * Math.PI * RINGS.running))
  const radii = { waiting: RINGS.waiting * scale, running: RINGS.running * scale, finished: RINGS.finished * scale }

  const weights = ordered.map((_, index) => Math.max(MIN_SECTOR_SLOTS, slotCount(index)))
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0)
  const sweep = 2 * Math.PI - LABEL_GAP - SECTOR_GAP * Math.max(0, rooms.length - 1)
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]))
  const slots: Slot[] = []
  const sectors: Sector[] = []
  let start = TOP + LABEL_GAP / 2
  ordered.forEach(({ room, members }, index) => {
    const span = (sweep * weights[index]) / weightSum
    const ids = members.map((node) => node.id)
    if (room.folded.length > 0) ids.push(foldId(room.name))
    ids.forEach((id, slot) => {
      const node = nodesById.get(id)
      slots.push({ id, angle: start + ((slot + 0.5) * span) / ids.length, ring: node ? statusOf(node, now) : 'finished', offset: 0 })
    })
    sectors.push({ name: room.name, start, mid: start + span / 2, foldable: room.foldable })
    start += span + SECTOR_GAP
  })
  stagger(slots, radii)

  const radius = radii.finished + ROOM_LABEL_OFFSET + BACKDROP_MARGIN
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
        radius,
        rings: RING_ORDER.map((status) => ({ status, r: radii[status] })),
        sectors,
        labelRadius: radii.finished + ROOM_LABEL_OFFSET,
        turns: turnsAt(0),
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
    const at = { angle: slot.angle, r: radii[slot.ring] + slot.offset, ring: slot.ring }
    const node = nodesById.get(slot.id)
    if (node) {
      nodes.push(orbit(node, at))
      continue
    }
    const room = roomsByFold.get(slot.id)!
    polars.set(slot.id, at)
    nodes.push(placeAt({
      id: slot.id,
      type: 'fold',
      position: { x: 0, y: 0 },
      ...FOLD_SIZE,
      ...fixedFrame(FOLD_SIZE, Position.Right, Position.Left),
      className: 'orrery-node',
      zIndex: Z_CARD,
      data: {
        room: room.name,
        count: room.folded.length,
        dimmed: selectedId !== null && !room.folded.some((member) => related.has(member.id)),
        related: room.folded.some((member) => related.has(member.id)),
        onExpand: options.onExpand,
      },
    } satisfies FoldNode, at.angle, at.r))
    for (const member of room.folded) {
      if (member.id === selectedId) nodes.push(orbit(member, { ...at, r: at.r + POPPED_OUT }))
      else foldedInto.set(member.id, slot.id)
    }
  }

  // Straight spokes read better than curves between orbs on a circle.
  const edges = buildEdges(graph, foldedInto, selectedId, now).map((edge) => (edge.type ? edge : { ...edge, type: 'straight' }))
  return { nodes, edges, polar: polars }
}
