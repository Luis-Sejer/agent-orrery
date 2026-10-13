import type { OrbState } from 'thinking-orbs'

export type NodeKind = 'session' | 'subagent' | 'peer'

export interface Waiting {
  reason: 'question' | 'reply'
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

export type View = 'graph' | 'orrery' | 'plans' | 'memory'
