import { useEffect, useState } from 'react'

import type { GraphSnapshot } from './types'

const EMPTY: GraphSnapshot = { nodes: [], messages: [] }
const CLOCK_MS = 5_000

export type Connection = 'connecting' | 'live' | 'reconnecting'

export function useGraph(): { graph: GraphSnapshot; connection: Connection } {
  const [graph, setGraph] = useState<GraphSnapshot>(EMPTY)
  const [connection, setConnection] = useState<Connection>('connecting')

  useEffect(() => {
    const source = new EventSource('/events')
    source.addEventListener('open', () => setConnection('live'))
    source.addEventListener('error', () => setConnection('reconnecting'))
    source.addEventListener('message', (event) => setGraph(JSON.parse(event.data) as GraphSnapshot))
    return () => source.close()
  }, [])

  return { graph, connection }
}

// Relative times ("3 min ago") need a clock that ticks even when no data arrives.
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

export async function getJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url)
  return response.ok ? ((await response.json()) as T) : null
}
