import { memo, useContext, useEffect, useRef, useState, type MouseEvent } from 'react'
import { BaseEdge, getBezierPath, getStraightPath, Handle, Position, type Edge, type EdgeProps, type NodeProps } from '@xyflow/react'

import type { CardNode, FoldNode, MessageData, RoomNode } from '../layout'
import type { OrbitNode, PileNode } from '../radial'
import { useStill } from '../motion'
import { beamStyle } from '../rhythm'
import { ago, describeStatus, isFreshWait, isQuiet, orbStateOf, stateColour, statusOf, waitingLine } from '../status'
import { describeModes, isPrUrl, modeChips, prLabel } from '../modes'
import { openShell, shellAddress, shellLabel, shellUrl } from '../shells'
import type { AgentNode, PullRequest, Shell } from '../types'
import { PACKET_MS, type Packet } from '../usePackets'
import { HudContext } from '../useTheme'
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

// A mark for the pull requests it linked, with how many; the drawer links them.
function PrMark({ prs }: { prs?: PullRequest[] }) {
  const count = (prs ?? []).filter(({ url }) => isPrUrl(url)).length
  if (count === 0) return null
  const name = count === 1 ? `pull request ${prLabel(prs![0])}` : `${count} pull requests`
  return (
    <span className="artifact-mark pr-mark" title={`Linked ${name}`} aria-label={`Linked ${name}`}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="6" cy="18" r="2.5" />
        <circle cx="18" cy="18" r="2.5" />
        <path d="M6 8.5v7 M18 15.5V9a3 3 0 0 0-3-3h-4 M13 3.5 10.5 6 13 8.5" />
      </svg>
      {count > 1 && count}
    </span>
  )
}

const SATELLITES_SHOWN = 6

const describeShell = (shell: Shell, now: number) => `Background shell${shellAddress(shell) ? ` on ${shellAddress(shell)}` : ''}, running ${ago(shell.since, now)}`

// A served shell opens its address; the click stays off the agent behind it.
function openFrom(event: MouseEvent, shell: Shell) {
  if (!shellUrl(shell)) return
  event.stopPropagation()
  openShell(shell)
}

// Background shells circle the orb like electrons: each on its own tilted orbit, so two or three cross
// like an atom's, with a glowing core and a short trail. A shell serving an address glows in the
// accent colour, and clicking its orbit opens it (a pointer shortcut; the drawer lists the same as
// links for the keyboard). Held still, the electrons rest on their orbits.
const ORBIT_RX = 31
const ORBIT_RY = 11
const FIRST_LAP_S = 2.6
const LAP_STEP_S = 0.9
const TRAIL = [
  { r: 1.8, opacity: 0.45, lag: 0.1 },
  { r: 1.3, opacity: 0.2, lag: 0.2 },
]
const GRAB_R = 8
const ORBIT_PATH = `M ${ORBIT_RX} 0 A ${ORBIT_RX} ${ORBIT_RY} 0 1 1 ${-ORBIT_RX} 0 A ${ORBIT_RX} ${ORBIT_RY} 0 1 1 ${ORBIT_RX} 0`

function Electron({ lap, rest, still }: { lap: number; rest: number; still: boolean }) {
  if (still) {
    const angle = 2 * Math.PI * rest
    const at = { cx: ORBIT_RX * Math.cos(angle), cy: ORBIT_RY * Math.sin(angle) }
    return (
      <>
        <circle className="electron-halo" r={5} {...at} />
        <circle className="electron-core" r={2.4} {...at} />
        <circle className="electron-grab" r={GRAB_R} {...at} />
      </>
    )
  }
  // Each orbit starts somewhere else along its path, and its trail follows a fraction of a lap behind.
  const begin = (lag: number) => `${-(rest + lag / lap) * lap}s`
  const move = (lag = 0) => <animateMotion dur={`${lap}s`} begin={begin(lag)} repeatCount="indefinite" path={ORBIT_PATH} />
  return (
    <>
      {TRAIL.map((dot) => (
        <circle key={dot.lag} className="electron-core" r={dot.r} opacity={dot.opacity}>
          {move(dot.lag)}
        </circle>
      ))}
      <circle className="electron-halo" r={5}>
        {move()}
      </circle>
      <circle className="electron-core" r={2.4}>
        {move()}
      </circle>
      {/* Bigger than the electron and moving with it, so a paused one is easy to point at. */}
      <circle className="electron-grab" r={GRAB_R}>
        {move()}
      </circle>
    </>
  )
}

interface SatellitesProps {
  shells?: Shell[]
  // Pointing at the agent: its electrons stop where they are, so one can be picked.
  paused: boolean
  onHover: (shell: Shell | null) => void
}

function Satellites({ shells, paused, onHover }: SatellitesProps) {
  const still = useStill()
  const svg = useRef<SVGSVGElement>(null)
  // SMIL keeps its own clock per <svg>; pausing it freezes every electron and trail in place.
  useEffect(() => {
    if (paused) svg.current?.pauseAnimations()
    else svg.current?.unpauseAnimations()
  }, [paused, shells?.length])
  if (!shells?.length) return null
  const shown = shells.slice(0, SATELLITES_SHOWN)
  const box = ORBIT_RX + 8
  return (
    <svg ref={svg} className="satellites" viewBox={`${-box} ${-box} ${box * 2} ${box * 2}`} width={box * 2} height={box * 2} aria-hidden="true">
      {shown.map((shell, index) => (
        <g
          key={`${shell.since}-${index}`}
          className={shellUrl(shell) ? 'electron served nodrag' : 'electron nodrag'}
          transform={`rotate(${(180 / shown.length) * index - 25})`}
          onMouseEnter={() => onHover(shell)}
          onMouseLeave={() => onHover(null)}
          onClick={(event) => openFrom(event, shell)}
        >
          <path className="electron-orbit" d={ORBIT_PATH} />
          <Electron lap={FIRST_LAP_S + index * LAP_STEP_S} rest={index / shown.length} still={still} />
        </g>
      ))}
    </svg>
  )
}

