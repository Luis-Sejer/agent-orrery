import { useStoreApi, ViewportPortal } from '@xyflow/react'
import { useEffect, useId, useRef } from 'react'

import { ORB_CENTRE_Y } from '../radial'
import type { CanvasNode } from '../useOrbit'
import { COMET_MS, type Comet } from '../useComets'

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
        {comets.map((comet) => {
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
          return <Streak key={comet.id} kind={comet.kind} from={start} to={end} />
        })}
      </svg>
    </ViewportPortal>
  )
}

const FLIGHT_EASE = (t: number) => t * t
// How far behind the head its tail's end runs, as a share of the flight: the tail grows from nothing as
// the comet speeds up, then drains into the head once it has arrived.
const TAIL_LAG = 0.25
// How far the path bows to one side, as a share of its length, so comets swing in rather than slide.
const BEND = 0.18
const HEAD_R = 5
const TAIL_SAMPLES = 14
// The core's constellation, which a comet falling in to you rings as it lands.
const CORE_R = 131

// A point on the bowed path at progress t.
function along(from: Point, bend: Point, to: Point, t: number): Point {
  const u = 1 - t
  return { x: u * u * from.x + 2 * u * t * bend.x + t * t * to.x, y: u * u * from.y + 2 * u * t * bend.y + t * t * to.y }
}

// The tail as a shape that tapers from the head's width to a point, following the curve.
function tailShape(from: Point, bend: Point, to: Point, tail: number, head: number): string {
  const points = Array.from({ length: TAIL_SAMPLES + 1 }, (_, i) => along(from, bend, to, tail + ((head - tail) * i) / TAIL_SAMPLES))
  const left: string[] = []
  const right: string[] = []
  points.forEach((point, i) => {
    const next = points[Math.min(i + 1, TAIL_SAMPLES)]
    const previous = points[Math.max(i - 1, 0)]
    const way = unit(previous, next)
    const half = (HEAD_R * 0.8 * i) / TAIL_SAMPLES
    left.push(`${point.x - way.y * half},${point.y + way.x * half}`)
    right.unshift(`${point.x + way.y * half},${point.y - way.x * half}`)
  })
  return `M${left.join('L')}L${right.join('L')}Z`
}

// A head with a tapering tail on a bowed path, drawn frame by frame: the tail's length follows the
// comet's speed, so it starts as a spark and stretches as it goes.
function Streak({ kind, from, to }: { kind: Comet['kind']; from: Point; to: Point }) {
  const gradient = useId()
  const tail = useRef<SVGPathElement>(null)
  const head = useRef<SVGGElement>(null)
  const fade = useRef<SVGLinearGradientElement>(null)
  const ripple = useRef<SVGCircleElement>(null)
  const landsOnYou = kind === 'wait' && to.x === 0 && to.y === 0
  // The orbs keep orbiting while a comet flies, so each frame reads where its ends are now.
  const ends = useRef({ from, to })
  ends.current = { from, to }

  useEffect(() => {
    const begin = performance.now()
    let frame = 0
    const draw = (now: number) => {
      const { from, to } = ends.current
      const length = Math.hypot(to.x - from.x, to.y - from.y)
      const across = unit(from, to)
      const bend = { x: (from.x + to.x) / 2 - across.y * length * BEND, y: (from.y + to.y) / 2 + across.x * length * BEND }
      const t = ((now - begin) / COMET_MS) * (1 + TAIL_LAG)
      const at = FLIGHT_EASE(Math.min(t, 1))
      // Never longer than TAIL_PX, however far it flies.
      const behind = Math.max(FLIGHT_EASE(Math.min(Math.max(t - TAIL_LAG, 0), 1)), at - TAIL_PX / (length || 1))
      const tip = along(from, bend, to, at)
      const end = along(from, bend, to, behind)
      head.current?.setAttribute('transform', `translate(${tip.x} ${tip.y}) scale(${Math.min(1, t * 6)})`)
      head.current?.setAttribute('opacity', t < 1 ? '1' : '0')
      tail.current?.setAttribute('d', tailShape(from, bend, to, behind, at))
      for (const [name, value] of [['x1', end.x], ['y1', end.y], ['x2', tip.x], ['y2', tip.y]] as const) fade.current?.setAttribute(name, String(value))
      if (t >= 1) ripple.current?.classList.add('landed')
      if (t < 1 + TAIL_LAG) frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <g className={`comet comet-${kind}`}>
      <defs>
        <linearGradient ref={fade} id={gradient} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="currentColor" stopOpacity="0" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.9" />
        </linearGradient>
      </defs>
      <path ref={tail} fill={`url(#${gradient})`} />
      <g ref={head} opacity="0">
        <circle r={HEAD_R * 2.6} fill="currentColor" className="comet-glow" />
        <circle r={HEAD_R} fill="currentColor" className="comet-head" />
        <circle r={HEAD_R * 0.45} className="comet-core" />
      </g>
      {landsOnYou && <circle ref={ripple} r={CORE_R} className="comet-ripple" />}
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
