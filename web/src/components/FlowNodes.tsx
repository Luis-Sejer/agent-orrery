import { memo } from 'react'
import { BaseEdge, getBezierPath, Handle, Position, type Edge, type EdgeProps, type NodeProps } from '@xyflow/react'

import type { CardNode, FoldNode, MessageData, RoomNode } from '../layout'
import type { OrbitNode, PileNode } from '../radial'
import { useStill } from '../motion'
import { beamStyle } from '../rhythm'
import { describeStatus, isFreshWait, isQuiet, orbStateOf, statusOf, waitingLine } from '../status'
import { Orb } from './Orb'
import { OrreryBackdrop } from './OrreryBackdrop'

// Edges attach to these; they are invisible and can't be dragged.
function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  )
}

function cardClass(kind: string, data: CardNode['data']): string {
  const status = statusOf(data.node, data.now)
  return [
    'card',
    kind,
    `status-${status}`,
    status === 'waiting' && 'beam',
    isFreshWait(data.node, data.now) && 'fresh',
    isQuiet(data.node, data.now) && 'quiet',
    data.dimmed && 'dimmed',
    data.focused && 'focused',
    data.related && !data.focused && 'related',
  ]
    .filter(Boolean)
    .join(' ')
}

// A small mark on an agent that published artifacts, with how many; the drawer lists them.
function ArtifactMark({ count }: { count: number }) {
  if (count === 0) return null
  const name = `${count} ${count === 1 ? 'artifact' : 'artifacts'}`
  return (
    <span className="artifact-mark" title={`Published ${name}`} aria-label={`Published ${name}`}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 3h7l5 5v13H7z M14 3v5h5" />
      </svg>
      {count > 1 && count}
    </span>
  )
}

// Status lines are cut short on a card; the whole line is a hover away.
function CardLine({ className = 'card-line', children }: { className?: string; children: string }) {
  return (
    <span className={className} title={children}>
      {children}
    </span>
  )
}

export function SessionCard({ data }: NodeProps<CardNode>) {
  const { node, now, alsoIn } = data
  const waiting = statusOf(node, now) === 'waiting'
  return (
    <div className={cardClass('session', data)} style={beamStyle(node.id)}>
      <Handles />
      <Orb state={orbStateOf(node, now)} size={32} ring seed={node.id} />
      <div className="card-text">
        <strong className="card-title serif" title={node.label}>
          {node.label}
          <ArtifactMark count={node.artifacts?.length ?? 0} />
        </strong>
        <span className="card-line" title={[node.branch, alsoIn.length > 0 && `Also in ${alsoIn.join(', ')}`].filter(Boolean).join('. ')}>
          {node.branch && <span className="branch">{node.branch}</span>}
          {alsoIn.length > 0 && <span className="also">Also in {alsoIn.join(', ')}</span>}
        </span>
        {waiting ? <CardLine className="card-line why">{waitingLine(node, now)}</CardLine> : <CardLine>{describeStatus(node, now)}</CardLine>}
      </div>
    </div>
  )
}

export function AgentCard({ data }: NodeProps<CardNode>) {
  const { node, now } = data
  return (
    <div className={cardClass('agent', data)}>
      <Handles />
      <Orb state={orbStateOf(node, now)} size={32} seed={node.id} />
      <div className="card-text">
        <strong className="card-title" title={node.label}>
          {node.label}
          <ArtifactMark count={node.artifacts?.length ?? 0} />
        </strong>
        <CardLine>{node.kind === 'peer' ? 'Another session' : (node.agentType ?? '')}</CardLine>
        <CardLine>{describeStatus(node, now)}</CardLine>
      </div>
    </div>
  )
}

// The orrery's compact node: an orb with its name underneath. Edges meet at the orb's centre.
export function OrbitCard({ data }: NodeProps<OrbitNode>) {
  const { node, now } = data
  const status = statusOf(node, now)
  const className = ['orbit-card', `status-${status}`, isFreshWait(node, now) && 'fresh', data.dimmed && 'dimmed', data.focused && 'focused', data.related && !data.focused && 'related']
    .filter(Boolean)
    .join(' ')
  return (
    <div className={className} style={beamStyle(node.id)} title={`${node.label}. ${describeStatus(node, now)}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <Handle type="source" position={Position.Top} isConnectable={false} />
      <Orb state={orbStateOf(node, now)} size={32} ring={node.kind === 'session'} seed={node.id} />
      <span className={node.kind === 'session' ? 'orbit-label serif' : 'orbit-label'}>
        {node.label}
        <ArtifactMark count={node.artifacts?.length ?? 0} />
      </span>
    </div>
  )
}

// The orrery's version of a pile: an orb-sized stack with its count, so it fits a slot on the ring.
export function PileCard({ data }: NodeProps<PileNode>) {
  const className = ['orbit-card', 'pile', 'nodrag', data.dimmed && 'dimmed', data.related && 'related'].filter(Boolean).join(' ')
  return (
    <button type="button" className={className} data-room={data.room} title={`Show ${data.count} finished in ${data.room}`} onClick={() => data.onExpand(data.room)}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <Handle type="source" position={Position.Top} isConnectable={false} />
      <span className="pile-count" aria-hidden="true">{data.count}</span>
      <span className="orbit-label">Show {data.count} finished</span>
    </button>
  )
}

export function FoldCard({ data }: NodeProps<FoldNode>) {
  return (
    <button type="button" className={`card fold nodrag${data.dimmed ? ' dimmed' : ''}${data.related ? ' related' : ''}`} data-room={data.room} onClick={() => data.onExpand(data.room)}>
      <Handles />
      <span className="fold-dot" aria-hidden="true" />
      Show {data.count} finished
    </button>
  )
}

export function RoomBox({ data }: NodeProps<RoomNode>) {
  return (
    <div className={`room${data.dimmed ? ' dimmed' : ''}`}>
      <span className="room-summary">
        {data.summary}
        {data.foldable && (
          <button type="button" className="room-fold nodrag" data-room={data.name} onClick={() => data.onCollapse(data.name)}>
            Hide finished
          </button>
        )}
      </span>
      <span className="room-name serif" title={data.name}>
        {data.name}
      </span>
    </div>
  )
}

// A pulse travels along a new message; SMIL ignores the stylesheet, so holding still means not drawing it.
export function MessageEdge(props: EdgeProps<Edge<MessageData, 'message'>>) {
  const [path] = getBezierPath(props)
  const still = useStill()
  return (
    <>
      <BaseEdge id={props.id} path={path} className={props.data?.fresh ? 'message-path fresh' : 'message-path'} />
      {props.data?.recent && !still && (
        <circle r={4} className="message-pulse">
          <animateMotion dur="1.6s" repeatCount="indefinite" path={path} />
        </circle>
      )}
    </>
  )
}

// The orbit moves orrery nodes many times a second, and React Flow re-renders a node whenever it moves.
// What an orbit card or pile shows depends only on its data, which the orbit passes through
// untouched, so they skip those renders.
const sameData = (before: { data: unknown }, after: { data: unknown }) => before.data === after.data

export const nodeTypes = {
  session: SessionCard,
  agent: AgentCard,
  fold: FoldCard,
  room: RoomBox,
  orbit: memo(OrbitCard, sameData),
  pile: memo(PileCard, sameData),
  backdrop: OrreryBackdrop,
}
export const edgeTypes = { message: MessageEdge }
