import { useStoreApi, ViewportPortal } from '@xyflow/react'
import type { CSSProperties } from 'react'

import { ORB_CENTRE_Y } from '../radial'
import type { CanvasNode } from '../useOrbit'
import type { Comet } from '../useComets'

// Where a card's orb sits: its left padding plus half the orb.
const CARD_ORB_X = 28
// How far an outward comet flies at least (it flies on until it has left the view), and its tail.
const OUTWARD_PX = 260
const TAIL_PX = 150
// Outwards on a grid of rooms, where there's no centre to fly away from: up and to the right.
const GRID_OUTWARD = { x: Math.cos(-Math.PI / 3), y: Math.sin(-Math.PI / 3) }

type Point = { x: number; y: number }

function orbOf(node: CanvasNode): Point {
  const { x, y } = node.position
  if (node.type === 'orbit') return { x: x + node.width! / 2, y: y + ORB_CENTRE_Y }
  return { x: x + CARD_ORB_X, y: y + node.height! / 2 }
}

type View = { left: number; top: number; right: number; bottom: number }

// How far from a point, along a direction, until the comet's tail has left the view too.
function toEdge(from: Point, way: Point, view: View): number {
  const along = (start: number, step: number, low: number, high: number) => (step > 0 ? (high - start) / step : step < 0 ? (low - start) / step : Infinity)
  const out = Math.min(along(from.x, way.x, view.left, view.right), along(from.y, way.y, view.top, view.bottom))
  return Math.max(OUTWARD_PX, out + TAIL_PX)
}

const unit = (from: Point, to: Point): Point => {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1
  return { x: (to.x - from.x) / length, y: (to.y - from.y) / length }
}

interface CometsProps {
  comets: Comet[]
  nodes: CanvasNode[]
  orrery: boolean
}

// Comets fly over the canvas in its own coordinates: in the orrery you sit at the centre; on a grid of
// rooms you are the side panel, to the left of the view.
export function Comets({ comets, nodes, orrery }: CometsProps) {
  const store = useStoreApi()
  if (comets.length === 0) return null
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const { transform, width, height } = store.getState()
  const [tx, ty, zoom] = transform
  const view = { left: -tx / zoom, top: -ty / zoom, right: (width - tx) / zoom, bottom: (height - ty) / zoom }
  const flyOut = (from: Point, way: Point) => {
    const distance = toEdge(from, way, view)
    return { x: from.x + way.x * distance, y: from.y + way.y * distance }
  }

  return (
    <ViewportPortal>
      <svg className="comets" aria-hidden="true">
        {comets.map((comet, index) => {
          const node = byId.get(comet.agentId)
          if (!node || (node.type !== 'orbit' && node.type !== 'session' && node.type !== 'agent')) return null
          const start = orbOf(node)
          if (comet.kind === 'clash') return <Flare key={comet.id} at={start} />
          // A wait falls into you; news flies away from you until it has left the view.
          const end =
            comet.kind === 'wait'
              ? orrery
                ? { x: 0, y: 0 }
                : flyOut(start, { x: -1, y: 0 })
              : flyOut(start, orrery ? unit({ x: 0, y: 0 }, start) : GRID_OUTWARD)
          return <Streak key={comet.id} gradient={`comet-tail-${index}`} kind={comet.kind} from={start} to={end} />
        })}
      </svg>
    </ViewportPortal>
  )
}

// A head with a fading tail, flying in a straight line: the group moves, the tail trails behind it.
function Streak({ gradient, kind, from, to }: { gradient: string; kind: Comet['kind']; from: Point; to: Point }) {
  const back = unit(to, from)
  const style = { '--x0': `${from.x}px`, '--y0': `${from.y}px`, '--x1': `${to.x}px`, '--y1': `${to.y}px` } as CSSProperties
  return (
    <g className={`comet comet-${kind}`} style={style}>
      <defs>
        <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1={back.x * TAIL_PX} y1={back.y * TAIL_PX} x2={0} y2={0}>
          <stop offset="0" stopColor="currentColor" stopOpacity="0" />
          <stop offset="1" stopColor="currentColor" stopOpacity="1" />
        </linearGradient>
      </defs>
      <line x1={back.x * TAIL_PX} y1={back.y * TAIL_PX} x2={0} y2={0} stroke={`url(#${gradient})`} strokeWidth={7} strokeLinecap="round" />
      <circle r={13} fill="currentColor" className="comet-glow" />
      <circle r={6} fill="currentColor" className="comet-head" />
    </g>
  )
}

// A red flare where two agents have met in the same files: a ring that spreads and a burst of rays.
const RAYS = 8

function Flare({ at }: { at: Point }) {
  return (
    <g className="comet-clash" transform={`translate(${at.x} ${at.y})`}>
      <g className="flare">
        <circle r={18} className="flare-ring" />
        {Array.from({ length: RAYS }, (_, index) => {
          const angle = (index / RAYS) * 2 * Math.PI
          return <line key={index} className="flare-ray" x1={Math.cos(angle) * 22} y1={Math.sin(angle) * 22} x2={Math.cos(angle) * 36} y2={Math.sin(angle) * 36} />
        })}
      </g>
    </g>
  )
}
