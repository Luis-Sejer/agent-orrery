import { BaseEdge, getBezierPath, Handle, Position, type Edge, type EdgeProps, type NodeProps } from '@xyflow/react'

import type { CardNode, FoldNode, MessageData, RoomNode } from '../layout'
import { beamStyle } from '../rhythm'
import { describeStatus, isQuiet, orbStateOf, statusOf } from '../status'
import { Orb } from './Orb'

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
    isQuiet(data.node, data.now) && 'quiet',
    data.dimmed && 'dimmed',
    data.focused && 'focused',
    data.related && !data.focused && 'related',
  ]
    .filter(Boolean)
    .join(' ')
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
        </strong>
        <span className="card-line">
          {node.branch && <span className="branch">{node.branch}</span>}
          {alsoIn.length > 0 && <span className="also">Also in {alsoIn.join(', ')}</span>}
        </span>
        <span className={waiting ? 'card-line why' : 'card-line'}>{describeStatus(node, now)}</span>
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
        </strong>
        <span className="card-line">{node.kind === 'peer' ? 'Another session' : node.agentType}</span>
        <span className="card-line">{describeStatus(node, now)}</span>
      </div>
    </div>
  )
}

export function FoldCard({ data }: NodeProps<FoldNode>) {
  return (
    <button type="button" className={`card fold nodrag${data.dimmed ? ' dimmed' : ''}${data.related ? ' related' : ''}`} onClick={() => data.onExpand(data.room)}>
      <Handles />
      <span className="fold-dot" aria-hidden="true" />
      {data.count} finished, show
    </button>
  )
}

export function RoomBox({ data }: NodeProps<RoomNode>) {
  return (
    <div className={`room${data.dimmed ? ' dimmed' : ''}`}>
      <span className="room-summary">
        {data.summary}
        {data.foldable && (
          <button type="button" className="room-fold nodrag" onClick={() => data.onCollapse(data.name)}>
            Hide finished
          </button>
        )}
      </span>
      <span className="room-name serif">{data.name}</span>
    </div>
  )
}

export function MessageEdge(props: EdgeProps<Edge<MessageData, 'message'>>) {
  const [path] = getBezierPath(props)
  return (
    <>
      <BaseEdge id={props.id} path={path} className="message-path" />
      {props.data?.recent && (
        <circle r={4} className="message-pulse">
          <animateMotion dur="1.6s" repeatCount="indefinite" path={path} />
        </circle>
      )}
    </>
  )
}

export const nodeTypes = { session: SessionCard, agent: AgentCard, fold: FoldCard, room: RoomBox }
export const edgeTypes = { message: MessageEdge }