// What the electron you're pointing at is, above the orb, straight away rather than after the browser's delay.
function ElectronTip({ shell, now }: { shell: Shell; now: number }) {
  return (
    <span className="electron-tip">
      {describeShell(shell, now)}
      {shellUrl(shell) && <span className="electron-tip-action">Click to open</span>}
    </span>
  )
}

// One line of chips under its name: the addresses its shells serve (":3005", "bug-fix:3005", the full
// address on hover), then its modes.
function Ports({ node, now }: { node: AgentNode; now: number }) {
  const served = (node.shells ?? []).filter((shell) => shellUrl(shell))
  const modes = modeChips(node)
  if (served.length === 0 && modes.length === 0) return null
  return (
    <span className="ports">
      {served.map((shell, index) => (
        <span key={`${shell.since}-${index}`} className="port nodrag" title={describeShell(shell, now)} onClick={(event) => openFrom(event, shell)}>
          {shellLabel(shell)}
        </span>
      ))}
      {modes.map(({ label, tone }) => (
        <span key={label} className={`mode-chip ${tone}`} title={describeModes(node).join(', ')}>
          {label}
        </span>
      ))}
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
          <span className="label-text">{node.label}</span>
          <ArtifactMark count={node.artifacts?.length ?? 0} />
          <PrMark prs={node.prs} />
        </strong>
        <Ports node={node} now={now} />
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
          <span className="label-text">{node.label}</span>
          <ArtifactMark count={node.artifacts?.length ?? 0} />
          <PrMark prs={node.prs} />
        </strong>
        <Ports node={node} now={now} />
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
  const [pointing, setPointing] = useState(false)
  const [tip, setTip] = useState<Shell | null>(null)
  return (
    <div
      className={className}
      style={beamStyle(node.id)}
      // On an electron, its own tip says what it is; the agent's would cover it.
      title={tip ? undefined : `${node.label}. ${describeStatus(node, now)}`}
      onMouseEnter={() => setPointing(true)}
      onMouseLeave={() => {
        setPointing(false)
        setTip(null)
      }}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <Handle type="source" position={Position.Top} isConnectable={false} />
      <Orb state={orbStateOf(node, now)} size={32} ring={node.kind === 'session'} seed={node.id} />
      <Satellites shells={node.shells} paused={pointing} onHover={setTip} />
      {tip && <ElectronTip shell={tip} now={now} />}
      <span className={node.kind === 'session' ? 'orbit-label serif' : 'orbit-label'}>
        <span className="label-text">{node.label}</span>
        <ArtifactMark count={node.artifacts?.length ?? 0} />
        <PrMark prs={node.prs} />
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
  // Sessions talking to each other: a hollow cable, so it can't be mistaken for a helper's message.
  if (props.data?.crosstalk) {
    return (
      <>
        <BaseEdge id={props.id} path={path} className={props.data.fresh ? 'crosstalk-path fresh' : 'crosstalk-path'} />
        <path d={path} className="crosstalk-core" fill="none" />
        {props.data.recent && !still && (
          <circle r={4.5} className="crosstalk-pulse">
            <animateMotion dur="1.6s" repeatCount="indefinite" path={path} />
          </circle>
        )}
      </>
    )
  }
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

export type SpawnData = { packets: Packet[]; straight: boolean }

// One packet, from the subagent's end of the line to its parent's. SMIL times a dynamically added
// animation from the page's start, so each one is started by hand once it's on the page.
function PacketDot({ packet, path }: { packet: Packet; path: string }) {
  const hud = useContext(HudContext)
  const motion = useRef<SVGAnimateMotionElement>(null)
  const fade = useRef<SVGAnimateElement>(null)
  useEffect(() => {
    const timer = setTimeout(() => {
      motion.current?.beginElement()
      fade.current?.beginElement()
    }, packet.delay)
    return () => clearTimeout(timer)
  }, [packet.delay])
  return (
    <circle r={3.2} className="packet" fill={stateColour(packet.activity, hud)} opacity={0}>
      <animateMotion ref={motion} begin="indefinite" dur={`${PACKET_MS}ms`} fill="freeze" keyPoints="1;0" keyTimes="0;1" calcMode="linear" path={path} />
      <animate ref={fade} attributeName="opacity" begin="indefinite" dur={`${PACKET_MS}ms`} values="0;1;1;0" keyTimes="0;0.12;0.85;1" fill="freeze" />
    </circle>
  )
}

// A subagent's line to its parent, with a packet for each tool call it has just made.
export function SpawnEdge(props: EdgeProps<Edge<SpawnData, 'spawn'>>) {
  const [path] = props.data?.straight ? getStraightPath(props) : getBezierPath(props)
  return (
    <>
      <BaseEdge id={props.id} path={path} />
      {props.data?.packets.map((packet) => <PacketDot key={packet.id} packet={packet} path={path} />)}
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
export const edgeTypes = { message: MessageEdge, spawn: SpawnEdge }
