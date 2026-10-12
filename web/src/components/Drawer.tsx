import { useEffect, useState, type CSSProperties } from 'react'

import { STATE_COLOURS, ago, describeStatus, orbStateOf, statusOf } from '../status'
import { getJson } from '../useGraph'
import type { AgentNode, TimelineEvent } from '../types'
import { Orb } from './Orb'

const TIMELINE_REFRESH_MS = 3_000
const COPIED_FEEDBACK_MS = 1_800

interface DrawerProps {
  node: AgentNode
  parent: AgentNode | null
  now: number
  onClose: () => void
  onSelect: (id: string) => void
  onOpenPlan: (name: string) => void
  onDismiss: (node: AgentNode) => void
}

function useTimeline(id: string): TimelineEvent[] {
  const [events, setEvents] = useState<TimelineEvent[]>([])
  useEffect(() => {
    let cancelled = false
    const load = () =>
      getJson<TimelineEvent[]>(`/api/timeline?id=${encodeURIComponent(id)}`).then((result) => {
        if (!cancelled) setEvents(result ?? [])
      })
    load()
    const timer = setInterval(load, TIMELINE_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [id])
  return events
}

interface TimelineRow extends TimelineEvent {
  times: number
}

// A run of the same step ("Ran a command" nine times) reads better as one line with a count.
function collapseRuns(events: TimelineEvent[]): TimelineRow[] {
  const rows: TimelineRow[] = []
  const newestFirst = [...events].sort((a, b) => b.at - a.at)
  for (const event of newestFirst) {
    const previous = rows.at(-1)
    if (previous && previous.text === event.text && previous.repo === event.repo) previous.times += 1
    else rows.push({ ...event, times: 1 })
  }
  return rows
}

function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function Drawer({ node, parent, now, onClose, onSelect, onOpenPlan, onDismiss }: DrawerProps) {
  const events = useTimeline(node.id)
  const [copied, setCopied] = useState(false)
  const sessionId = node.kind === 'session' ? node.id : node.sessionId
  const resumeCommand = sessionId ? `claude --resume ${sessionId}` : null

  async function copyResume() {
    if (!resumeCommand) return
    await navigator.clipboard.writeText(resumeCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
  }

  return (
    <aside className="drawer" aria-label={`Details for ${node.label}`}>
      <button type="button" className="close" onClick={onClose} aria-label="Close details">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
      <header>
        <Orb state={orbStateOf(node, now)} size={64} ring={node.kind === 'session'} />
        <div>
          <h3 className="serif">{node.label}</h3>
          <p className="meta">{describeStatus(node, now)}</p>
        </div>
      </header>

      <dl className="facts">
        {node.kind !== 'session' && parent && (
          <>
            <dt>Started by</dt>
            <dd>
              <button type="button" className="link" onClick={() => onSelect(parent.id)}>
                {parent.label}
              </button>
            </dd>
          </>
        )}
        {node.agentType && (
          <>
            <dt>Agent</dt>
            <dd>
              {node.agentType}
              {node.model && `, ${node.model}`}
            </dd>
          </>
        )}
        {node.home && (
          <>
            <dt>Started in</dt>
            <dd>
              {node.home}
              {node.branch && <span className="branch">{node.branch}</span>}
            </dd>
          </>
        )}
        {node.repos.length > 0 && (
          <>
            <dt>Worked in</dt>
            <dd className="chips">
              {node.repos.map((repo) => (
                <span key={repo} className="chip">
                  {repo}
                </span>
              ))}
            </dd>
          </>
        )}
        {node.plans.length > 0 && (
          <>
            <dt>Plans</dt>
            <dd className="chips">
              {node.plans.map((plan) => (
                <button key={plan} type="button" className="chip chip-link" onClick={() => onOpenPlan(plan)}>
                  {plan.replace(/\.md$/, '')}
                </button>
              ))}
            </dd>
          </>
        )}
      </dl>

      {resumeCommand && (
        <div className="actions">
          <div className="action-row">
            <button type="button" className="button primary" onClick={copyResume}>
              {copied ? 'Copied' : 'Copy resume command'}
            </button>
            {statusOf(node, now) === 'waiting' && (
              <button type="button" className="button quiet" onClick={() => onDismiss(node)} title="Dismiss until it does something new">
                Dismiss
              </button>
            )}
          </div>
          <code className="command">{resumeCommand}</code>
        </div>
      )}

      <h4 className="serif">What it has done</h4>
      {events.length === 0 ? (
        <p className="empty-note">Nothing recorded yet.</p>
      ) : (
        <ol className="timeline">
          {collapseRuns(events).map((event, index) => (
            <li key={`${event.at}-${index}`} style={{ '--state': STATE_COLOURS[event.activity] } as CSSProperties}>
              <span className="dot" aria-hidden="true" />
              <span>
                {event.text}
                {event.times > 1 && <span className="times">× {event.times}</span>}
                {event.repo && <small>{event.repo}</small>}
              </span>
              <time dateTime={new Date(event.at).toISOString()} title={`${ago(event.at, now)} ago`}>
                {clockTime(event.at)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </aside>
  )
}
