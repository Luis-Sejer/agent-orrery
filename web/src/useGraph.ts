import { useEffect, useState } from 'react'

import { parseState, receiveState } from './settings'
import type { GraphSnapshot } from './types'

const EMPTY: GraphSnapshot = { nodes: [], messages: [] }
const CLOCK_MS = 5_000

export type Connection = 'connecting' | 'live' | 'reconnecting'

export function useGraph(): { graph: GraphSnapshot; connection: Connection; loaded: boolean } {
  const [graph, setGraph] = useState<GraphSnapshot>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [connection, setConnection] = useState<Connection>('connecting')

  useEffect(() => {
    const source = new EventSource('/events')
    source.addEventListener('open', () => setConnection('live'))
    source.addEventListener('error', () => setConnection('reconnecting'))
    source.addEventListener('message', (event) => {
      setGraph(JSON.parse(event.data) as GraphSnapshot)
      setLoaded(true)
    })
    // Settings and dismissals changed in another page, or while this one was disconnected.
    source.addEventListener('state', (event) => receiveState(parseState(event.data)))
    return () => source.close()
  }, [])

  return { graph, connection, loaded }
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
