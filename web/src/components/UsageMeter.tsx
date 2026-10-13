import { ago } from '../status'
import type { Usage } from '../types'
import { isStale, resetText, toneOf, windowsOf } from '../usage'

// Your plan's session and weekly use, as /usage shows them, amber near the limit and red at it.
export function UsageMeter({ usage, now }: { usage: Usage; now: number }) {
  const windows = windowsOf(usage, now)
  if (windows.length === 0) return null
  return (
    <section className="usage" aria-label="Plan usage">
      {windows.map(({ name, window }) => (
        <div key={name} className={`usage-row usage-${toneOf(window.percent)}`}>
          <span className="usage-name">{name}</span>
          <span className="usage-bar" role="meter" aria-label={`${name} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(window.percent)}>
            <span style={{ width: `${window.percent}%` }} />
          </span>
          <span className="usage-figure">{Math.round(window.percent)}%</span>
          <span className="usage-reset">{resetText(window.resetsAt, now)}</span>
        </div>
      ))}
      {isStale(usage, now) && <p className="usage-stale">As of {ago(usage.at, now)} ago, when a status line last ran</p>}
    </section>
  )
}
