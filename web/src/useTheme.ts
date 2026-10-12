import { useCallback, useEffect, useState } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'agent-orrery:theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'
const NEXT: Record<ThemePreference, ThemePreference> = { system: 'light', light: 'dark', dark: 'system' }

function storedPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

function resolve(preference: ThemePreference, systemDark: boolean): Theme {
  if (preference !== 'system') return preference
  return systemDark ? 'dark' : 'light'
}

// Called before the first render, so the page never flashes the wrong theme.
export function applyStoredTheme() {
  document.documentElement.dataset.theme = resolve(storedPreference(), matchMedia(DARK_QUERY).matches)
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(storedPreference)
  const [systemDark, setSystemDark] = useState(() => matchMedia(DARK_QUERY).matches)
  const theme = resolve(preference, systemDark)

  useEffect(() => {
    const query = matchMedia(DARK_QUERY)
    const onChange = () => setSystemDark(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

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

  return { preference, theme, cycle, next: NEXT[preference] }
}
