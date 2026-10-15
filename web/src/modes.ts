import type { AgentNode, Modes, PullRequest } from './types'

// Claude Code's permission modes, as people say them; the default needs no word.
const PERMISSION_NAMES: Record<string, string> = {
  acceptEdits: 'Accept edits',
  plan: 'Plan mode',
  auto: 'Auto mode',
  bypassPermissions: 'Bypass permissions',
  dontAsk: "Don't ask",
}
// On a card there's only room for a word.
const PERMISSION_CHIPS: Record<string, string> = {
  acceptEdits: 'accept edits',
  plan: 'plan',
  auto: 'auto',
  bypassPermissions: 'bypass',
  dontAsk: "don't ask",
}

const EFFORT_NAMES: Record<string, string> = { low: 'Low effort', medium: 'Medium effort', high: 'High effort', xhigh: 'Extra high effort', max: 'Max effort' }

export const permissionName = (modes?: Modes | null) => (modes?.permission ? (PERMISSION_NAMES[modes.permission] ?? null) : null)

// Everything it runs in, in words: "Plan mode", "High effort", "Fast mode".
export function describeModes(node: AgentNode): string[] {
  const { modes } = node
  const words = [permissionName(modes), modes?.effort && EFFORT_NAMES[modes.effort], modes?.fast && 'Fast mode']
  return words.filter((word): word is string => Boolean(word))
}

// The chips a card shows: the permission mode unless it's the default, and fast mode. Bypass is a warning.
export function modeChips(node: AgentNode): { label: string; tone: 'plain' | 'warn' }[] {
  const permission = node.modes?.permission
  const chips: { label: string; tone: 'plain' | 'warn' }[] = []
  if (permission && PERMISSION_CHIPS[permission]) chips.push({ label: PERMISSION_CHIPS[permission], tone: permission === 'bypassPermissions' ? 'warn' : 'plain' })
  if (node.modes?.fast) chips.push({ label: 'fast', tone: 'plain' })
  return chips
}

// Pull requests are links to GitHub, and only exactly such a link is made clickable.
const PR_URL = /^https:\/\/github\.com\/[\w.-]{1,100}\/[\w.-]{1,100}\/pull\/\d{1,9}$/

export const isPrUrl = (url: string) => PR_URL.test(url)

export const prLabel = (pr: PullRequest) => `${pr.repo ? `${pr.repo.split('/').at(-1)} ` : ''}#${pr.number}`
