import { useCallback, useEffect, useRef, useState } from 'react'

import type { Arrangement } from './radial'
import type { View } from './types'

const VIEW_KEY = 'agent-orrery:view'
const CANVAS_KEY = 'agent-orrery:canvas'
const VIEWS: readonly View[] = ['graph', 'orrery', 'plans', 'memory']
const CANVASES: readonly View[] = ['graph', 'orrery']
// The Orrery is where a first visit lands; Agents is the denser view for reading names and branches.
const DEFAULT_VIEW: View = 'orrery'

function stored(key: string, allowed: readonly View[]): View {
  try {
    const value = localStorage.getItem(key)
    return allowed.find((view) => view === value) ?? DEFAULT_VIEW
  } catch {
    return DEFAULT_VIEW
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

// A setting remembered across reloads. Storage can be off (private window); the setting then lasts
// until the page reloads.
function useStored<T extends string>(key: string, allowed: readonly T[]): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      return allowed.find((option) => option === localStorage.getItem(key)) ?? allowed[0]
    } catch {
      return allowed[0]
    }
  })
  const choose = useCallback(
    (next: T) => {
      setValue(next)
      try {
        localStorage.setItem(key, next)
      } catch {
        // Kept for this page only.
      }
    },
    [key],
  )
  return [value, choose]
}

// How the orrery is arranged: rings by status (the default), a ring per repository, or a galaxy of
// repositories, each a solar system of its own.
export const useArrangement = () => useStored<Arrangement>('agent-orrery:arrangement', ['status', 'room', 'galaxy'])

// The clean view hides the side panel, the minimap and the zoom buttons, for a dashboard on a wall.
export const useCleanView = () => useStored<'off' | 'on'>('agent-orrery:clean', ['off', 'on'])

// Worktrees fold into their repository unless you ask for a room per worktree.
export const useWorktreeRooms = () => useStored<'off' | 'on'>('agent-orrery:worktrees', ['off', 'on'])
