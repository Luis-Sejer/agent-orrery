import type { OrbState } from 'thinking-orbs'

import type { AgentNode, GraphSnapshot, Status, Waiting } from './types'

// A running tool such as a long test suite writes nothing for minutes, so "running" lasts this long.
const STALE_MS = 15 * 60_000
// A tool call with no result yet may be a permission prompt waiting for you, so the agent keeps
// looking busy for much longer instead of quietly passing as finished.
const PENDING_STALE_MS = 2 * 60 * 60_000
// Silence after a tool result long enough to mean a held-back question (HELD_REPLY_MS in graph.mjs).
const HELD_REPLY_MS = 3 * 60_000
// How long a background shell keeps its session waiting on it (BACKGROUND_MS in graph.mjs).
const BACKGROUND_MS = 30 * 60_000
// Running but silent for this long is worth a look: it may be waiting for approval.
const QUIET_MS = 5 * 60_000
// A wait or a message this new still moves on screen; after that it rests, still coloured, so the page
// isn't always busy.
export const FRESH_MS = 2 * 60_000
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
  if (node.dismissed || node.live?.status === 'closed') return 'finished'
  if (node.awaiting) return 'running'
  if (node.waiting && node.kind === 'session') return 'waiting'
  if (node.waiting) return 'finished'
  return now - node.lastAt < (node.pendingTool ? PENDING_STALE_MS : STALE_MS) ? 'running' : 'finished'
}

export function isQuiet(node: AgentNode, now: number): boolean {
  return statusOf(node, now) === 'running' && !node.awaiting && now - node.lastAt >= QUIET_MS
}

// MCP tools are named mcp__server__tool; the last part reads best.
const toolLabel = (name: string) => name.split('__').pop() ?? name

