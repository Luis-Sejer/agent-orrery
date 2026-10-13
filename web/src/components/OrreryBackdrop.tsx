import { useContext, useEffect, useId, useRef, type CSSProperties } from 'react'
import type { NodeProps } from '@xyflow/react'
import { MODE_FRAMES, resolvePreset, scaleCounts, scaleRadii } from 'thinking-orbs'
import { paintFrame } from 'thinking-orbs/engine'

import { onStillChange, prefersStill } from '../motion'
import { ago } from '../status'
import { current, isStale, toneOf, windowsOf } from '../usage'
import type { Usage } from '../types'
import { duration } from '../waits'
import { ROOM_LABEL_SIDE_REACH, type BackdropNode, type Box, type Sector, type System, type Turns } from '../radial'
import { STILL_AT, toTint } from '../orbTicker'
import { HudContext } from '../useTheme'

const TOP = -Math.PI / 2
// Ring labels ride an arc this wide, centred on the empty wedge at the top; wide enough for a label
// grown to stay readable when zoomed out.
const LABEL_ARC = 1.6
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
const CORE_FRAME_MS = 33
// Galaxy: a sun is a small disc in a soft glow. Spokes start outside the core's dial and stop at a
// system's outer ring.
const SUN_RADIUS = 7
const SUN_GLOW = 24
const SPOKE_FROM = 190
const ORIGIN = { cx: 0, cy: 0 }


