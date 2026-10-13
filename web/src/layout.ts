import { Position, type Edge, type Node, type NodeHandle } from '@xyflow/react'

import { describeCost, mergeUsage } from './pricing'
import { describeStatus, FRESH_MS, roomOf, statusOf } from './status'
import type { AgentNode, Filter, GraphSnapshot } from './types'

export const SESSION_SIZE = { width: 300, height: 100 }
export const AGENT_SIZE = { width: 240, height: 80 }
export const FOLD_SIZE = { width: 170, height: 44 }
const GAP = 14
const PAD = 22
const ROOM_HEADER = 44
const ROOM_NAME_BAND = 72
const SESSION_TO_AGENTS_GAP = 64
const ROOM_GAP = 32
const MIN_ROOM_WIDTH = 340
const MAX_ROW_WIDTH = 1640
const ROWS_PER_COLUMN = 4
const MAX_COLUMNS = 3
const FOLD_FROM = 3
const RECENT_MESSAGE_MS = 20_000
export const Z_ROOM = -1
export const Z_CARD = 1
export const Z_RELATED = 10
// Lit edges sit above every card but the selected one, so they stay readable without
// running across the selected card's own text.
const Z_LIT_EDGE = 30
export const Z_FOCUSED = 40

export const HANDLE_PX = 6

type Size = { width: number; height: number }
type HandleAt = { position: Position; x: number; y: number }

// React Flow re-measures a node it is handed without a size, and drops its edges until then, so they
// flicker whenever the layout rebuilds (selecting, the clock, the orbit 30 times a second). Nodes get
// their size and handles up front instead, where the stylesheet draws them.
export function fixedFrame(size: Size, source: HandleAt, target: HandleAt) {
  const handle = (type: NodeHandle['type'], at: HandleAt): NodeHandle => ({ type, ...at, width: HANDLE_PX, height: HANDLE_PX })
  return { measured: size, handles: [handle('source', source), handle('target', target)] }
}

// The grid's cards: edges leave from the right and arrive on the left, halfway down.
export function sideFrame(size: Size) {
  const y = size.height / 2 - HANDLE_PX / 2
  return fixedFrame(size, { position: Position.Right, x: size.width - HANDLE_PX / 2, y }, { position: Position.Left, x: -HANDLE_PX / 2, y })
}

// React Flow requires node data to be assignable to Record<string, unknown>, which interfaces are not.
export type CardData = { node: AgentNode; now: number; dimmed: boolean; focused: boolean; related: boolean; alsoIn: string[] }
export type FoldData = { room: string; count: number; dimmed: boolean; related: boolean; onExpand: (room: string) => void }
// foldable: the room is open and has enough finished agents to fold back into a pile.
export type RoomData = { name: string; summary: string; dimmed: boolean; foldable: boolean; onCollapse: (room: string) => void }
// recent: a pulse travels along it; fresh: its dashes still flow.
export type MessageData = { recent: boolean; fresh: boolean; count: number }

export type CardNode = Node<CardData, 'session' | 'agent'>
export type FoldNode = Node<FoldData, 'fold'>
export type RoomNode = Node<RoomData, 'room'>
export type FlowNode = CardNode | FoldNode | RoomNode

export interface FlowOptions {
  now: number
  selectedId: string | null
  expandedRooms: ReadonlySet<string>
  filter: Filter
  onExpand: (room: string) => void
  onCollapse: (room: string) => void
}

export interface Room {
  name: string
  sessions: AgentNode[]
  agents: AgentNode[]
  folded: AgentNode[]
  // Open on request, with enough finished agents that it could fold again.
  foldable: boolean
}

interface Placement {
  id: string
  x: number
  y: number
}

export const foldId = (room: string) => `fold:${room}`
const roomId = (room: string) => `room:${room}`

// The selected node, its parent, its subagents, everything in its session, and anyone it messaged.
export function relatedTo(graph: GraphSnapshot, selectedId: string | null): Set<string> {
  const related = new Set<string>()
  if (!selectedId) return related
  const selected = graph.nodes.find((node) => node.id === selectedId)
  if (!selected) return related
  related.add(selected.id)
  if (selected.parentId) related.add(selected.parentId)
  for (const node of graph.nodes) {
    if (node.parentId === selected.id) related.add(node.id)
    if (selected.kind === 'session' && node.sessionId === selected.id) related.add(node.id)
  }
  for (const message of graph.messages) {
    if (message.from === selected.id) related.add(message.to)
    if (message.to === selected.id) related.add(message.from)
  }
  return related
}

