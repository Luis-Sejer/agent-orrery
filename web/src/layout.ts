import type { Edge, Node } from '@xyflow/react'

import { describeCost, mergeUsage } from './pricing'
import { roomOf, statusOf } from './status'
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

// React Flow requires node data to be assignable to Record<string, unknown>, which interfaces are not.
export type CardData = { node: AgentNode; now: number; dimmed: boolean; focused: boolean; related: boolean; alsoIn: string[] }
export type FoldData = { room: string; count: number; dimmed: boolean; related: boolean; onExpand: (room: string) => void }
// foldable: the room is open and has enough finished agents to fold back into a pile.
export type RoomData = { name: string; summary: string; dimmed: boolean; foldable: boolean; onCollapse: (room: string) => void }
export type MessageData = { recent: boolean; count: number }

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
  // Rooms with sessions come first; within that, alphabetical, so rooms keep their place.
  return [...rooms.values()].sort(
    (a, b) => Number(b.sessions.length > 0) - Number(a.sessions.length > 0) || a.name.localeCompare(b.name),
  )
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
      zIndex: Z_ROOM,
      selectable: false,
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
          zIndex: Z_CARD,
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
        zIndex: focused ? Z_FOCUSED : related.has(node.id) ? Z_RELATED : Z_CARD,
        data: { node, now, dimmed: isDimmed(node), focused, related: related.has(node.id), alsoIn },
      })
    }
    for (const node of room.folded) foldedInto.set(node.id, foldId(room.name))
    x += width + ROOM_GAP
    rowHeight = Math.max(rowHeight, height)
  }

  return { nodes, edges: buildEdges(graph, foldedInto, selectedId, now) }
}

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
    edges.set(id, { id, source, target, className: `spawn ${className}`, zIndex })
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
      data: { recent: now - message.lastAt < RECENT_MESSAGE_MS, count: message.count },
    })
  }
  return [...edges.values()]
}
