import { useId, type FocusEvent, type ReactNode } from 'react'

import type { Arrangement } from '../radial'
import type { Filter } from '../types'
import { THEMES, type ThemePreference } from '../useTheme'
import { Icon } from './Icon'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'running', label: 'Running' },
  { value: 'finished', label: 'Finished' },
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

// Everything that isn't search or a view, behind one button, so the dashboard stays clean.
// A native popover: it opens over the page, closes on Escape or a click outside, and needs no state here.
export function SettingsMenu(props: SettingsMenuProps) {
  const { notifications, voice } = props
  // A dot on the button while a filter narrows what you see, so nothing is hidden silently.
  const narrowed = props.onCanvas && props.filter !== 'all'
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
            <Toggle label="Worktrees as their own rooms" detail="Each worktree's branch gets a room" on={props.worktreeRooms} onChange={() => props.onWorktreeRooms(!props.worktreeRooms)} />
          )}
          <Toggle label="Clean view" detail="Only the canvas, with who's waiting on you in a corner" on={props.clean} onChange={() => props.onClean(!props.clean)} />
          <Toggle label="Pause motion" detail="Hold the rings, orbs and glows still" on={props.pauseMotion} onChange={() => props.onPauseMotion(!props.pauseMotion)} />
        </div>
      </div>
    </>
  )
}
