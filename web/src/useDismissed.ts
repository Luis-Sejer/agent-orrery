import { useCallback, useEffect, useState } from 'react'

import { addDismissal, clearDismissals, onStateChange, serverState, type Dismissals } from './settings'
import type { AgentNode, GraphSnapshot } from './types'

// Session id → its last activity when you dismissed it, kept on the server so every browser agrees.
// A dismissal in one page shows in the others as soon as the server says so.
export function useDismissed() {
  const [dismissals, setDismissals] = useState<Dismissals>(() => serverState().dismissals)
  useEffect(() => onStateChange((state) => setDismissals(state.dismissals)), [])

  const dismiss = useCallback((node: AgentNode) => {
    addDismissal(node.id, node.lastAt)
    setDismissals(serverState().dismissals)
  }, [])
  const restoreAll = useCallback(() => {
    clearDismissals()
    setDismissals({})
  }, [])

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
