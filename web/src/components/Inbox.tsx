import { useEffect, useId, useRef, type ReactNode } from 'react'

import { describeSpend, mergeUsage } from '../pricing'
import { ago, describeStatus, isFreshWait, isQuiet, orbStateOf, statusOf, verbFor, waitingLine } from '../status'
import type { Connection } from '../useGraph'
import type { AgentNode, Collision, Usage } from '../types'
import { beamStyle } from '../rhythm'
import { duration, startOfDay, waitedOnYou } from '../waits'
import { Orb } from './Orb'
import { UsageMeter } from './UsageMeter'
import { useInboxSection } from '../useView'
import { Wordmark } from './Wordmark'

const RUNNING_SHOWN = 8
const RESTORE = 'restore'

interface InboxProps {
  nodes: AgentNode[]
  collisions: Collision[]
  usage: Usage | null
  now: number
  connection: Connection | 'replay'
  selectedId: string | null
  dismissedCount: number
  onSelect: (id: string) => void
  // Absent while replaying: a replayed session is a copy from the past, with nothing to dismiss.
  onDismiss?: (node: AgentNode) => void
  onRestoreDismissed: () => void
  onRestore?: (node: AgentNode) => void
}

const COUNT_WORDS = ['No agents are', 'One agent is', 'Two agents are', 'Three agents are', 'Four agents are', 'Five agents are']

function waitingLede(count: number): string {
  return `${COUNT_WORDS[count] ?? `${count} agents are`} waiting on you.`
}

const CONNECTION_LABELS = { connecting: 'Reconnecting', reconnecting: 'Reconnecting', live: 'Live', replay: 'Replay' }

// "cart.ts", "cart.ts and api.ts", "cart.ts and 3 more"
export function fileList(files: string[]): string {
  if (files.length <= 2) return files.join(' and ')
  return `${files[0]} and ${files.length - 1} more`
}

// Listed under Quiet already, so the line says what is open, or how long it has been silent.
function quietLine(node: AgentNode, now: number): string {
  return node.pendingTool ? describeStatus(node, now) : `Silent for ${ago(node.lastAt, now)}`
}

export function waitingOn(nodes: AgentNode[], now: number): AgentNode[] {
  return nodes.filter((node) => statusOf(node, now) === 'waiting').sort((a, b) => (a.waiting?.since ?? 0) - (b.waiting?.since ?? 0))
}

const beamClass = (node: AgentNode, now: number) => (isFreshWait(node, now) ? 'beam fresh' : 'beam')

// Unarchiving takes a row away; focus moves to the next archived agent, or to the section's heading.
function useFocusAfterUnarchive(archived: AgentNode[], onRestore?: (node: AgentNode) => void) {
  const next = useRef<string | null>(null)
  useEffect(() => {
    if (!next.current) return
    const target = next.current
    next.current = null
    const row = document.querySelector<HTMLElement>(`.inbox [data-archived="${CSS.escape(target)}"]`)
    if (row) return row.focus()
    // The last one gone takes the section with it; the heading above it is the nearest place left.
    const toggles = [...document.querySelectorAll<HTMLElement>('.inbox .section-toggle')]
    ;(toggles.find((toggle) => toggle.textContent?.startsWith('Archived')) ?? toggles.at(-1))?.focus()
  })
  if (!onRestore) return undefined
  return (node: AgentNode) => {
    const at = archived.indexOf(node)
    next.current = (archived[at + 1] ?? archived[at - 1])?.id ?? 'heading'
    onRestore(node)
  }
}

// Dismissing a card takes its buttons away; focus moves to the next card, or to "Show dismissed".
function useFocusAfterDismiss(waiting: AgentNode[], onDismiss?: (node: AgentNode) => void) {
  const next = useRef<string | null>(null)
  useEffect(() => {
    if (!next.current) return
    const selector = next.current === RESTORE ? '.inbox .restore' : `.inbox .turn[data-id="${CSS.escape(next.current)}"]`
    next.current = null
    document.querySelector<HTMLElement>(selector)?.focus()
  })
  if (!onDismiss) return undefined
  return (node: AgentNode) => {
    const at = waiting.indexOf(node)
    next.current = (waiting[at + 1] ?? waiting[at - 1])?.id ?? RESTORE
    onDismiss(node)
  }
}

