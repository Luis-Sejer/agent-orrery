import { createContext, useCallback, useEffect, useState } from 'react'

// T.Y.C.H.O. is a HUD look laid over the dark theme: <html> gets data-theme="dark" and data-hud.
export type ThemePreference = 'system' | 'light' | 'dark' | 'tycho'
export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'agent-orrery:theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'
export const NEXT: Record<ThemePreference, ThemePreference> = { system: 'light', light: 'dark', dark: 'tycho', tycho: 'system' }

// Orbs pick their colours from this, so they turn neon under the HUD.
export const HudContext = createContext(false)

export function parsePreference(value: string | null): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'tycho' ? value : 'system'
}

function storedPreference(): ThemePreference {
  try {
    return parsePreference(localStorage.getItem(STORAGE_KEY))
  } catch {
    return 'system'
  }
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  if (preference === 'tycho') return 'dark'
  if (preference !== 'system') return preference
  return systemDark ? 'dark' : 'light'
}

function apply(preference: ThemePreference, systemDark: boolean) {
  const root = document.documentElement
  root.dataset.theme = resolveTheme(preference, systemDark)
  root.toggleAttribute('data-hud', preference === 'tycho')
}

// Called before the first render, so the page never flashes the wrong theme.
export function applyStoredTheme() {
  apply(storedPreference(), matchMedia(DARK_QUERY).matches)
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(storedPreference)
  const [systemDark, setSystemDark] = useState(() => matchMedia(DARK_QUERY).matches)

  useEffect(() => {
    const query = matchMedia(DARK_QUERY)
    const onChange = () => setSystemDark(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  useEffect(() => apply(preference, systemDark), [preference, systemDark])

  const cycle = useCallback(() => {
    setPreference((current) => {
      const next = NEXT[current]
      try {
        localStorage.setItem(STORAGE_KEY, next)
      } catch {
        // Storage can be off (private window); the choice then lasts until the page reloads.
      }
      return next
    })
  }, [])

  return { preference, theme: resolveTheme(preference, systemDark), hud: preference === 'tycho', cycle, next: NEXT[preference] }
}
