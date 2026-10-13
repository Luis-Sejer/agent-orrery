import { useId, useState, type FocusEvent, type ReactNode } from 'react'

import type { Arrangement } from '../radial'
import { readNumberSetting, settingsAsEnv, writeSetting } from '../settings'
import type { Filter } from '../types'
import { THEMES, type ThemePreference } from '../useTheme'
import { Icon } from './Icon'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'running', label: 'Running' },
  { value: 'finished', label: 'Finished' },
]

export type AgentsLayout = 'rooms' | 'tree'

const AGENTS_LAYOUTS: { value: AgentsLayout; label: string }[] = [
  { value: 'rooms', label: 'Rooms' },
  { value: 'tree', label: 'Tree' },
]

const ARRANGEMENTS: { value: Arrangement; label: string }[] = [
  { value: 'status', label: 'By status' },
  { value: 'room', label: 'By repository' },
  { value: 'galaxy', label: 'Galaxy' },
]

interface Switch {
  supported: boolean
  enabled: boolean
  blocked?: boolean
  toggle: () => void
}

interface SettingsMenuProps {
  // Filters and the arrangement only mean something on a canvas, and the arrangement only in the orrery.
  onCanvas: boolean
  inOrrery: boolean
  inAgents: boolean
  agentsLayout: AgentsLayout
  onAgentsLayout: (layout: AgentsLayout) => void
  hideFinished: boolean
  onHideFinished: (on: boolean) => void
  filter: Filter
  onFilter: (filter: Filter) => void
  arrangement: Arrangement
  onArrange: (arrangement: Arrangement) => void
  replaying: boolean
  onReplay: () => void
  notifications: Switch
  voice: Switch
  pauseMotion: boolean
  onPauseMotion: (on: boolean) => void
  theme: ThemePreference
  onTheme: (theme: ThemePreference) => void
  clean: boolean
  onClean: (clean: boolean) => void
  worktreeRooms: boolean
  onWorktreeRooms: (on: boolean) => void
}

