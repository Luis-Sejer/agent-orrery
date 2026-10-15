import { useEffect, useRef, useState } from 'react'

import { prefersStill } from './motion'
import { isPrUrl } from './modes'
import type { GraphSnapshot } from './types'
import { newWaits } from './useNotifications'

// A comet marks something new: an agent starting to wait on you flies in to you, a published artifact
// or a linked pull request flies outwards, and a new Same-files collision flares on both agents.
export type CometKind = 'wait' | 'artifact' | 'pr' | 'clash'

export const COMET_MS = 1_800

export interface Comet {
  id: string
  kind: CometKind
  agentId: string
}

interface Seen {
  waits: Set<string>
  links: Set<string>
  clashes: Set<string>
}

// What's new since the last snapshot. The first snapshot only sets what has been seen: comets are for
// news, not for everything that was already there when the page opened.
export function newComets(seen: Seen | null, graph: GraphSnapshot, now: number): { comets: Comet[]; seen: Seen } {
  const { fresh, keys } = newWaits(seen?.waits ?? null, graph.nodes, now)
  const links = new Set<string>()
  const comets: Comet[] = fresh.map((node) => ({ id: `wait:${node.id}:${node.waiting?.since ?? now}`, kind: 'wait', agentId: node.id }))
  for (const node of graph.nodes) {
    for (const { url } of node.artifacts ?? []) links.add(`artifact:${node.id}:${url}`)
    for (const { url } of node.prs ?? []) if (isPrUrl(url)) links.add(`pr:${node.id}:${url}`)
  }
  const clashes = new Set((graph.collisions ?? []).map(({ a, b }) => `${a}>${b}`))
  if (seen) {
    for (const key of links) {
      if (seen.links.has(key)) continue
      const [kind, agentId] = key.split(':')
      comets.push({ id: key, kind: kind as CometKind, agentId })
    }
    for (const key of clashes) {
      if (seen.clashes.has(key)) continue
      for (const agentId of key.split('>')) comets.push({ id: `clash:${key}:${agentId}`, kind: 'clash', agentId })
    }
  }
  // Once seen, always seen: something that leaves and comes back isn't news twice.
  return { comets, seen: { waits: new Set([...(seen?.waits ?? []), ...keys]), links: new Set([...(seen?.links ?? []), ...links]), clashes: new Set([...(seen?.clashes ?? []), ...clashes]) } }
}

// The comets in flight. None while replaying or holding still.
export function useComets(graph: GraphSnapshot, live: boolean): Comet[] {
  const seen = useRef<Seen | null>(null)
  const [comets, setComets] = useState<Comet[]>([])

  useEffect(() => {
    if (graph.nodes.length === 0) return
    // A replay's snapshots aren't news; coming back to live starts from what's there.
    if (!live) {
      seen.current = null
      return
    }
    const result = newComets(seen.current, graph, Date.now())
    seen.current = result.seen
    if (result.comets.length === 0 || prefersStill()) return
    setComets((current) => [...current.filter((comet) => !result.comets.some(({ id }) => id === comet.id)), ...result.comets])
    const ids = new Set(result.comets.map(({ id }) => id))
    setTimeout(() => setComets((current) => current.filter((comet) => !ids.has(comet.id))), COMET_MS + 100)
  }, [graph, live])

  return comets
}
