import { useCallback, useEffect, useRef, useState } from 'react'

import type { Arrangement } from './radial'
import { readSetting, writeSetting } from './settings'
import type { View } from './types'

const VIEW_KEY = 'view'
const CANVAS_KEY = 'canvas'
const VIEWS: readonly View[] = ['graph', 'orrery', 'day', 'plans', 'memory']
const CANVASES: readonly View[] = ['graph', 'orrery']
// The Orrery is where a first visit lands; Agents is the denser view for reading names and branches.
const DEFAULT_VIEW: View = 'orrery'

const stored = (key: string, allowed: readonly View[]) => readSetting(key, allowed, DEFAULT_VIEW)

// The view you were on, remembered across reloads, and the canvas (Agents or Orrery) you used last,
// which is where jumping to an agent from Plans or Memory takes you.
export function useView() {
  const [view, setView] = useState<View>(() => stored(VIEW_KEY, VIEWS))
  const [firstCanvas] = useState(() => stored(CANVAS_KEY, CANVASES))
  const canvas = useRef(firstCanvas)

  // Saved only when it changes, so opening the page never pins a default from .env.
  const shown = useRef(view)
  useEffect(() => {
    if (shown.current === view) return
    shown.current = view
    if (CANVASES.includes(view)) canvas.current = view
    writeSetting(VIEW_KEY, view)
    writeSetting(CANVAS_KEY, canvas.current)
  }, [view])

  const toCanvas = useCallback(() => setView((current) => (CANVASES.includes(current) ? current : canvas.current)), [])

  return { view, setView, toCanvas }
}

// A setting remembered across reloads; the first option is the built-in default.
function useStored<T extends string>(name: string, allowed: readonly T[]): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => readSetting(name, allowed, allowed[0]))
  const choose = useCallback(
    (next: T) => {
      setValue(next)
      writeSetting(name, next)
    },
    [name],
  )
  return [value, choose]
}

// How the orrery is arranged: rings by status (the default), a ring per repository, or a galaxy of
// repositories, each a solar system of its own.
export const useArrangement = () => useStored<Arrangement>('arrangement', ['status', 'room', 'galaxy'])

// The clean view hides the side panel, the minimap and the zoom buttons, for a dashboard on a wall.
export const useCleanView = () => useStored<'off' | 'on'>('clean', ['off', 'on'])

// Worktrees fold into their repository unless you ask for a room per worktree.
export const useWorktreeRooms = () => useStored<'off' | 'on'>('worktrees', ['off', 'on'])

// Pause motion holds every ring, orb, beam and glide still, as reduced motion does, for anyone who
// wants a still page without changing their system setting.
export const usePauseMotion = () => useStored<'off' | 'on'>('still', ['off', 'on'])

// Finished agents off the canvas, and with them every room or system that has nothing going on.
export const useHideFinished = () => useStored<'off' | 'on'>('hide-finished', ['off', 'on'])

// Agents as rooms of cards (the default), or as a tree of who started whom.
export const useAgentsLayout = () => useStored<'rooms' | 'tree'>('agents-layout', ['rooms', 'tree'])