// An agent's node is a button that opens its details, named for the agent and what it's doing.
export function opensDetails(node: AgentNode, now: number) {
  return { ariaRole: 'button' as const, ariaLabel: `${node.label}, ${describeStatus(node, now)}` }
}

export function matches(node: AgentNode, filter: Filter, now: number): boolean {
  return filter === 'all' || statusOf(node, now) === filter
}

// Sorted by something that rarely changes, so cards don't shuffle on every update.
function stableOrder(nodes: AgentNode[], now: number): AgentNode[] {
  const rank = (node: AgentNode) => (statusOf(node, now) === 'finished' ? 1 : 0)
  return [...nodes].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))
}

export function groupIntoRooms(graph: GraphSnapshot, options: FlowOptions): Room[] {
  const rooms = new Map<string, Room>()
  const roomFor = (name: string) => {
    if (!rooms.has(name)) rooms.set(name, { name, sessions: [], agents: [], folded: [], foldable: false })
    return rooms.get(name)!
  }
  for (const node of graph.nodes) {
    const room = roomFor(roomOf(node))
    if (node.kind === 'session') room.sessions.push(node)
    else room.agents.push(node)
  }
  for (const room of rooms.values()) {
    room.sessions = stableOrder(room.sessions, options.now)
    room.agents = stableOrder(room.agents, options.now)
    // Selecting must never reflow the canvas, so a pile stays folded when its agents are merely
    // related to the selection. Only the selected agent itself comes out of the pile.
    const foldable = room.agents.filter((node) => statusOf(node, options.now) === 'finished' && node.id !== options.selectedId)
    if (foldable.length < FOLD_FROM) continue
    if (options.expandedRooms.has(room.name)) {
      room.foldable = true
      continue
    }
    room.folded = foldable
    room.agents = room.agents.filter((node) => !foldable.includes(node))
  }
  // Rooms waiting on you come first, then rooms with sessions; within that, alphabetical, so rooms keep their place.
  const waits = (room: Room) => Number(room.sessions.some((node) => statusOf(node, options.now) === 'waiting'))
  const hasSessions = (room: Room) => Number(room.sessions.length > 0)
  return [...rooms.values()].sort((a, b) => waits(b) - waits(a) || hasSessions(b) - hasSessions(a) || a.name.localeCompare(b.name))
}

function layoutRoom(room: Room): { placements: Placement[]; width: number; height: number } {
  const placements: Placement[] = []
  let sessionsBottom = ROOM_HEADER
  for (const session of room.sessions) {
    placements.push({ id: session.id, x: PAD, y: sessionsBottom })
    sessionsBottom += SESSION_SIZE.height + GAP
  }
  const cards = room.agents.map((agent) => agent.id)
  if (room.folded.length > 0) cards.push(foldId(room.name))
  const columns = Math.min(MAX_COLUMNS, Math.max(1, Math.ceil(cards.length / ROWS_PER_COLUMN)))
  const rows = Math.ceil(cards.length / columns)
  const gridX = room.sessions.length > 0 ? PAD + SESSION_SIZE.width + SESSION_TO_AGENTS_GAP : PAD
  cards.forEach((id, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    placements.push({ id, x: gridX + column * (AGENT_SIZE.width + GAP), y: ROOM_HEADER + row * (AGENT_SIZE.height + GAP) })
  })
  const contentWidth = cards.length > 0 ? gridX + columns * (AGENT_SIZE.width + GAP) - GAP : PAD + SESSION_SIZE.width
  const contentHeight = Math.max(sessionsBottom - GAP, ROOM_HEADER + rows * (AGENT_SIZE.height + GAP) - GAP)
  return { placements, width: Math.max(MIN_ROOM_WIDTH, contentWidth + PAD), height: contentHeight + ROOM_NAME_BAND }
}

function summarise(room: Room, now: number): string {
  const all = [...room.sessions, ...room.agents, ...room.folded]
  const waiting = all.filter((node) => statusOf(node, now) === 'waiting').length
  const running = all.filter((node) => statusOf(node, now) === 'running').length
  const finished = all.length - waiting - running
  const counts = [waiting && `${waiting} waiting`, running && `${running} running`, finished && `${finished} finished`].filter(Boolean).join(', ')
  const cost = describeCost(mergeUsage(all.map((node) => node.usage)))
  return cost ? `${counts} · ${cost}` : counts
}

