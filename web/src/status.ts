import type { OrbState } from 'thinking-orbs'

import type { AgentNode, Status } from './types'

// A running tool such as a long test suite writes nothing for minutes, so "running" lasts this long.
const STALE_MS = 15 * 60_000
const ELSEWHERE = 'elsewhere'

export const STATE_COLOURS: Record<OrbState, string> = {
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

export function statusOf(node: AgentNode, now: number): Status {
  if (node.dismissed) return 'finished'
  if (node.waiting && node.kind === 'session') return 'waiting'
  if (node.waiting) return 'finished'
  return now - node.lastAt < STALE_MS ? 'running' : 'finished'
}

export function orbStateOf(node: AgentNode, now: number): OrbState {
  const status = statusOf(node, now)
  if (status === 'waiting') return 'listening'
  if (status === 'finished') return 'breathing'
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
