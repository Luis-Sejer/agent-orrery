import type { OrbState } from 'thinking-orbs'

export type NodeKind = 'session' | 'subagent' | 'peer'

// question: AskUserQuestion; permission: a permission prompt; dialog: some other dialog; reply: its turn is over.
export type WaitReason = 'question' | 'permission' | 'dialog' | 'reply'

export interface Waiting {
  reason: WaitReason
  since: number
  // Inferred, not written: Claude Code writes a question only once you've answered it.
  probably?: boolean
}

export interface PendingTool {
  name: string
  since: number
}

// Token counts for one model, as Claude Code records them.
export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
}

export type ModelUsage = Record<string, TokenUsage>

export interface BackgroundTask {
  name: string
  since: number
}

// What Claude Code itself says a session is doing (~/.claude/sessions). closed: the session has ended.
export interface Live {
  status: 'busy' | 'shell' | 'idle' | 'waiting' | 'closed'
  since?: number
  reason?: Exclude<WaitReason, 'reply'>
}

export type Span = [start: number, end: number]

export interface AgentNode {
  id: string
  kind: NodeKind
  label: string
  branch: string | null
  home: string | null
  room: string | null
  repos: string[]
  activity: OrbState | null
  lastTool: string | null
  lastAt: number
  waiting: Waiting | null
  // The oldest tool call that has started and has no result yet.
  pendingTool: PendingTool | null
  usage: ModelUsage
  agentType: string | null
  model: string | null
  sessionId: string | null
  parentId: string | null
  plans: string[]
  // Set in the browser when you dismiss a waiting session.
  dismissed?: boolean
  // Calls running in the background (run_in_background) that haven't reported back yet.
  background?: BackgroundTask[]
  // A tool result or a prompt came in last, so the model owes a reply.
  owesReply?: boolean
  // Set in the browser: what a session that ended its turn is still waiting for.
  awaiting?: { agents: number; shells: number }
  // Null while unknown: older Claude Code, a replay, or the status folder not shared with Docker.
  live?: Live | null
  // When it waited on you, and you answered.
  youWaits?: Span[]
  // Artifacts it published on claude.ai, newest first.
  artifacts?: Artifact[]
  // Tool calls so far; each new one sends a packet along its line.
  toolCount?: number
}

export interface Artifact {
  title: string
  url: string
  at: number
}

// An artifact from any transcript, with where it was made, for the Artifacts view and search.
export interface ArtifactEntry extends Artifact {
  sessionId: string
  agentId: string | null
  session: string | null
  repo: string | null
}

// Two agents that edited the same files lately.
export interface Collision {
  a: string
  b: string
  files: string[]
  repo: string | null
  at: number
}

// A session's day: when it worked, and when its subagents did.
export interface DayRow {
  id: string
  runs: Span[]
  agentRuns: Span[]
}

export interface MessageLink {
  from: string
  to: string
  count: number
  lastAt: number
}

export interface GraphSnapshot {
  nodes: AgentNode[]
  messages: MessageLink[]
  collisions?: Collision[]
  // Your plan's usage, from the status line bridge; absent without it, and in a replay.
  usage?: Usage | null
}

export interface UsageWindow {
  percent: number
  resetsAt: number | null
  // The session window only: where it's heading at the last hour's pace; null until there's enough to go on.
  forecast?: UsageForecast | null
}

export interface UsageForecast {
  perHour: number
  // Where it will be when the window resets, at most 100.
  atReset: number
  // When it reaches 100 %, if that's before the reset.
  limitAt: number | null
}

export interface Usage {
  // When a status line last saw it.
  at: number
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
}

export interface TimelineEvent {
  at: number
  activity: OrbState
  text: string
  repo: string | null
}

export interface PlanSummary {
  name: string
  title: string
  modifiedAt: number
}

export interface MemoryNote {
  name: string
  title: string
  description: string | null
  modifiedAt: number
}

export interface MemoryProject {
  project: string
  label: string
  notes: MemoryNote[]
}

export type Status = 'waiting' | 'running' | 'finished'

export type Filter = 'all' | Status

export type View = 'graph' | 'orrery' | 'day' | 'artifacts' | 'plans' | 'memory'