// Repos a session's subagents work in, other than its own.
function reposBySession(graph: GraphSnapshot): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  for (const node of graph.nodes) {
    if (node.kind !== 'subagent' || !node.sessionId) continue
    const repos = result.get(node.sessionId) ?? new Set<string>()
    repos.add(roomOf(node))
    result.set(node.sessionId, repos)
  }
  return result
}

export function buildFlow(graph: GraphSnapshot, options: FlowOptions): { nodes: FlowNode[]; edges: Edge[] } {
  const { now, selectedId } = options
  const related = relatedTo(graph, selectedId)
  const rooms = groupIntoRooms(graph, options)
  const sessionRepos = reposBySession(graph)
  const nodes: FlowNode[] = []
  const foldedInto = new Map<string, string>()

  const isDimmed = (node: AgentNode) =>
    (selectedId !== null && !related.has(node.id)) || !matches(node, options.filter, now)

  let x = 0
  let y = 0
  let rowHeight = 0
  for (const room of rooms) {
    const { placements, width, height } = layoutRoom(room)
    if (x > 0 && x + width > MAX_ROW_WIDTH) {
      x = 0
      y += rowHeight + ROOM_GAP
      rowHeight = 0
    }
    const members = [...room.sessions, ...room.agents, ...room.folded]
    nodes.push({
      id: roomId(room.name),
      type: 'room',
      position: { x, y },
      width,
      height,
      style: { width, height },
      measured: { width, height },
      zIndex: Z_ROOM,
      selectable: false,
      // Only its "Hide finished" button takes focus.
      focusable: false,
      data: { name: room.name, summary: summarise(room, now), dimmed: members.every(isDimmed), foldable: room.foldable, onCollapse: options.onCollapse },
    })
    const byId = new Map(members.map((node) => [node.id, node]))
    for (const placement of placements) {
      const position = { x: x + placement.x, y: y + placement.y }
      const node = byId.get(placement.id)
      if (!node) {
        nodes.push({
          id: placement.id,
          type: 'fold',
          position,
          ...FOLD_SIZE,
          ...sideFrame(FOLD_SIZE),
          zIndex: Z_CARD,
          // The pile is a button of its own; the node around it needn't be a second stop.
          focusable: false,
          data: {
            room: room.name,
            count: room.folded.length,
            dimmed: selectedId !== null && !room.folded.some((node) => related.has(node.id)),
            related: room.folded.some((node) => related.has(node.id)),
            onExpand: options.onExpand,
          },
        })
        continue
      }
      const focused = node.id === selectedId
      const alsoIn = [...(sessionRepos.get(node.id) ?? [])].filter((repo) => repo !== room.name).sort()
      nodes.push({
        id: node.id,
        type: node.kind === 'session' ? 'session' : 'agent',
        position,
        // Known sizes let the minimap and fit-to-view work without measuring the DOM.
        ...(node.kind === 'session' ? SESSION_SIZE : AGENT_SIZE),
        ...sideFrame(node.kind === 'session' ? SESSION_SIZE : AGENT_SIZE),
        zIndex: focused ? Z_FOCUSED : related.has(node.id) ? Z_RELATED : Z_CARD,
        ...opensDetails(node, now),
        data: { node, now, dimmed: isDimmed(node), focused, related: related.has(node.id), alsoIn },
      })
    }
    for (const node of room.folded) foldedInto.set(node.id, foldId(room.name))
    x += width + ROOM_GAP
    rowHeight = Math.max(rowHeight, height)
  }

  return { nodes, edges: buildEdges(graph, foldedInto, selectedId, now) }
}

const TREE_COLUMN_GAP = 56
const TREE_ROOT_GAP = 32

