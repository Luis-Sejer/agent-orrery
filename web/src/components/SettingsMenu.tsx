import type { ReactNode } from 'react'

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
  theme: ThemePreference
  onTheme: (theme: ThemePreference) => void
  clean: boolean
  onClean: (clean: boolean) => void
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

function Toggle({ label, detail, on, disabled, onChange }: { label: string; detail?: ReactNode; on: boolean; disabled?: boolean; onChange: () => void }) {
  return (
    <label className="setting toggle">
      <span>
        <span className="setting-name">{label}</span>
        {detail && <small>{detail}</small>}
      </span>
      <input type="checkbox" role="switch" checked={on} disabled={disabled} onChange={onChange} />
    </label>
  )
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
      </button>
      <div id="settings" popover="auto" className="settings" role="dialog" aria-label="Settings">
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
          <Toggle label="Clean view" detail="Hide the side panel, minimap and zoom" on={props.clean} onChange={() => props.onClean(!props.clean)} />
        </div>
      </div>
    </>
  )
}
