// The page's settings and dismissals live on the server (store.mjs), shared by every browser; nothing
// is kept in the browser. The page starts from the state in a meta tag, saves each change back, and
// hears about changes made in other pages over the event stream.

export type Dismissals = Record<string, number>

export interface ServerState {
  // Defaults from the server's environment, for settings nobody has changed.
  defaults: Record<string, string>
  settings: Record<string, string>
  dismissals: Dismissals
}

let state: ServerState | null = null
const listeners = new Set<(state: ServerState) => void>()

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

// Only what has the right shape is taken: strings for settings, numbers for dismissals.
export function parseState(text: string | null | undefined): ServerState {
  let value: unknown = null
  try {
    value = JSON.parse(text ?? 'null')
  } catch {
    // A page served without its state (the dev server) starts from the built-in defaults.
  }
  const part = (key: string) => (isRecord(value) && isRecord(value[key]) ? Object.entries(value[key]) : [])
  return {
    defaults: Object.fromEntries(part('defaults').filter(([, setting]) => typeof setting === 'string')) as Record<string, string>,
    settings: Object.fromEntries(part('settings').filter(([, setting]) => typeof setting === 'string')) as Record<string, string>,
    dismissals: Object.fromEntries(part('dismissals').filter(([, at]) => typeof at === 'number' && Number.isFinite(at))) as Dismissals,
  }
}

export function serverState(): ServerState {
  state ??= parseState(document.querySelector<HTMLMetaElement>('meta[name="agent-orrery-state"]')?.content)
  return state
}

// A new state from the server, sent whenever any page changes something.
export function receiveState(next: ServerState) {
  state = next
  for (const listener of listeners) listener(next)
}

export function onStateChange(listener: (state: ServerState) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// A change is kept on this page at once; if the server can't be reached it lasts until a reload.
async function send(path: string, body: unknown) {
  try {
    const response = await fetch(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) console.warn(`agent-orrery: the server refused to save (${response.status})`)
  } catch {
    console.warn('agent-orrery: could not reach the server to save')
  }
}

export function readSetting<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const { settings, defaults } = serverState()
  return allowed.find((value) => value === settings[name]) ?? allowed.find((value) => value === defaults[name]) ?? fallback
}

export function writeSetting(name: string, value: string) {
  const current = serverState()
  if (current.settings[name] === value) return
  state = { ...current, settings: { ...current.settings, [name]: value } }
  void send('/api/settings', { [name]: value })
}

export function addDismissal(id: string, lastAt: number) {
  const current = serverState()
  state = { ...current, dismissals: { ...current.dismissals, [id]: lastAt } }
  void send('/api/dismissals', { add: { [id]: lastAt } })
}

export function clearDismissals() {
  state = { ...serverState(), dismissals: {} }
  void send('/api/dismissals', { clear: true })
}

const OLD_PREFIX = 'agent-orrery:'
const OLD_DISMISSALS = 'dismissed'

// Settings and dismissals used to live in the browser. The first page to find any moves them to the
// server, where none is set yet, and deletes them from the browser. Runs before the first render.
export function moveOldSettings() {
  try {
    const keys = Object.keys(localStorage).filter((key) => key.startsWith(OLD_PREFIX))
    if (keys.length === 0) return
    const current = serverState()
    const settings: Record<string, string> = {}
    let dismissals: Dismissals = {}
    for (const key of keys) {
      const name = key.slice(OLD_PREFIX.length)
      const value = localStorage.getItem(key) ?? ''
      // parseState drops anything malformed, so one bad value can't stop the move and have it retried forever.
      if (name === OLD_DISMISSALS) dismissals = parseState(`{"dismissals":${value}}`).dismissals
      else if (!name.includes(':') && current.settings[name] === undefined) settings[name] = value
    }
    // The server keeps only names and values it knows; the page takes them as the server will.
    state = { ...current, settings: { ...settings, ...current.settings }, dismissals: { ...dismissals, ...current.dismissals } }
    if (Object.keys(settings).length > 0) void send('/api/settings', settings)
    if (Object.keys(dismissals).length > 0) void send('/api/dismissals', { add: dismissals })
    for (const key of keys) localStorage.removeItem(key)
  } catch {
    // No storage to move (a private window), or a value that won't parse: nothing to carry over.
  }
}

// The setting names, as the server's environment calls them (SETTINGS in store.mjs).
export const SETTING_ENV: Record<string, string> = {
  view: 'AGENT_ORRERY_VIEW',
  arrangement: 'AGENT_ORRERY_ARRANGEMENT',
  theme: 'AGENT_ORRERY_THEME',
  'agents-layout': 'AGENT_ORRERY_AGENTS_LAYOUT',
  'hide-finished': 'AGENT_ORRERY_HIDE_FINISHED',
  worktrees: 'AGENT_ORRERY_WORKTREE_ROOMS',
  clean: 'AGENT_ORRERY_CLEAN_VIEW',
  still: 'AGENT_ORRERY_PAUSE_MOTION',
  voice: 'AGENT_ORRERY_VOICE',
  notifications: 'AGENT_ORRERY_NOTIFICATIONS',
}

// The current settings as .env lines: the defaults for a fresh install, or another machine.
export function settingsAsEnv(): string {
  const { settings, defaults } = serverState()
  return Object.entries(SETTING_ENV)
    .map(([name, variable]) => `${variable}=${settings[name] ?? defaults[name] ?? ''}`)
    .join('\n')
}