// You, at the centre: a constellation painted with the thinking-orbs engine, in the theme's ink, or
// red while anything waits on you (--core in the stylesheet). It pauses off screen and in hidden
// tabs, and holds still for reduced motion or Pause motion.
function CoreOrb({ waiting }: { waiting: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current!
    const context = canvas.getContext('2d')!
    const ratio = Math.min(2, devicePixelRatio || 1)
    canvas.width = canvas.height = CORE_SIZE * ratio
    const { mode, speed, opts: preset } = resolvePreset(CORE_STATE, 64)
    const opts = { ...scaleRadii(scaleCounts(preset, CORE_DENSITY), CORE_DOT_SCALE), lineW: CORE_LINE_WIDTH }
    let onScreen = true
    let request = 0
    let last = 0
    // Ink and theme are read when they can change (theme switch, a wait), not on every frame.
    let tint = toTint(getComputedStyle(canvas).getPropertyValue('--core'))
    let dark = document.documentElement.dataset.theme === 'dark'

    const paint = (seconds: number) => {
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, CORE_SIZE, CORE_SIZE)
      paintFrame(context, MODE_FRAMES[mode](CORE_SIZE, seconds * speed * CORE_SPEED, opts), dark, tint)
    }
    // At the same 30 frames a second as the other orbs.
    const loop = (now: number) => {
      request = requestAnimationFrame(loop)
      if (now - last < CORE_FRAME_MS) return
      last = now
      paint(now / 1000)
    }
    const update = () => {
      tint = toTint(getComputedStyle(canvas).getPropertyValue('--core'))
      dark = document.documentElement.dataset.theme === 'dark'
      cancelAnimationFrame(request)
      if (prefersStill()) paint(STILL_AT)
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
    const stopWatching = onStillChange(update)
    update()
    return () => {
      cancelAnimationFrame(request)
      visibility.disconnect()
      theme.disconnect()
      stopWatching()
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

// What a system's agents are doing, the parts that need you first.
function countLine({ waiting, running, finished }: System): string {
  const parts = [waiting > 0 && `${waiting} waiting`, running > 0 && `${running} running`].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : `${finished} finished`
}

const spokeTone = (system: System) => (system.waiting > 0 ? 'waiting' : system.running > 0 ? 'running' : 'idle')

// Galactic lanes, a spoke from you to each system, and each system's sun. Spokes and suns redden
// while a system has anything waiting on you.
function Galaxy({ id, systems, lanes }: { id: string; systems: System[]; lanes: BackdropNode['data']['lanes'] }) {
  return (
    <g className="galaxy">
      <defs>
        {['calm', 'waiting'].map((tone) => (
          <radialGradient key={tone} id={`${id}-sun-${tone}`}>
            <stop offset="0" className={`sun-light ${tone}`} />
            <stop offset="1" className={`sun-light ${tone}`} stopOpacity={0} />
          </radialGradient>
        ))}
      </defs>
      {lanes.map((lane) => (
        <circle key={lane.tone} className={`galaxy-lane lane-${lane.tone}`} r={lane.r} />
      ))}
      {systems.map((system) => {
        const distance = Math.hypot(system.cx, system.cy) || 1
        const [cos, sin] = [system.cx / distance, system.cy / distance]
        const to = Math.max(SPOKE_FROM, distance - system.r)
        return <line key={system.name} className={`spoke spoke-${spokeTone(system)}`} x1={cos * SPOKE_FROM} y1={sin * SPOKE_FROM} x2={cos * to} y2={sin * to} />
      })}
      {systems.map((system) => {
        const tone = system.waiting > 0 ? 'waiting' : 'calm'
        return (
          <g key={system.name} className={`sun ${tone}`} transform={`translate(${system.cx} ${system.cy})`}>
            <g className="sun-body">
              <circle r={SUN_GLOW} fill={`url(#${id}-sun-${tone})`} />
              <circle className="sun-disc" r={SUN_RADIUS} />
            </g>
          </g>
        )
      })}
    </g>
  )
}

// A monorepo area's name, or a room's "Hide finished" button, just outside its system's rings,
// turning with them.
function AreaLabel({ sector, centre, turns, box, onCollapse }: { sector: Sector; centre: { cx: number; cy: number }; turns: Turns; box: Box; onCollapse: (room: string) => void }) {
  if (!sector.label && !sector.foldable) return null
  const angle = sector.mid + turns[sector.ring]
  const [cos, sin] = [Math.cos(angle), Math.sin(angle)]
  return (
    <div className="sector-label area" style={{ left: centre.cx + cos * sector.r - box.x, top: centre.cy + sin * sector.r - box.y, '--cos': cos, '--sin': sin } as CSSProperties}>
      {sector.label && <span className="area-name">{sector.label}</span>}
      {sector.foldable && (
        <button type="button" className="room-fold nodrag" data-room={sector.name} onClick={() => onCollapse(sector.name)}>
          Hide finished
        </button>
      )}
    </div>
  )
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
// T.Y.C.H.O.'s usage gauge: the session's window on the inner ring, the week's outside it, both just
// outside the turning dial. Each also marks how far through its window you are.
const GAUGES = [
  { key: 'fiveHour', r: 180, width: 3.5, span: 5 * HOUR_MS },
  { key: 'sevenDay', r: 190, width: 2, span: 7 * 24 * HOUR_MS },
] as const
const TIME_TICK = 6

// An arc that fills clockwise from the top to the share used, over a faint track. The tick says how
// much of the window has gone, so an arc ahead of its tick is using the plan faster than time passes.
function UsageGauge({ usage, now }: { usage: Usage; now: number }) {
  return (
    <g className="usage-gauge">
      {GAUGES.map(({ key, r, width, span }) => {
        const window = current(usage[key], now)
        if (!window) return null
        const gone = window.resetsAt === null ? null : 1 - Math.min(1, Math.max(0, (window.resetsAt - now) / span))
        const angle = gone === null ? 0 : 2 * Math.PI * gone - Math.PI / 2
        return (
          <g key={key} className={`gauge usage-${toneOf(window.percent)}`}>
            <circle className="gauge-track" r={r} strokeWidth={width} />
            <circle className="gauge-fill" r={r} strokeWidth={width} pathLength={100} strokeDasharray={`${window.percent} 100`} transform="rotate(-90)" />
            {gone !== null && (
              <line className="gauge-time" x1={Math.cos(angle) * (r - TIME_TICK)} y1={Math.sin(angle) * (r - TIME_TICK)} x2={Math.cos(angle) * (r + TIME_TICK)} y2={Math.sin(angle) * (r + TIME_TICK)} />
            )}
          </g>
        )
      })}
    </g>
  )
}

function caption(waiting: number): string {
  if (waiting === 0) return 'Nothing needs you'
  return `${waiting} ${waiting === 1 ? 'needs' : 'need'} you`
}

// Rings, sector boundaries and room names, with you at the centre. It sits behind every agent
// and lets clicks through, except on its own buttons. Labels turn with their rings.
export function OrreryBackdrop({ data }: NodeProps<BackdropNode>) {
  const { arrangement, box, rings, sectors, systems, lanes, turns, waiting, waited, usage, onCollapse } = data
  const now = Date.now()
  const windows = usage ? windowsOf(usage, now) : []
  const hud = useContext(HudContext)
  const id = useId()
  const outer = rings[rings.length - 1]
  const labelled = rings.filter((ring) => ring.label)
  const centres = new Map(systems.map((system) => [system.name, system]))
  const centreOf = (system?: string) => (system && centres.get(system)) || ORIGIN

  return (
    <div className="orrery-backdrop">
      <svg viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`} aria-hidden="true">
        <defs>
          {labelled.map((ring) => (
            <path key={ring.key} id={`${id}-${ring.key}`} d={topArc(ring.r)} />
          ))}
        </defs>
        {systems.length > 0 && <Galaxy id={id} systems={systems} lanes={lanes} />}
        {rings.map((ring) => (
          <circle key={ring.key} className={`orrery-ring ring-${ring.tone}${ring.system ? ' in-system' : ''}`} {...centreOf(ring.system)} r={ring.r} />
        ))}
        <g transform={`rotate(${degrees(turns[outer.key])})`}>
          {arrangement === 'status' && sectors.slice(1).map((sector) => (
            <line
              key={sector.name}
              className="orrery-boundary"
              x1={Math.cos(sector.start) * (outer.r + TICK_FROM)}
              y1={Math.sin(sector.start) * (outer.r + TICK_FROM)}
              x2={Math.cos(sector.start) * (outer.r + TICK_TO)}
              y2={Math.sin(sector.start) * (outer.r + TICK_TO)}
            />
          ))}
        </g>
        {labelled.map((ring) => (
          <text key={ring.key} className="orrery-ring-label" dy={-8} transform={`rotate(${degrees(turns[ring.key])})`}>
            <textPath href={`#${id}-${ring.key}`} startOffset="50%">
              {ring.label}
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
        {hud && usage && <UsageGauge usage={usage} now={now} />}
      </svg>

      <div className="orrery-core" style={{ left: -box.x, top: -box.y }}>
        <CoreOrb waiting={waiting > 0} />
        <span className={waiting > 0 ? 'core-caption why' : 'core-caption'}>{caption(waiting)}</span>
        {hud && waited >= MINUTE_MS && <span className="core-readout">{duration(waited)} on you today</span>}
        {hud && windows.length > 0 && (
          <span className={`core-readout usage-${toneOf(Math.max(...windows.map(({ window }) => window.percent)))}`}>
            {windows.map(({ name, window }) => `${name} ${Math.round(window.percent)}%`).join(' · ')}
            {usage && isStale(usage, now) ? ` · ${ago(usage.at, now)} ago` : ''}
          </span>
        )}
      </div>

      {/* A system's name and counts hang below its rings, where its orbs never pass over them. */}
      {systems.map((system) => (
        <div key={system.name} className="system-label" style={{ left: system.cx - box.x, top: system.cy + system.drop - box.y }}>
          <span className="system-name serif">{system.name}</span>
          <span className={system.waiting > 0 ? 'system-count why' : 'system-count'}>{countLine(system)}</span>
        </div>
      ))}

      {sectors.map((sector) => {
        if (sector.system) return <AreaLabel key={sector.name} sector={sector} centre={centreOf(sector.system)} turns={turns} box={box} onCollapse={onCollapse} />
        const angle = sector.mid + turns[sector.ring]
        const [cos, sin] = [Math.cos(angle), Math.sin(angle)]
        // A sector's name sits outside the rings, pushed further out at the sides; a room ring's sits in its gap.
        const reach = arrangement === 'status' ? sector.r + Math.abs(cos) * ROOM_LABEL_SIDE_REACH : sector.r
        return (
          <div
            key={sector.name}
            className={arrangement === 'status' ? 'sector-label' : 'sector-label on-ring'}
            style={{ left: cos * reach - box.x, top: sin * reach - box.y, '--cos': cos, '--sin': sin } as CSSProperties}
          >
            <span className="serif">{sector.name}</span>
            {sector.foldable && (
              <button type="button" className="room-fold nodrag" data-room={sector.name} onClick={() => onCollapse(sector.name)}>
                Hide finished
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