export function orbStateOf(node: AgentNode, now: number): OrbState {
  const status = statusOf(node, now)
  if (status === 'waiting') return 'listening'
  if (status === 'finished') return 'breathing'
  if (node.awaiting) return 'connecting'
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

const waitingSince = (node: AgentNode) => node.waiting?.since ?? node.lastAt

export function isFreshWait(node: AgentNode, now: number): boolean {
  return statusOf(node, now) === 'waiting' && now - waitingSince(node) < FRESH_MS
}

// What a waiting session wants from you, as "<label> …": "asked you a question", "needs your permission".
export function waitPhrase(waiting: Waiting | null): string {
  if (waiting?.reason === 'question') return waiting.probably ? 'is probably asking you a question' : 'asked you a question'
  if (waiting?.reason === 'permission') return 'needs your permission'
  if (waiting?.reason === 'dialog') return 'needs your input'
  return 'finished'
}

// The same, standing alone: "Asked you a question", "Probably asking you a question".
export const waitSentence = (waiting: Waiting | null) => waitPhrase(waiting).replace(/^is /, '').replace(/^./, (first) => first.toUpperCase())

// A waiting session's line where it is already listed as waiting on you: Your turn, or a red card.
export function waitingLine(node: AgentNode, now: number): string {
  return `${waitSentence(node.waiting)}, ${ago(waitingSince(node), now)} ago`
}

export function describeStatus(node: AgentNode, now: number): string {
  const status = statusOf(node, now)
  if (status === 'waiting') {
    if (node.waiting?.reason !== 'reply') return waitingLine(node, now)
    return `Finished, waiting on you, ${ago(waitingSince(node), now)} ago`
  }
  if (node.awaiting) return `Waiting on ${awaitingText(node.awaiting)}`
  if (isQuiet(node, now)) {
    if (!node.pendingTool) return `Quiet for ${ago(node.lastAt, now)}`
    const running = `${toolLabel(node.pendingTool.name)} has run for ${ago(node.pendingTool.since, now)}`
    // Claude Code says when a prompt is open, so with its status there's nothing to guess.
    return node.live ? running : `${running}, may be waiting for your approval`
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

const counted = (count: number, one: string, many: string) => (count === 1 ? one : `${count} ${many}`)

// "an agent", "2 agents and a shell"
function awaitingText({ agents, shells }: { agents: number; shells: number }): string {
  const parts = [agents > 0 && counted(agents, 'an agent', 'agents'), shells > 0 && counted(shells, 'a shell', 'shells')].filter(Boolean)
  return parts.join(' and ') || 'its agents'
}

// Where Claude Code says what a session is doing, that settles it (liveWait in graph.mjs too): a
// prompt or dialog is waiting on you, and so is a turn that's over with nothing left running. Busy
// after its turn ended means background agents still run; shell, a background command.
function settleLive(node: AgentNode, agents: number, shells: number): AgentNode {
  const live = node.live!
  const since = live.since ?? node.lastAt
  switch (live.status) {
    case 'waiting':
      return { ...node, waiting: { reason: live.reason ?? 'dialog', since } }
    case 'idle':
      return { ...node, waiting: node.waiting ?? { reason: 'reply', since } }
    case 'shell':
      return { ...node, waiting: null, awaiting: { agents, shells: Math.max(1, shells) } }
    case 'busy':
      return node.waiting || agents > 0 ? { ...node, waiting: null, awaiting: { agents, shells } } : node
    default:
      return { ...node, waiting: null }
  }
}

// A session that ended its turn while its subagents or background shells are still running isn't
// waiting on you: they wake it when they report back. One that asked you a question still is.
export function awaitAgents(graph: GraphSnapshot, now: number): GraphSnapshot {
  const agents = new Map<string, number>()
  for (const node of graph.nodes) {
    if (node.kind === 'subagent' && node.sessionId && statusOf(node, now) === 'running') agents.set(node.sessionId, (agents.get(node.sessionId) ?? 0) + 1)
  }
  // A background call counts for half an hour at most: one that never ends (a dev server) mustn't keep
  // a session busy for good.
  const shellsOf = (node: AgentNode) => (node.background ?? []).filter((task) => now - task.since < BACKGROUND_MS).length
  let changed = false
  const nodes = graph.nodes.map((node) => {
    if (node.kind === 'session' && node.live) {
      changed = true
      return settleLive(node, agents.get(node.id) ?? 0, shellsOf(node))
    }
    // Silent right after a tool result, with nothing running: Claude Code is holding back a message
    // until you answer it, which in practice is a question.
    if (node.kind === 'session' && node.owesReply && !node.waiting && !node.pendingTool && now - node.lastAt >= HELD_REPLY_MS) {
      changed = true
      return { ...node, waiting: { reason: 'question' as const, since: node.lastAt, probably: true } }
    }
    // Also mid-turn: a session gone quiet while its own agents or shells work is waiting on them.
    const turnEnded = node.waiting?.reason === 'reply'
    const quietMidTurn = !node.waiting && statusOf(node, now) === 'running' && now - node.lastAt >= QUIET_MS
    if (node.kind !== 'session' || !(turnEnded || quietMidTurn)) return node
    const awaiting = { agents: agents.get(node.id) ?? 0, shells: shellsOf(node) }
    if (awaiting.agents + awaiting.shells === 0) return node
    changed = true
    return { ...node, waiting: null, awaiting }
  })
  return changed ? { ...graph, nodes } : graph
}

// The canvas without finished agents, so rooms and systems with nothing going on disappear with them.
// The selected agent stays, so its details stay open. `which` narrows it, e.g. to archived ones.
export function withoutFinished(graph: GraphSnapshot, now: number, keep: string | null, which: (node: AgentNode) => boolean = () => true): GraphSnapshot {
  const nodes = graph.nodes.filter((node) => node.id === keep || statusOf(node, now) !== 'finished' || !which(node))
  if (nodes.length === graph.nodes.length) return graph
  const shown = new Set(nodes.map((node) => node.id))
  return {
    ...graph,
    nodes,
    messages: graph.messages.filter(({ from, to }) => shown.has(from) && shown.has(to)),
    collisions: graph.collisions?.filter(({ a, b }) => shown.has(a) && shown.has(b)),
  }
}
