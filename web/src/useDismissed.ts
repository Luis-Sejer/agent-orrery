import { useCallback, useEffect, useState } from 'react'

import { addDismissals, removeDismissals, onStateChange, serverState, type Dismissals } from './settings'
import type { AgentNode, GraphSnapshot } from './types'

// Session id → its last activity when you dismissed it, kept on the server so every browser agrees.
// A dismissal in one page shows in the others as soon as the server says so.
export function useDismissed() {
  const [dismissals, setDismissals] = useState<Dismissals>(() => serverState().dismissals)
  useEffect(() => onStateChange((state) => setDismissals(state.dismissals)), [])

  // Each comes back on its own once it does something newer than this.
  const dismiss = useCallback((nodes: AgentNode[]) => {
    addDismissals(Object.fromEntries(nodes.map((node) => [node.id, node.lastAt])))
    setDismissals(serverState().dismissals)
  }, [])
  // Brings back the given sessions, and only those.
  const restore = useCallback((nodes: AgentNode[]) => {
    removeDismissals(nodes.map((node) => node.id))
    setDismissals(serverState().dismissals)
  }, [])

  return { dismissals, dismiss, restore }
}

// A dismissed session stops waiting on you until it does something new; a finished one dismissed
// (archived) leaves the canvas until then.
export function applyDismissals(graph: GraphSnapshot, dismissals: Dismissals): GraphSnapshot {
  if (Object.keys(dismissals).length === 0) return graph
  const nodes = graph.nodes.map((node) => {
    const dismissedAt = dismissals[node.id]
    if (dismissedAt === undefined || node.lastAt > dismissedAt) return node
    return node.waiting ? { ...node, waiting: null, dismissed: true } : { ...node, archived: true }
  })
  return { ...graph, nodes }
}
