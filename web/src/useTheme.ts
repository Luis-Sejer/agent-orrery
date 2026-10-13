import { createContext, useCallback, useEffect, useState } from 'react'

import { readSetting, writeSetting } from './settings'

// T.Y.C.H.O. is a HUD look laid over the dark theme: <html> gets data-theme="dark" and data-hud.
export type ThemePreference = 'system' | 'light' | 'dark' | 'tycho'
export type Theme = 'light' | 'dark'

const SETTING = 'theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'
export const THEMES: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'tycho', label: 'T.Y.C.H.O.' },
]

// Orbs pick their colours from this, so they turn neon under the HUD.
export const HudContext = createContext(false)

export function parsePreference(value: string | null): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'tycho' ? value : 'system'
}

const storedPreference = () => readSetting<ThemePreference>(SETTING, ['system', 'light', 'dark', 'tycho'], 'system')

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

  const choose = useCallback((next: ThemePreference) => {
    setPreference(next)
    writeSetting(SETTING, next)
  }, [])

  return { preference, theme: resolveTheme(preference, systemDark), hud: preference === 'tycho', choose }
}