interface SectionProps {
  // Saved as inbox-<name>: open unless you fold it.
  name: string
  title: string
  count: number
  // Your turn is the panel's main heading; the rest sit under it.
  level?: 1 | 2
  headingClass: string
  children: ReactNode
}

// A section of the side panel that folds away under its heading, with its count still showing.
function Section({ name, title, count, level = 2, headingClass, children }: SectionProps) {
  const [open, setOpen] = useInboxSection(name)
  const id = useId()
  const Heading = level === 1 ? 'h1' : 'h2'
  const expanded = open === 'open'
  return (
    <section className="inbox-section" aria-labelledby={`${id}-title`}>
      <Heading className={headingClass}>
        <button type="button" id={`${id}-title`} className="section-toggle" aria-expanded={expanded} aria-controls={`${id}-body`} onClick={() => setOpen(expanded ? 'closed' : 'open')}>
          <span>{title}</span>
          {count > 0 && <span className="section-count">{count}</span>}
          <svg className="section-chevron" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </Heading>
      <div id={`${id}-body`} hidden={!expanded}>
        {children}
      </div>
    </section>
  )
}

export function Inbox({ nodes, collisions, usage, now, connection, selectedId, dismissedCount, onSelect, onDismiss, onRestoreDismissed, onRestore }: InboxProps) {
  const waiting = waitingOn(nodes, now)
  const runningNow = nodes
    .filter((node) => node.kind !== 'peer' && statusOf(node, now) === 'running')
    .sort((a, b) => b.lastAt - a.lastAt)
  const running = runningNow.filter((node) => !isQuiet(node, now))
  const quiet = runningNow.filter((node) => isQuiet(node, now))
  const spend = describeSpend(mergeUsage(nodes.map((node) => node.usage)))
  const dismiss = useFocusAfterDismiss(waiting, onDismiss)
  const waited = waitedOnYou(nodes, now, startOfDay(now))
  // Finished and archived. A subagent archived with its session goes in the session's row.
  const isArchived = (node: AgentNode) => !!node.archived && statusOf(node, now) === 'finished'
  const archivedIds = new Set(nodes.filter(isArchived).map((node) => node.id))
  const archived = nodes.filter((node) => isArchived(node) && !(node.kind === 'subagent' && node.sessionId && archivedIds.has(node.sessionId))).sort((a, b) => b.lastAt - a.lastAt)
  const helpersOf = (session: AgentNode) => nodes.filter((node) => node.kind === 'subagent' && node.sessionId === session.id && archivedIds.has(node.id)).length
  const unarchive = useFocusAfterUnarchive(archived, onRestore)
  const labelOf = new Map(nodes.map((node) => [node.id, node.label]))

  return (
    <aside className="inbox" aria-label="Your turn">
      {/* The top stays put: who you are, whether it's live, and how much of your plan is left. */}
      <div className="inbox-fixed">
        <div className="inbox-top">
          <Wordmark />
          <span className={`connection connection-${connection}`} role="status">
            {CONNECTION_LABELS[connection]}
          </span>
        </div>
        {usage && <UsageMeter usage={usage} now={now} />}
      </div>

      <div className="inbox-scroll">
        <Section name="turn" title="Your turn" count={waiting.length} level={1} headingClass="serif">
          <p className="lede" role="status">
            {waitingLede(waiting.length)}
          </p>
          <ol className="turns">
            {waiting.map((node) => (
              <li key={node.id} className="turn-item">
                <button
                  type="button"
                  data-id={node.id}
                  className={`turn ${beamClass(node, now)}${node.id === selectedId ? ' selected' : ''}`}
                  style={beamStyle(node.id)}
                  onClick={() => onSelect(node.id)}
                >
                  <Orb state="listening" size={20} seed={node.id} />
                  <strong className="serif">{node.label}</strong>
                  <span className="where">
                    {node.room && (
                      <span className="repo-name" title={node.room}>
                        {node.room}
                      </span>
                    )}
                    {node.branch && <span className="branch">{node.branch}</span>}
                  </span>
                  <span className="why">{waitingLine(node, now)}</span>
                </button>
                {dismiss && (
                  <button type="button" className="dismiss" aria-label={`Dismiss ${node.label}`} title="Dismiss until it does something new" onClick={() => dismiss(node)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M7 7l10 10M17 7L7 17" />
                    </svg>
                  </button>
                )}
              </li>
            ))}
          </ol>
          {dismissedCount > 0 && (
            <button type="button" className="link restore" onClick={onRestoreDismissed}>
              Show {dismissedCount} dismissed
            </button>
          )}
        </Section>

        {/* Agents editing the same files may be undoing each other's work: worth a look before anything else. */}
        {collisions.length > 0 && (
          <Section name="same" title="Same files" count={collisions.length} headingClass="clash-heading">
            <ol className="running clash-list">
              {collisions.map(({ a, b, files, at }) => (
                <li key={`${a}>${b}`}>
                  <button type="button" onClick={() => onSelect(a)}>
                    <span className="clash-mark" aria-hidden="true" />
                    <span>
                      <b>{labelOf.get(a) ?? a}</b> and <b>{labelOf.get(b) ?? b}</b> both edited {fileList(files)}, {ago(at, now)} ago
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </Section>
        )}

        {/* Quiet agents may be waiting on an approval, so they come before the busy ones. */}
        {quiet.length > 0 && (
          <Section name="quiet" title="Quiet" count={quiet.length} headingClass="quiet-heading">
            <ol className="running quiet-list">
              {quiet.map((node) => (
                <li key={node.id}>
                  <button type="button" onClick={() => onSelect(node.id)}>
                    <Orb state={orbStateOf(node, now)} size={20} seed={node.id} />
                    <span>
                      <b>{node.label}</b> {quietLine(node, now)}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </Section>
        )}

        <Section name="running" title="Running now" count={running.length} headingClass="serif">
          <ol className="running">
            {running.slice(0, RUNNING_SHOWN).map((node) => (
              <li key={node.id}>
                <button type="button" onClick={() => onSelect(node.id)}>
                  <Orb state={orbStateOf(node, now)} size={20} seed={node.id} />
                  <span>
                    <b>{node.label}</b> {verbFor(node.activity).toLowerCase()} in {node.room}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          {running.length > RUNNING_SHOWN && <p className="empty-note">And {running.length - RUNNING_SHOWN} more.</p>}
          {running.length === 0 && <p className="empty-note">No agents are running.</p>}
        </Section>

        {/* Archived last: the least urgent thing in the panel. */}
        {archived.length > 0 && (
          <Section name="archived" title="Archived" count={archived.length} headingClass="serif">
            <ol className="running">
              {archived.map((node) => (
                <li key={node.id} className="turn-item">
                  <button type="button" data-archived={node.id} className={node.id === selectedId ? 'selected' : undefined} onClick={() => onSelect(node.id)}>
                    <Orb state={orbStateOf(node, now)} size={20} seed={node.id} />
                    <span>
                      <b>{node.label}</b> {node.room ? `in ${node.room}, ` : ''}finished {ago(node.lastAt, now)} ago
                      {helpersOf(node) > 0 && `, with ${helpersOf(node) === 1 ? 'a subagent' : `${helpersOf(node)} subagents`}`}
                    </span>
                  </button>
                  {unarchive && (
                    <button type="button" className="dismiss" aria-label={`Unarchive ${node.label}`} title="Unarchive" onClick={() => unarchive(node)}>
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M12 19V5M5 12l7-7 7 7" />
                      </svg>
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </Section>
        )}

        {spend && <p className="spend-note">Everything in view: {spend}</p>}
        {waited > 0 && <p className="spend-note">Something waited on you for {duration(waited)} today</p>}
      </div>
    </aside>
  )
}

// The clean view hides the side panel, but not who is waiting on you: a small list in the corner.
export function TurnOverlay({ nodes, now, onSelect }: { nodes: AgentNode[]; now: number; onSelect: (id: string) => void }) {
  const waiting = waitingOn(nodes, now)
  if (waiting.length === 0) return null
  return (
    <nav className="turn-overlay" aria-label="Your turn">
      <ol>
        {waiting.map((node) => (
          <li key={node.id}>
            <button type="button" className={beamClass(node, now)} style={beamStyle(node.id)} onClick={() => onSelect(node.id)}>
              <Orb state="listening" size={20} seed={node.id} />
              <strong>{node.label}</strong>
              <span className="why">{waitingLine(node, now)}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}
