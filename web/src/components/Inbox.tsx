import { describeSpend, mergeUsage } from '../pricing'
import { ago, describeStatus, isQuiet, orbStateOf, statusOf, verbFor } from '../status'
import type { Connection } from '../useGraph'
import type { AgentNode } from '../types'
import { beamStyle } from '../rhythm'
import { Orb } from './Orb'
import { Wordmark } from './Wordmark'

const RUNNING_SHOWN = 8

interface InboxProps {
  nodes: AgentNode[]
  now: number
  connection: Connection | 'replay'
  selectedId: string | null
  dismissedCount: number
  onSelect: (id: string) => void
  onDismiss: (node: AgentNode) => void
  onRestoreDismissed: () => void
}

function waitingLine(node: AgentNode, now: number): string {
  const what = node.waiting?.reason === 'question' ? 'Asked you a question' : 'Finished'
  return `${what}, ${ago(node.waiting?.since ?? node.lastAt, now)} ago`
}

const COUNT_WORDS = ['No agents are', 'One agent is', 'Two agents are', 'Three agents are', 'Four agents are', 'Five agents are']

function waitingLede(count: number): string {
  return `${COUNT_WORDS[count] ?? `${count} agents are`} waiting on you.`
}

const CONNECTION_LABELS = { connecting: 'Reconnecting', reconnecting: 'Reconnecting', live: 'Live', replay: 'Replay' }

export function Inbox({ nodes, now, connection, selectedId, dismissedCount, onSelect, onDismiss, onRestoreDismissed }: InboxProps) {
  const waiting = nodes
    .filter((node) => statusOf(node, now) === 'waiting')
    .sort((a, b) => (a.waiting?.since ?? 0) - (b.waiting?.since ?? 0))
  const runningNow = nodes
    .filter((node) => node.kind !== 'peer' && statusOf(node, now) === 'running')
    .sort((a, b) => b.lastAt - a.lastAt)
  const running = runningNow.filter((node) => !isQuiet(node, now))
  const quiet = runningNow.filter((node) => isQuiet(node, now))
  const spend = describeSpend(mergeUsage(nodes.map((node) => node.usage)))

  return (
    <aside className="inbox">
      <div className="inbox-top">
        <Wordmark />
        <span className={`connection connection-${connection}`}>{CONNECTION_LABELS[connection]}</span>
      </div>
      <h1 className="serif">Your turn</h1>
      <p className="lede">{waitingLede(waiting.length)}</p>
      <ol className="turns">
        {waiting.map((node) => (
          <li key={node.id} className="turn-item">
            <button type="button" className={`turn beam${node.id === selectedId ? ' selected' : ''}`} style={beamStyle(node.id)} onClick={() => onSelect(node.id)}>
              <Orb state="listening" size={20} seed={node.id} />
              <strong className="serif">{node.label}</strong>
              <span className="where">
                {node.room}
                {node.branch && <span className="branch">{node.branch}</span>}
              </span>
              <span className="why">{waitingLine(node, now)}</span>
            </button>
            <button
              type="button"
              className="dismiss"
              aria-label={`Dismiss ${node.label}`}
              title="Dismiss until it does something new"
              onClick={() => onDismiss(node)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7 7l10 10M17 7L7 17" />
              </svg>
            </button>
          </li>
        ))}
      </ol>
      {waiting.length === 0 && <p className="empty-note">Nothing needs you right now.</p>}
      {dismissedCount > 0 && (
        <button type="button" className="link restore" onClick={onRestoreDismissed}>
          Show {dismissedCount} dismissed
        </button>
      )}

      <h2 className="serif">Running now</h2>
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
      {quiet.length > 0 && (
        <>
          <h3 className="quiet-heading">Quiet</h3>
          <ol className="running quiet-list">
            {quiet.map((node) => (
              <li key={node.id}>
                <button type="button" onClick={() => onSelect(node.id)}>
                  <Orb state={orbStateOf(node, now)} size={20} seed={node.id} />
                  <span>
                    <b>{node.label}</b> {describeStatus(node, now)}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
      {spend && <p className="spend-note">Everything in view: {spend}</p>}
    </aside>
  )
}
