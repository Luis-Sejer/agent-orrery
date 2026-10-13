import { useEffect, useRef, useState } from 'react'
import type { OrbState } from 'thinking-orbs'

import { prefersStill } from './motion'
import type { GraphSnapshot } from './types'

// A packet runs from a subagent to its parent for each tool call it makes: how long it takes, how many
// one line carries at once (a busy agent mustn't turn its line into confetti), and the gap between them.
export const PACKET_MS = 1_100
const MAX_PER_LINE = 3
const STAGGER_MS = 280

export interface Packet {
  id: string
  activity: OrbState
  // Milliseconds after it reaches the page that it sets off.
  delay: number
  // When it will have arrived, to drop it after.
  doneAt: number
}

// New tool calls since the last update, as packets per subagent. Nothing while replaying or holding still.
export function usePackets(graph: GraphSnapshot, live: boolean): Map<string, Packet[]> {
  const counts = useRef(new Map<string, number>())
  const [packets, setPackets] = useState(new Map<string, Packet[]>())

  useEffect(() => {
    const now = Date.now()
    const fresh = new Map<string, Packet[]>()
    for (const node of graph.nodes) {
      if (node.kind !== 'subagent' || !node.parentId) continue
      const before = counts.current.get(node.id)
      const count = node.toolCount ?? 0
      counts.current.set(node.id, count)
      if (before === undefined || count <= before || !live || prefersStill()) continue
      fresh.set(
        node.id,
        Array.from({ length: Math.min(count - before, MAX_PER_LINE) }, (_, index) => ({
          id: `${node.id}:${count}:${index}`,
          activity: node.activity ?? 'working',
          delay: index * STAGGER_MS,
          doneAt: now + index * STAGGER_MS + PACKET_MS,
        })),
      )
    }
    if (fresh.size === 0) return
    // Packets still on their way keep going; the new ones join them, up to the cap per line.
    setPackets((current) => {
      const next = new Map<string, Packet[]>()
      for (const [id, list] of current) {
        const running = list.filter((packet) => packet.doneAt > now)
        if (running.length > 0) next.set(id, running)
      }
      for (const [id, list] of fresh) next.set(id, [...(next.get(id) ?? []), ...list].slice(-MAX_PER_LINE))
      return next
    })
  }, [graph, live])

  // Once the last one has arrived, the lines go quiet again.
  useEffect(() => {
    const last = Math.max(0, ...[...packets.values()].flat().map((packet) => packet.doneAt))
    if (last === 0) return
    const timer = setTimeout(() => setPackets(new Map()), last - Date.now() + 50)
    return () => clearTimeout(timer)
  }, [packets])

  return packets
}
