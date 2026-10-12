import { useCallback, useState } from 'react'

import type { AgentNode, GraphSnapshot } from './types'

const STORAGE_KEY = 'agent-graph:dismissed'
const FORGET_AFTER_MS = 7 * 24 * 3_600_000

// Session id → its last activity when you dismissed it. Anything newer brings it back.
type Dismissals = Record<string, number>

function load(): Dismissals {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Dismissals
  } catch {
    return {}
  }
}

function save(dismissals: Dismissals) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(dismissals))
  } catch {
    // Storage can be off (private window); dismissals then last until the page reloads.
  }
}

function forgetOld(dismissals: Dismissals): Dismissals {
  const cutoff = Date.now() - FORGET_AFTER_MS
  return Object.fromEntries(Object.entries(dismissals).filter(([, lastAt]) => lastAt >= cutoff))
}

export function useDismissed() {
  const [dismissals, setDismissals] = useState<Dismissals>(() => forgetOld(load()))

  const update = useCallback((change: (current: Dismissals) => Dismissals) => {
    setDismissals((current) => {
      const next = change(current)
      save(next)
      return next
    })
  }, [])

  const dismiss = useCallback((node: AgentNode) => update((current) => forgetOld({ ...current, [node.id]: node.lastAt })), [update])
  const restoreAll = useCallback(() => update(() => ({})), [update])

  return { dismissals, dismiss, restoreAll }
}

// A dismissed session stops waiting on you until it does something new.
export function applyDismissals(graph: GraphSnapshot, dismissals: Dismissals): GraphSnapshot {
  if (Object.keys(dismissals).length === 0) return graph
  const nodes = graph.nodes.map((node) => {
    const dismissedAt = dismissals[node.id]
    if (!node.waiting || dismissedAt === undefined || node.lastAt > dismissedAt) return node
    return { ...node, waiting: null, dismissed: true }
  })
  return { ...graph, nodes }
}
