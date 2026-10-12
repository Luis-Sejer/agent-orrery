import { useContext, useEffect, useId, useRef, type CSSProperties } from 'react'
import type { NodeProps } from '@xyflow/react'
import { MODE_FRAMES, resolvePreset, scaleCounts, scaleRadii } from 'thinking-orbs'
import { paintFrame } from 'thinking-orbs/engine'

import { ROOM_LABEL_SIDE_REACH, type BackdropNode } from '../radial'
import { HudContext } from '../useTheme'

const RING_LABELS = { waiting: 'Waiting on you', running: 'Running', finished: 'Finished' }
const TOP = -Math.PI / 2
// Ring labels ride an arc this wide, centred on the empty wedge at the top.
const LABEL_ARC = 0.7
// Sector boundaries are short ticks just outside the outer ring.
const TICK_FROM = 14
const TICK_TO = 34
const CORE_SIZE = 320
// The status page's "neural network": thinking-orbs' connecting state, denser and finer, turning slowly.
const CORE_STATE = 'connecting'
const CORE_DENSITY = 2
const CORE_DOT_SCALE = 0.85
const CORE_LINE_WIDTH = 1.1
const CORE_SPEED = 0.25
// Where a still (reduced-motion) orb is painted, in seconds.
const STILL_AT = 0.6

function toTint(colour: string) {
  const [r, g, b] = colour.match(/[\da-f]{2}/gi)!.map((pair) => parseInt(pair, 16))
  return { r, g, b }
}

// You, at the centre: a constellation painted with the thinking-orbs engine, in the theme's ink, or
// red while anything waits on you (--core in the stylesheet). It pauses off screen and in hidden
// tabs, and holds still for reduced motion.
function CoreOrb({ waiting }: { waiting: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current!
    const context = canvas.getContext('2d')!
    const ratio = Math.min(2, devicePixelRatio || 1)
    canvas.width = canvas.height = CORE_SIZE * ratio
    const { mode, speed, opts: preset } = resolvePreset(CORE_STATE, 64)
    const opts = { ...scaleRadii(scaleCounts(preset, CORE_DENSITY), CORE_DOT_SCALE), lineW: CORE_LINE_WIDTH }
    const still = matchMedia('(prefers-reduced-motion: reduce)')
    let onScreen = true
    let request = 0

    const paint = (seconds: number) => {
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, CORE_SIZE, CORE_SIZE)
      const tint = toTint(getComputedStyle(canvas).getPropertyValue('--core'))
      const dark = document.documentElement.dataset.theme === 'dark'
      paintFrame(context, MODE_FRAMES[mode](CORE_SIZE, seconds * speed * CORE_SPEED, opts), dark, tint)
    }
    const loop = (now: number) => {
      paint(now / 1000)
      request = requestAnimationFrame(loop)
    }
    const update = () => {
      cancelAnimationFrame(request)
      if (still.matches) paint(STILL_AT)
      else if (onScreen) request = requestAnimationFrame(loop)
    }
    const visibility = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting
      update()
    })
    visibility.observe(canvas)
    // New ink when the theme changes, even while it holds still.
    const theme = new MutationObserver(update)
    theme.observe(document.documentElement, { attributeFilter: ['data-theme', 'data-hud'] })
    still.addEventListener('change', update)
    update()
    return () => {
      cancelAnimationFrame(request)
      visibility.disconnect()
      theme.disconnect()
      still.removeEventListener('change', update)
    }
  }, [waiting])

  return <canvas ref={ref} className={waiting ? 'core-orb waiting' : 'core-orb'} aria-hidden="true" />
}

// An arc across the top, clockwise, for a ring's label to ride.
function topArc(r: number): string {
  const [from, to] = [TOP - LABEL_ARC / 2, TOP + LABEL_ARC / 2]
  return `M ${Math.cos(from) * r} ${Math.sin(from) * r} A ${r} ${r} 0 0 1 ${Math.cos(to) * r} ${Math.sin(to) * r}`
}

const degrees = (radians: number) => (radians * 180) / Math.PI

function caption(waiting: number): string {
  if (waiting === 0) return 'Nothing needs you'
  return `${waiting} ${waiting === 1 ? 'needs' : 'need'} you`
}

// Rings, sector boundaries and room names, with you at the centre. It sits behind every agent
// and lets clicks through, except on its own buttons. Labels turn with their rings.
export function OrreryBackdrop({ data }: NodeProps<BackdropNode>) {
  const { radius, rings, sectors, labelRadius, turns, waiting, onCollapse } = data
  const hud = useContext(HudContext)
  const id = useId()
  const outer = rings[rings.length - 1].r

  return (
    <div className="orrery-backdrop">
      <svg viewBox={`${-radius} ${-radius} ${radius * 2} ${radius * 2}`} aria-hidden="true">
        <defs>
          {rings.map((ring) => (
            <path key={ring.status} id={`${id}-${ring.status}`} d={topArc(ring.r)} />
          ))}
        </defs>
        {rings.map((ring) => (
          <circle key={ring.status} className={`orrery-ring ring-${ring.status}`} r={ring.r} />
        ))}
        <g transform={`rotate(${degrees(turns.finished)})`}>
          {sectors.slice(1).map((sector) => (
            <line
              key={sector.name}
              className="orrery-boundary"
              x1={Math.cos(sector.start) * (outer + TICK_FROM)}
              y1={Math.sin(sector.start) * (outer + TICK_FROM)}
              x2={Math.cos(sector.start) * (outer + TICK_TO)}
              y2={Math.sin(sector.start) * (outer + TICK_TO)}
            />
          ))}
        </g>
        {rings.map((ring) => (
          <text key={ring.status} className="orrery-ring-label" dy={-8} transform={`rotate(${degrees(turns[ring.status])})`}>
            <textPath href={`#${id}-${ring.status}`} startOffset="50%">
              {RING_LABELS[ring.status]}
            </textPath>
          </text>
        ))}
        {hud && (
          <g className="hud-dial">
            <circle className="hud-ticks" r={142} />
            <circle className="hud-segments" r={154} />
            <circle className="hud-arc" r={166} />
          </g>
        )}
      </svg>

      <div className="orrery-core">
        <CoreOrb waiting={waiting > 0} />
        <span className={waiting > 0 ? 'core-caption why' : 'core-caption'}>{caption(waiting)}</span>
      </div>

      {sectors.map((sector) => {
        const angle = sector.mid + turns.finished
        const [cos, sin] = [Math.cos(angle), Math.sin(angle)]
        const reach = labelRadius + Math.abs(cos) * ROOM_LABEL_SIDE_REACH
        return (
          <div
            key={sector.name}
            className="sector-label"
            style={{ left: cos * reach + radius, top: sin * reach + radius, '--cos': cos, '--sin': sin } as CSSProperties}
          >
            <span className="serif">{sector.name}</span>
            {sector.foldable && (
              <button type="button" className="room-fold nodrag" onClick={() => onCollapse(sector.name)}>
                Hide finished
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
