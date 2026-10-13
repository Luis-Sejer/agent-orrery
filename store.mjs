// Agent Orrery's own state: the page's settings and the sessions you dismissed, shared by every
// browser. Kept in one JSON file in its data folder (AGENT_ORRERY_DATA_DIR), the only place it writes.
// Only known settings with known values, and dismissals of a sane size, are ever kept.

import { mkdirSync, readFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ON_OFF = ['on', 'off']
// Each setting, the environment variable that gives its default, and the values it may take.
export const SETTINGS = {
  view: ['AGENT_ORRERY_VIEW', ['orrery', 'graph', 'day', 'plans', 'memory']],
  // The canvas you used last (Agents or Orrery), where jumping to an agent takes you.
  canvas: [null, ['orrery', 'graph']],
  arrangement: ['AGENT_ORRERY_ARRANGEMENT', ['status', 'room', 'galaxy']],
  theme: ['AGENT_ORRERY_THEME', ['system', 'light', 'dark', 'tycho']],
  'agents-layout': ['AGENT_ORRERY_AGENTS_LAYOUT', ['rooms', 'tree']],
  'hide-finished': ['AGENT_ORRERY_HIDE_FINISHED', ON_OFF],
  worktrees: ['AGENT_ORRERY_WORKTREE_ROOMS', ON_OFF],
  clean: ['AGENT_ORRERY_CLEAN_VIEW', ON_OFF],
  still: ['AGENT_ORRERY_PAUSE_MOTION', ON_OFF],
  voice: ['AGENT_ORRERY_VOICE', ON_OFF],
  notifications: ['AGENT_ORRERY_NOTIFICATIONS', ON_OFF],
}

const STATE_FILE = 'state.json'
// A dismissal outlives the session's window by far; after a week it's of no use.
const FORGET_DISMISSAL_MS = 7 * 24 * 3_600_000
const MAX_DISMISSALS = 2_000
const MAX_ID_LENGTH = 200

// Defaults for settings nobody has changed yet, from the environment (.env with Docker).
export function settingDefaults(env = process.env) {
  const defaults = {}
  for (const [name, [variable, allowed]] of Object.entries(SETTINGS)) if (variable && allowed.includes(env[variable])) defaults[name] = env[variable]
  return defaults
}

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value)

// The known settings in `value`, with known values; everything else is dropped.
export function cleanSettings(value) {
  if (!isObject(value)) return {}
  return Object.fromEntries(Object.entries(value).filter(([name, setting]) => Object.hasOwn(SETTINGS, name) && SETTINGS[name][1].includes(setting)))
}

// Session id → its last activity when dismissed, for ids and times that look right and aren't stale.
export function cleanDismissals(value, now = Date.now()) {
  if (!isObject(value)) return {}
  const kept = Object.entries(value).filter(([id, at]) => id.length <= MAX_ID_LENGTH && Number.isFinite(at) && at >= now - FORGET_DISMISSAL_MS)
  return Object.fromEntries(kept.sort((a, b) => b[1] - a[1]).slice(0, MAX_DISMISSALS))
}

function readState(path) {
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8'))
    return { settings: cleanSettings(stored.settings), dismissals: cleanDismissals(stored.dismissals) }
  } catch {
    return { settings: {}, dismissals: {} }
  }
}

export function createStore({ dir, defaults = {} }) {
  const path = dir && join(dir, STATE_FILE)
  let state = path ? readState(path) : { settings: {}, dismissals: {} }
  let writable = !!dir
  try {
    if (dir) mkdirSync(dir, { recursive: true })
  } catch {
    writable = false
  }
  if (!writable) console.warn('agent-orrery: no data folder to write to; settings last until the server restarts')
  // One write at a time, each to a new file renamed over the old, so a crash never leaves half a file.
  let writing = Promise.resolve()
  const persist = () => {
    if (!writable) return writing
    const text = JSON.stringify(state)
    writing = writing
      .then(async () => {
        await writeFile(`${path}.tmp`, text)
        await rename(`${path}.tmp`, path)
      })
      .catch((error) => console.error('agent-orrery: could not save settings', error.message))
    return writing
  }

  return {
    // What the page starts from: the defaults and what has been chosen since.
    get: () => ({ defaults, settings: state.settings, dismissals: state.dismissals }),
    // Merges in the settings a page changed; unknown names and values are ignored.
    changeSettings(change) {
      state = { ...state, settings: { ...state.settings, ...cleanSettings(change) } }
      return persist()
    },
    // { add: { id: lastAt } } dismisses sessions; { clear: true } brings them all back.
    changeDismissals(change, now = Date.now()) {
      const added = isObject(change) ? cleanDismissals(change.add, now) : {}
      const base = isObject(change) && change.clear === true ? {} : state.dismissals
      state = { ...state, dismissals: cleanDismissals({ ...base, ...added }, now) }
      return persist()
    },
  }
}
