import { useCallback, useEffect, useRef, useState } from 'react'

import type { GraphSnapshot } from './types'
import { getJson } from './useGraph'

const DEBOUNCE_MS = 150
const PLAY_TICK_MS = 100
// About ten minutes of history per second of play.
const PLAY_STEP_MS = 60_000
const DEFAULT_WINDOW_MS = 6 * 3_600_000

export interface ReplayView {
  at: number
  graph: GraphSnapshot
}

// `view` is the snapshot together with the time it is for, so statuses and "ago" texts
// always agree with the graph on screen, even while a newer one is still being fetched.
export function useReplay() {
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState(() => Date.now())
  const [playing, setPlaying] = useState(false)
  const [windowMs, setWindowMs] = useState(DEFAULT_WINDOW_MS)
  const [view, setView] = useState<ReplayView | null>(null)
  const latest = useRef(at)
  latest.current = at

  useEffect(() => {
    if (!open) return
    getJson<{ windowMs: number }>('/api/window').then((result) => result && setWindowMs(result.windowMs))
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const timer = setTimeout(() => {
      getJson<GraphSnapshot>(`/api/replay?at=${Math.round(at)}`).then((graph) => {
        if (!cancelled && graph) setView({ at, graph })
      })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, at])

  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      const next = Math.min(Date.now(), latest.current + PLAY_STEP_MS)
      setAt(next)
      if (next >= Date.now()) setPlaying(false)
    }, PLAY_TICK_MS)
    return () => clearInterval(timer)
  }, [playing])

  const start = useCallback(() => {
    setAt(Date.now() - 60 * 60_000)
    setOpen(true)
  }, [])
  const stop = useCallback(() => {
    setOpen(false)
    setPlaying(false)
    setView(null)
  }, [])
  const seek = useCallback((time: number) => {
    setPlaying(false)
    setAt(time)
  }, [])
  const togglePlay = useCallback(() => {
    // Pressing play at the end starts again from the beginning of the window.
    if (!playing && Date.now() - latest.current < PLAY_STEP_MS) setAt(Date.now() - windowMs)
    setPlaying((value) => !value)
  }, [playing, windowMs])

  return { open, at, playing, windowMs, view, start, stop, seek, togglePlay }
}
