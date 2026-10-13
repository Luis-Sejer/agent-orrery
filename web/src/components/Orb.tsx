import { useContext, useEffect, useRef, type CSSProperties } from 'react'
import type { OrbSize, OrbState } from 'thinking-orbs'

import { useStill } from '../motion'
import { startOrb, toTint } from '../orbTicker'
import { orbSpeed } from '../rhythm'
import { stateColour } from '../status'
import { HudContext } from '../useTheme'

// The small presets' dots get lost on a white card; heavier dots keep the state readable.
const SMALL_DOT_SIZE = 1.6

interface OrbProps {
  state: OrbState
  size: OrbSize
  // Dashed orbit rings, which mark a session as opposed to a subagent.
  ring?: boolean
  // Gives the orb its own speed, so orbs don't animate in step.
  seed?: string
}

export function Orb({ state, size, ring = false, seed }: OrbProps) {
  const colour = stateColour(state, useContext(HudContext))
  const still = useStill()
  const canvas = useRef<HTMLCanvasElement>(null)
  const dotSize = size === 64 ? 1.2 : SMALL_DOT_SIZE
  const speed = seed ? orbSpeed(seed) : 1
  // A finished agent's orb (breathing) holds still, as does every orb when motion is paused.
  useEffect(() => startOrb(canvas.current!, { state, size, tint: toTint(colour), dotSize, speed }, still || state === 'breathing'), [state, size, colour, dotSize, speed, still])
  const style = { '--state': colour } as CSSProperties
  return (
    <span className={`orb orb-${size}${ring ? ' orb-ring' : ''}`} style={style}>
      {ring && (
        <svg className="orbit" viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="32" r="30" />
          <circle cx="32" cy="32" r="24" />
        </svg>
      )}
      {/* Decoration: the text next to every orb already says what it shows. */}
      <canvas ref={canvas} aria-hidden="true" style={{ width: size, height: size }} />
    </span>
  )
}
