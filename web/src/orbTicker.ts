import { MODE_FRAMES, resolvePreset, scaleRadii, type OrbSize, type OrbState } from 'thinking-orbs'
import { paintFrame } from 'thinking-orbs/engine'

// One animation loop for every orb, at about 30 frames a second. thinking-orbs' own component runs a
// 60 fps loop per orb, which was most of the page's work with a few dozen agents on screen.
const FRAME_MS = 33
// Where a still orb is painted, in seconds: thinking-orbs' own still frame.
export const STILL_AT = 0.6

export type Tint = { r: number; g: number; b: number }

export function toTint(colour: string): Tint {
  const [r, g, b] = colour.match(/[\da-f]{2}/gi)!.map((pair) => parseInt(pair, 16))
  return { r, g, b }
}

export interface OrbLook {
  state: OrbState
  size: OrbSize
  tint: Tint
  dotSize: number
  speed: number
}

type Painter = { paint: (seconds: number) => void; visible: boolean }

const painters = new Set<Painter>()
let request = 0
let last = 0

function loop(now: number) {
  request = painters.size > 0 ? requestAnimationFrame(loop) : 0
  if (now - last < FRAME_MS) return
  last = now
  for (const painter of painters) if (painter.visible) painter.paint(now / 1000)
}

const isDark = () => document.documentElement.dataset.theme === 'dark'

// Paints an orb into a canvas. A still orb is painted once, and again when the theme changes; a moving
// one joins the shared loop, and is skipped while it's off screen. Returns the clean-up.
export function startOrb(canvas: HTMLCanvasElement, look: OrbLook, still: boolean): () => void {
  const context = canvas.getContext('2d')
  if (!context) return () => {}
  const ratio = Math.min(2, devicePixelRatio || 1)
  canvas.width = canvas.height = Math.round(look.size * ratio)
  const { mode, speed: base, opts } = resolvePreset(look.state, look.size)
  const scaled = look.dotSize === 1 ? opts : scaleRadii(opts, look.dotSize)
  const frameFor = MODE_FRAMES[mode]
  const paint = (seconds: number) => {
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, look.size, look.size)
    paintFrame(context, frameFor(look.size, seconds * base * look.speed, scaled), isDark(), look.tint)
  }

  if (still) {
    paint(STILL_AT)
    const themed = new MutationObserver(() => paint(STILL_AT))
    themed.observe(document.documentElement, { attributeFilter: ['data-theme'] })
    return () => themed.disconnect()
  }

  const painter: Painter = { paint, visible: true }
  const seen = new IntersectionObserver(([entry]) => {
    painter.visible = entry.isIntersecting
  })
  seen.observe(canvas)
  paint(performance.now() / 1000)
  painters.add(painter)
  if (!request) request = requestAnimationFrame(loop)
  return () => {
    seen.disconnect()
    painters.delete(painter)
  }
}
