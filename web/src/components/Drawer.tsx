import { useContext, useEffect, useState, type CSSProperties } from 'react'

import { isArtifactUrl } from '../artifacts'
import { describeSpend, mergeUsage, modelOf } from '../pricing'
import { ago, describeStatus, orbStateOf, stateColour, statusOf } from '../status'
import { getJson } from '../useGraph'
import { HudContext } from '../useTheme'
import type { AgentNode, Collision, TimelineEvent } from '../types'
import { duration, startOfDay, waitedFor } from '../waits'
import { fileList } from './Inbox'
import { Orb } from './Orb'

const TIMELINE_REFRESH_MS = 3_000
const STATUS_RANK = { waiting: 0, running: 1, finished: 2 }
const COPIED_FEEDBACK_MS = 1_800

interface DrawerProps {
  node: AgentNode
  parent: AgentNode | null
  children: AgentNode[]
  // Collisions it is part of, with the other agent's node where it's in view.
  clashes: { collision: Collision; other: AgentNode | null }[]
  // Other sessions this session has talked with, and how many messages went between them.
  talkingWith: { node: AgentNode; count: number }[]
  now: number
  onClose: () => void
  onSelect: (id: string) => void
  onOpenPlan: (name: string) => void
  onDismiss?: (node: AgentNode) => void
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

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function Drawer({ node, parent, children, clashes, talkingWith, now, onClose, onSelect, onOpenPlan, onDismiss }: DrawerProps) {
  const events = useTimeline(node.id)
  const hud = useContext(HudContext)
  const [copied, setCopied] = useState(false)
  const sessionId = node.kind === 'session' ? node.id : node.sessionId
  const resumeCommand = sessionId ? `claude --resume ${sessionId}` : null

  async function copyResume() {
    if (!resumeCommand) return
    await navigator.clipboard.writeText(resumeCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
  }

  const ownSpend = describeSpend(node.usage)
  const totalSpend = children.length > 0 ? describeSpend(mergeUsage([node.usage, ...children.map((child) => child.usage)])) : null
  const models = [...new Set(Object.keys(node.usage).map(modelOf))]
  const waited = node.kind === 'session' ? waitedFor(node, now, startOfDay(now)) : 0

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
          {/* Focused when the drawer opens, so a keyboard or screen reader lands on what was opened. */}
          <h2 className="serif" tabIndex={-1}>
            {node.label}
          </h2>
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
        {(ownSpend || totalSpend) && (
          <>
            <dt>Cost</dt>
            <dd>
              {ownSpend ? capitalise(ownSpend) : 'None of its own'}
              {models.length > 1 && <small className="models">{models.join(', ')}</small>}
              {totalSpend && totalSpend !== ownSpend && <small className="models">With its subagents: {totalSpend}</small>}
            </dd>
          </>
        )}
        {talkingWith.length > 0 && (
          <>
            <dt>Talking with</dt>
            <dd>
              {talkingWith.map(({ node: other, count }) => (
                <span key={other.id} className="clash">
                  <button type="button" className="link" onClick={() => onSelect(other.id)}>
                    {other.label}
                  </button>{' '}
                  {count === 1 ? 'one message' : `${count} messages`}
                </span>
              ))}
            </dd>
          </>
        )}
        {clashes.length > 0 && (
          <>
            <dt className="why">Same files</dt>
            <dd>
              {clashes.map(({ collision, other }) => {
                const otherId = collision.a === node.id ? collision.b : collision.a
                return (
                  <span key={otherId} className="clash">
                    <button type="button" className="link" onClick={() => onSelect(otherId)}>
                      {other?.label ?? otherId}
                    </button>{' '}
                    also edited {fileList(collision.files)}, {ago(collision.at, now)} ago
                  </span>
                )
              })}
            </dd>
          </>
        )}
        {waited > 0 && (
          <>
            <dt>Waited on you</dt>
            <dd>{duration(waited)} today</dd>
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
            {onDismiss && statusOf(node, now) === 'waiting' && (
              <button type="button" className="button quiet" onClick={() => onDismiss(node)} title="Dismiss until it does something new">
                Dismiss
              </button>
            )}
          </div>
          <code className="command">{resumeCommand}</code>
          <span className="visually-hidden" role="status">
            {copied ? 'Copied the resume command' : ''}
          </span>
        </div>
      )}

      {(node.artifacts?.length ?? 0) > 0 && (
        <>
          <h3 className="serif">Artifacts</h3>
          <ul className="artifact-links">
            {node.artifacts!.filter(({ url }) => isArtifactUrl(url)).map((artifact) => (
              <li key={artifact.url}>
                <a href={artifact.url} target="_blank" rel="noopener noreferrer">
                  {artifact.title}
                </a>
                <time dateTime={new Date(artifact.at).toISOString()}>{ago(artifact.at, now)} ago</time>
              </li>
            ))}
          </ul>
        </>
      )}

      {children.length > 0 && (
        <>
          <h3 className="serif">Subagents</h3>
          <ol className="subagents">
            {[...children]
              .sort((a, b) => STATUS_RANK[statusOf(a, now)] - STATUS_RANK[statusOf(b, now)] || b.lastAt - a.lastAt)
              .map((child) => (
                <li key={child.id}>
                  <button type="button" onClick={() => onSelect(child.id)}>
                    <Orb state={orbStateOf(child, now)} size={20} seed={child.id} />
                    <span>
                      <strong>{child.label}</strong>
                      <span>
                        {[child.agentType, child.room].filter(Boolean).join(', ')}. {describeStatus(child, now)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
          </ol>
        </>
      )}

      <h3 className="serif">What it has done</h3>
      {events.length === 0 ? (
        <p className="empty-note">Nothing recorded yet.</p>
      ) : (
        <ol className="timeline">
          {collapseRuns(events).map((event, index) => (
            <li key={`${event.at}-${index}`} style={{ '--state': stateColour(event.activity, hud) } as CSSProperties}>
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
