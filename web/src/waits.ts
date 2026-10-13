import { statusOf } from './status'
import type { AgentNode, Span } from './types'

const MINUTE_MS = 60_000

// Local midnight: "today" as you'd say it.
export function startOfDay(now: number): number {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

// Spans that overlap are one: a question that is also an open prompt counts once.
function join(spans: Span[]): Span[] {
  const joined: Span[] = []
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = joined.at(-1)
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else joined.push([start, end])
  }
  return joined
}

// When a session waited on you between `since` and now: the waits you answered, and the one still open.
export function waitSpans(node: AgentNode, now: number, since: number): Span[] {
  const spans = [...(node.youWaits ?? [])]
  if (statusOf(node, now) === 'waiting' && node.waiting) spans.push([node.waiting.since, now])
  return join(spans.map(([start, end]): Span => [Math.max(start, since), Math.min(end, now)]).filter(([start, end]) => end > start))
}

const total = (spans: Span[]) => spans.reduce((sum, [start, end]) => sum + end - start, 0)

export function waitedOnYou(nodes: AgentNode[], now: number, since: number): number {
  return nodes.filter((node) => node.kind === 'session').reduce((sum, node) => sum + total(waitSpans(node, now, since)), 0)
}

export function waitedFor(node: AgentNode, now: number, since: number): number {
  return total(waitSpans(node, now, since))
}

// "under a minute", "47 min", "2 h 5 min"
export function duration(ms: number): string {
  const minutes = Math.round(ms / MINUTE_MS)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const rest = minutes % 60
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ''}`
}
