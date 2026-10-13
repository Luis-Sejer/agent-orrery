import { useEffect, useState, type CSSProperties } from 'react'

import { getJson } from '../useGraph'
import type { AgentNode, DayRow, Span } from '../types'
import { duration, startOfDay, waitedFor, waitedOnYou, waitSpans } from '../waits'

const REFRESH_MS = 30_000
const HOUR_MS = 3_600_000
// A record is a moment; drawn as a sliver at least this wide, so a short stretch of work still shows.
const MIN_SPAN_PERCENT = 0.4

interface DayViewProps {
  nodes: AgentNode[]
  now: number
  onSelectNode: (id: string) => void
}

function useDay(since: number): Map<string, DayRow> {
  const [rows, setRows] = useState(new Map<string, DayRow>())
  useEffect(() => {
    let cancelled = false
    const load = () =>
      getJson<DayRow[]>(`/api/day?since=${since}`).then((result) => {
        if (!cancelled) setRows(new Map((result ?? []).map((row) => [row.id, row])))
      })
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [since])
  return rows
}

const clock = (at: number) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

// Today's sessions, one row each, on a shared clock: when each one worked, when its subagents did, and
// when it sat waiting on you.
export function DayView({ nodes, now, onSelectNode }: DayViewProps) {
  const since = startOfDay(now)
  const day = useDay(since)
  const sessions = nodes.filter((node) => node.kind === 'session' && node.lastAt >= since)
  const firstOf = (node: AgentNode) => Math.min(...[node.lastAt, ...(day.get(node.id)?.runs ?? []).map(([start]) => start), ...waitSpans(node, now, since).map(([start]) => start)])
  const rows = sessions.map((node) => ({ node, first: firstOf(node) })).sort((a, b) => a.first - b.first)
  // From the hour of the day's first activity, so the morning before you started isn't empty track.
  const from = rows.length > 0 ? Math.floor(Math.min(...rows.map(({ first }) => first)) / HOUR_MS) * HOUR_MS : since
  const span = Math.max(now - from, HOUR_MS)
  const place = ([start, end]: Span): CSSProperties => ({
    left: `${((Math.max(start, from) - from) / span) * 100}%`,
    width: `${Math.max(MIN_SPAN_PERCENT, ((end - Math.max(start, from)) / span) * 100)}%`,
  })
  const hours: number[] = []
  for (let hour = from; hour <= now; hour += HOUR_MS) hours.push(hour)
  const waited = waitedOnYou(sessions, now, since)
  const longest = rows.map(({ node }) => ({ node, ms: waitedFor(node, now, since) })).sort((a, b) => b.ms - a.ms)[0]

  return (
    <section className="day" aria-labelledby="day-heading">
      <header className="day-header">
        <h1 id="day-heading" className="serif">
          Today
        </h1>
        <p className="lede">
          {rows.length === 0
            ? 'No sessions yet today.'
            : waited > 0
              ? `Something waited on you for ${duration(waited)} today, across ${rows.length} ${rows.length === 1 ? 'session' : 'sessions'}.${longest && longest.ms > 0 ? ` ${longest.node.label} waited longest: ${duration(longest.ms)}.` : ''}`
              : `${rows.length} ${rows.length === 1 ? 'session' : 'sessions'}, and none of them waited on you.`}
        </p>
        <ul className="day-key" aria-label="Key">
          <li className="key-work">Working</li>
          <li className="key-agents">Its subagents</li>
          <li className="key-you">Waiting on you</li>
        </ul>
      </header>

      {rows.length > 0 && (
        <div className="day-chart">
          <div className="day-hours" aria-hidden="true">
            {hours.map((hour) => (
              <span key={hour} style={{ left: `${((hour - from) / span) * 100}%` }}>
                {clock(hour)}
              </span>
            ))}
          </div>
          <ol className="day-rows">
            {rows.map(({ node }) => {
              const row = day.get(node.id)
              const waits = waitSpans(node, now, since)
              const total = waitedFor(node, now, since)
              return (
                <li key={node.id} className="day-row">
                  <button type="button" className="day-name" onClick={() => onSelectNode(node.id)}>
                    <strong>{node.label}</strong>
                    <span>
                      {node.room}
                      {total > 0 && `, waited ${duration(total)}`}
                    </span>
                  </button>
                  <div className="day-track" role="img" aria-label={`${node.label}: ${total > 0 ? `waited on you ${duration(total)}` : 'never waited on you'}`}>
                    {(row?.agentRuns ?? []).map((spanned) => (
                      <span key={`a${spanned[0]}`} className="day-span agents" style={place(spanned)} title={`Subagents, ${clock(spanned[0])}–${clock(spanned[1])}`} />
                    ))}
                    {(row?.runs ?? []).map((spanned) => (
                      <span key={`r${spanned[0]}`} className="day-span work" style={place(spanned)} title={`Working, ${clock(spanned[0])}–${clock(spanned[1])}`} />
                    ))}
                    {waits.map((spanned) => (
                      <span key={`w${spanned[0]}`} className="day-span you" style={place(spanned)} title={`Waited on you ${duration(spanned[1] - spanned[0])}, ${clock(spanned[0])}–${clock(spanned[1])}`} />
                    ))}
                  </div>
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </section>
  )
}
