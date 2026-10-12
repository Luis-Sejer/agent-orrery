import { useCallback, useEffect, useRef, useState } from 'react'

import type { View } from './types'

const VIEW_KEY = 'agent-orrery:view'
const CANVAS_KEY = 'agent-orrery:canvas'
const VIEWS: readonly View[] = ['graph', 'orrery', 'plans', 'memory']
const CANVASES: readonly View[] = ['graph', 'orrery']

function stored(key: string, allowed: readonly View[]): View {
  try {
    const value = localStorage.getItem(key)
    return allowed.find((view) => view === value) ?? 'graph'
  } catch {
    return 'graph'
  }
}

// The view you were on, remembered across reloads, and the canvas (Agents or Orrery) you used last,
// which is where jumping to an agent from Plans or Memory takes you.
export function useView() {
  const [view, setView] = useState<View>(() => stored(VIEW_KEY, VIEWS))
  const [firstCanvas] = useState(() => stored(CANVAS_KEY, CANVASES))
  const canvas = useRef(firstCanvas)

  useEffect(() => {
    if (CANVASES.includes(view)) canvas.current = view
    try {
      localStorage.setItem(VIEW_KEY, view)
      localStorage.setItem(CANVAS_KEY, canvas.current)
    } catch {
      // Storage can be off (private window); the view then resets on reload.
    }
  }, [view])

  const toCanvas = useCallback(() => setView((current) => (CANVASES.includes(current) ? current : canvas.current)), [])

  return { view, setView, toCanvas }
}
