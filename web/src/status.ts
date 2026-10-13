import type { OrbState } from 'thinking-orbs'

import type { AgentNode, GraphSnapshot, Status } from './types'

// A running tool such as a long test suite writes nothing for minutes, so "running" lasts this long.
const STALE_MS = 15 * 60_000
// A tool call with no result yet may be a permission prompt waiting for you, so the agent keeps
// looking busy for much longer instead of quietly passing as finished.
const PENDING_STALE_MS = 2 * 60 * 60_000
// Running but silent for this long is worth a look: it may be waiting for approval.
const QUIET_MS = 5 * 60_000
const ELSEWHERE = 'elsewhere'

const STATE_COLOURS: Record<OrbState, string> = {
  working: '#34955f',
  solving: '#34955f',
  shaping: '#34955f',
  weaving: '#34955f',
  searching: '#3f7fae',
  composing: '#7d64a8',
  connecting: '#b9822f',
  listening: '#c0504a',
  breathing: '#97a29f',
}

// The same meanings, brighter, for the T.Y.C.H.O. HUD's black ground.
const NEON_COLOURS: Record<OrbState, string> = {
  working: '#3dffa2',
  solving: '#3dffa2',
  shaping: '#3dffa2',
  weaving: '#3dffa2',
  searching: '#4fd2ff',
  composing: '#b78cff',
  connecting: '#ffb02e',
  listening: '#ff4d5a',
  breathing: '#8d8a84',
}

export function stateColour(state: OrbState, hud: boolean): string {
  return (hud ? NEON_COLOURS : STATE_COLOURS)[state]
}

export function statusOf(node: AgentNode, now: number): Status {
  if (node.dismissed) return 'finished'
  if (node.awaitingAgents) return 'running'
  if (node.waiting && node.kind === 'session') return 'waiting'
  if (node.waiting) return 'finished'
  return now - node.lastAt < (node.pendingTool ? PENDING_STALE_MS : STALE_MS) ? 'running' : 'finished'
}

export function isQuiet(node: AgentNode, now: number): boolean {
  return statusOf(node, now) === 'running' && !node.awaitingAgents && now - node.lastAt >= QUIET_MS
}

// MCP tools are named mcp__server__tool; the last part reads best.
const toolLabel = (name: string) => name.split('__').pop() ?? name

export function orbStateOf(node: AgentNode, now: number): OrbState {
  const status = statusOf(node, now)
  if (status === 'waiting') return 'listening'
  if (status === 'finished') return 'breathing'
  if (node.awaitingAgents) return 'connecting'
  return node.activity ?? 'solving'
}

export function roomOf(node: AgentNode): string {
  return node.room ?? ELSEWHERE
}

const JUST_NOW_SECONDS = 5

export function ago(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < JUST_NOW_SECONDS) return 'moments'
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`
}

export function describeStatus(node: AgentNode, now: number): string {
  const status = statusOf(node, now)
  if (status === 'waiting') {
    const what = node.waiting?.reason === 'question' ? 'Asked you a question' : 'Finished, waiting for you'
    return `${what}, ${ago(node.waiting?.since ?? node.lastAt, now)} ago`
  }
  if (node.awaitingAgents) return `Waiting on ${node.awaitingAgents} ${node.awaitingAgents === 1 ? 'agent' : 'agents'}`
  if (isQuiet(node, now)) {
    if (!node.pendingTool) return `Quiet for ${ago(node.lastAt, now)}`
    return `${toolLabel(node.pendingTool.name)} has run for ${ago(node.pendingTool.since, now)}, may be waiting for your approval`
  }
  if (status === 'finished') return `Finished ${ago(node.lastAt, now)} ago`
  return node.lastTool ? `${verbFor(node.activity)} ${ago(node.lastAt, now)} ago` : 'Thinking'
}

const VERBS: Partial<Record<OrbState, string>> = {
  working: 'Running a command',
  searching: 'Reading',
  composing: 'Writing code',
  connecting: 'Talking to agents',
  listening: 'Asking you',
  solving: 'Thinking',
}

export function verbFor(activity: OrbState | null): string {
  return (activity && VERBS[activity]) ?? 'Working'
}

// A session that ended its turn while subagents it started are still running isn't waiting on you:
// they wake it when they report back. One that asked you a question still is.
export function awaitAgents(graph: GraphSnapshot, now: number): GraphSnapshot {
  const running = new Map<string, number>()
  for (const node of graph.nodes) {
    if (node.kind === 'subagent' && node.sessionId && statusOf(node, now) === 'running') running.set(node.sessionId, (running.get(node.sessionId) ?? 0) + 1)
  }
  if (running.size === 0) return graph
  const nodes = graph.nodes.map((node) => {
    const count = running.get(node.id)
    return count && node.kind === 'session' && node.waiting?.reason === 'reply' ? { ...node, waiting: null, awaitingAgents: count } : node
  })
  return { ...graph, nodes }
}