// Who started whom, left to right: sessions in the first column, each subagent a column to the right
// of its parent and level with its first sibling. Ordered by repository and name, never by status, so
// nothing jumps when an agent finishes.
export function buildTree(graph: GraphSnapshot, options: FlowOptions): { nodes: FlowNode[]; edges: Edge[] } {
  const { now, selectedId } = options
  const related = relatedTo(graph, selectedId)
  const ids = new Set(graph.nodes.map((node) => node.id))
  const children = new Map<string, AgentNode[]>()
  for (const node of graph.nodes) if (node.parentId && ids.has(node.parentId)) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node])
  const byPlace = (a: AgentNode, b: AgentNode) => roomOf(a).localeCompare(roomOf(b)) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id)
  const sessionsFirst = (a: AgentNode, b: AgentNode) => Number(b.kind === 'session') - Number(a.kind === 'session') || byPlace(a, b)
  const roots = graph.nodes.filter((node) => !node.parentId || !ids.has(node.parentId)).sort(sessionsFirst)
  const columnX = (depth: number) => (depth === 0 ? 0 : SESSION_SIZE.width + TREE_COLUMN_GAP + (depth - 1) * (AGENT_SIZE.width + TREE_COLUMN_GAP))

  const nodes: FlowNode[] = []
  const placed = new Set<string>()
  // Places a node and everything below it from y; returns where the next sibling may start.
  const place = (node: AgentNode, depth: number, y: number): number => {
    placed.add(node.id)
    const size = node.kind === 'session' ? SESSION_SIZE : AGENT_SIZE
    const focused = node.id === selectedId
    nodes.push({
      id: node.id,
      type: node.kind === 'session' ? 'session' : 'agent',
      position: { x: columnX(depth), y },
      ...size,
      ...sideFrame(size),
      zIndex: focused ? Z_FOCUSED : related.has(node.id) ? Z_RELATED : Z_CARD,
      ...opensDetails(node, now),
      data: { node, now, dimmed: (selectedId !== null && !related.has(node.id)) || !matches(node, options.filter, now), focused, related: related.has(node.id), alsoIn: [] },
    })
    let next = y
    for (const child of (children.get(node.id) ?? []).sort(byPlace)) if (!placed.has(child.id)) next = place(child, depth + 1, next) + GAP
    return Math.max(y + size.height, next - GAP)
  }
  let y = 0
  for (const root of roots) y = place(root, 0, y) + TREE_ROOT_GAP
  // An agent whose parents loop back on themselves is nobody's child; it still gets a row.
  for (const node of graph.nodes) if (!placed.has(node.id)) y = place(node, 0, y) + TREE_ROOT_GAP

  return { nodes, edges: buildEdges(graph, new Map(), selectedId, now) }
}

// Lines would be read out as "Edge from <id> to <id>"; the drawer already says who is connected to whom.
const UNSPOKEN = { domAttributes: { 'aria-hidden': true } } as const

export function buildEdges(graph: GraphSnapshot, foldedInto: Map<string, string>, selectedId: string | null, now: number): Edge[] {
  const edges = new Map<string, Edge>()
  const endpoint = (id: string) => foldedInto.get(id) ?? id
  const style = (from: string, to: string) => {
    if (!selectedId) return { className: '', zIndex: 0 }
    const lit = from === selectedId || to === selectedId
    return lit ? { className: 'lit', zIndex: Z_LIT_EDGE } : { className: 'dimmed', zIndex: 0 }
  }

  for (const node of graph.nodes) {
    if (!node.parentId) continue
    const source = endpoint(node.parentId)
    const target = endpoint(node.id)
    if (source === target) continue
    // Lines to a pile of finished agents are noise unless you're looking at their parent.
    if (target !== node.id && selectedId !== node.parentId) continue
    const id = `spawn:${source}>${target}`
    const { className, zIndex } = style(node.parentId, node.id)
    // A fold stands in for several agents; keep it lit if any of them is.
    if (edges.has(id) && !className.includes('lit')) continue
    edges.set(id, { id, source, target, className: `spawn ${className}`, zIndex, ...UNSPOKEN })
  }
  for (const message of graph.messages) {
    const source = endpoint(message.from)
    const target = endpoint(message.to)
    if (source === target) continue
    const id = `message:${source}>${target}`
    const { className, zIndex } = style(message.from, message.to)
    edges.set(id, {
      id,
      source,
      target,
      type: 'message',
      className,
      zIndex,
      ...UNSPOKEN,
      data: { recent: now - message.lastAt < RECENT_MESSAGE_MS, fresh: now - message.lastAt < FRESH_MS, count: message.count },
    })
  }
  // Two agents in the same files: a warning line between them, above everything but the selected card.
  // An agent that has finished and gone into a pile has stopped editing, so it gets none.
  for (const { a, b } of graph.collisions ?? []) {
    if (endpoint(a) !== a || endpoint(b) !== b) continue
    const id = `collision:${a}>${b}`
    const { className } = style(a, b)
    edges.set(id, { id, source: a, target: b, className: `collision ${className}`, zIndex: Z_LIT_EDGE, ...UNSPOKEN })
  }
  return [...edges.values()]
}