function Choice<T extends string>({ label, options, value, onChange }: { label: string; options: { value: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  return (
    <div className="setting">
      <span className="setting-label">{label}</span>
      <div className="tabs" role="group" aria-label={label}>
        {options.map((option) => (
          <button key={option.value} type="button" className={value === option.value ? 'on' : ''} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// The whole row toggles the switch, but only the name names it; the detail describes it. A blocked
// switch stays focusable, so its reason can still be heard.
function Toggle({ label, detail, on, disabled = false, onChange }: { label: string; detail?: ReactNode; on: boolean; disabled?: boolean; onChange: () => void }) {
  const id = useId()
  return (
    <label className="setting toggle">
      <span>
        <span className="setting-name" id={`${id}-name`}>
          {label}
        </span>
        {detail && <small id={`${id}-detail`}>{detail}</small>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={on}
        aria-labelledby={`${id}-name`}
        aria-describedby={detail ? `${id}-detail` : undefined}
        aria-disabled={disabled || undefined}
        onChange={disabled ? () => {} : onChange}
      />
    </label>
  )
}

// Light dismiss closes the popover on a click outside; tabbing out of it should close it too.
function hideWhenFocusLeaves(event: FocusEvent<HTMLDivElement>) {
  const next = event.relatedTarget
  if (next instanceof Node && !event.currentTarget.contains(next) && !(next instanceof Element && next.closest('.settings-button'))) event.currentTarget.hidePopover()
}

const COPIED_MS = 1_800

// The server's own settings, in whole hours, within the range the server accepts (NUMBER_SETTINGS in
// store.mjs). They apply to every browser at once.
const HOUR_SETTINGS = [
  { name: 'window-hours', label: 'Show agents from the last', detail: 'Agents with nothing newer drop off the canvas.', min: 1, max: 72, fallback: 6 },
  { name: 'waiting-hours', label: 'Keep a waiting session for', detail: 'How long a session waiting on you stays in Your turn.', min: 1, max: 168, fallback: 24 },
] as const

// Saved when you leave the field or press Enter, kept within its range; an empty field goes back.
function HourSetting({ name, label, detail, min, max, fallback }: (typeof HOUR_SETTINGS)[number]) {
  const id = useId()
  const [saved, setSaved] = useState(() => readNumberSetting(name, fallback))
  const [text, setText] = useState(String(saved))
  function commit() {
    const value = Number(text)
    if (!text.trim() || !Number.isFinite(value)) return setText(String(saved))
    const kept = Math.min(max, Math.max(min, Math.round(value)))
    setText(String(kept))
    if (kept === saved) return
    setSaved(kept)
    writeSetting(name, String(kept))
  }
  return (
    <div className="setting hours">
      <label htmlFor={id} className="setting-name">
        {label}
      </label>
      <span className="hours-field">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={text}
          aria-describedby={`${id}-detail`}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => event.key === 'Enter' && commit()}
        />
        hours
      </span>
      <small id={`${id}-detail`}>{detail}</small>
    </div>
  )
}

function AdvancedSettings() {
  return (
    <details className="advanced">
      <summary>Advanced</summary>
      {HOUR_SETTINGS.map((setting) => (
        <HourSetting key={setting.name} {...setting} />
      ))}
    </details>
  )
}

// These settings as .env lines, the defaults for a fresh install or another machine.
function CopyAsEnv() {
  const [copied, setCopied] = useState(false)
  async function copy() {
    await navigator.clipboard.writeText(`${settingsAsEnv()}\n`)
    setCopied(true)
    setTimeout(() => setCopied(false), COPIED_MS)
  }
  return (
    <div className="setting copy-env">
      <button type="button" className="link" onClick={copy}>
        {copied ? 'Copied' : 'Copy these settings for .env'}
      </button>
      <small>Settings are saved for every browser. Paste these into another install's .env to start it the same way.</small>
      <span className="visually-hidden" role="status">
        {copied ? 'Copied the settings' : ''}
      </span>
    </div>
  )
}

// Everything that isn't search or a view, behind one button, so the dashboard stays clean.
// A native popover: it opens over the page, closes on Escape or a click outside, and needs no state here.
export function SettingsMenu(props: SettingsMenuProps) {
  const { notifications, voice } = props
  // A dot on the button while a filter narrows what you see, so nothing is hidden silently.
  const narrowed = props.onCanvas && (props.filter !== 'all' || props.hideFinished)
  return (
    <>
      <button type="button" className={`icon-button settings-button${narrowed ? ' narrowed' : ''}`} popoverTarget="settings" aria-label="Settings" title="Settings">
        <Icon name="settings" />
        <span className="settings-text" aria-hidden="true">
          Settings
        </span>
      </button>
      <div id="settings" popover="auto" className="settings" role="dialog" aria-label="Settings" onBlur={hideWhenFocusLeaves}>
        {props.onCanvas && <Choice label="Show" options={FILTERS} value={props.filter} onChange={props.onFilter} />}
        {props.inOrrery && <Choice label="Arrange the orrery" options={ARRANGEMENTS} value={props.arrangement} onChange={props.onArrange} />}
        {props.inAgents && <Choice label="Lay out agents" options={AGENTS_LAYOUTS} value={props.agentsLayout} onChange={props.onAgentsLayout} />}
        <Choice label="Theme" options={THEMES} value={props.theme} onChange={props.onTheme} />
        <div className="setting-group">
          <Toggle label="Replay" detail="Scrub back through the last hours" on={props.replaying} onChange={props.onReplay} />
          {notifications.supported && (
            <Toggle
              label="Notifications"
              detail={notifications.blocked ? 'Blocked in your browser settings' : 'When a session starts waiting on you'}
              on={notifications.enabled}
              disabled={notifications.blocked}
              onChange={notifications.toggle}
            />
          )}
          {voice.supported && <Toggle label="Voice" detail="Says which session is waiting on you" on={voice.enabled} onChange={voice.toggle} />}
          {props.onCanvas && (
            <Toggle label="Hide finished" detail="Rooms and systems with nothing going on go too" on={props.hideFinished} onChange={() => props.onHideFinished(!props.hideFinished)} />
          )}
          {props.onCanvas && (
            <Toggle label="Worktrees as their own rooms" detail="Each worktree's branch gets a room" on={props.worktreeRooms} onChange={() => props.onWorktreeRooms(!props.worktreeRooms)} />
          )}
          <Toggle label="Clean view" detail="Only the canvas, with who's waiting on you in a corner" on={props.clean} onChange={() => props.onClean(!props.clean)} />
          <Toggle label="Pause motion" detail="Hold the rings, orbs and glows still" on={props.pauseMotion} onChange={() => props.onPauseMotion(!props.pauseMotion)} />
        </div>
        <AdvancedSettings />
        <CopyAsEnv />
      </div>
    </>
  )
}
