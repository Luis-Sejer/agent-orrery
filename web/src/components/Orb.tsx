import type { CSSProperties } from 'react'
import { ThinkingOrb, type OrbSize, type OrbState } from 'thinking-orbs'

import { STATE_COLOURS } from '../status'

// The small presets' dots get lost on a white card; heavier dots keep the state readable.
const SMALL_DOT_SIZE = 1.6

interface OrbProps {
  state: OrbState
  size: OrbSize
  // Dashed orbit rings, which mark a session as opposed to a subagent.
  ring?: boolean
}

export function Orb({ state, size, ring = false }: OrbProps) {
  const colour = STATE_COLOURS[state]
  const style = { '--state': colour } as CSSProperties
  return (
    <span className={`orb orb-${size}${ring ? ' orb-ring' : ''}`} style={style}>
      {ring && (
        <svg className="orbit" viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="32" r="30" />
          <circle cx="32" cy="32" r="24" />
        </svg>
      )}
      <ThinkingOrb
        state={state}
        size={size}
        theme="light"
        color={colour}
        dotSize={size === 64 ? 1.2 : SMALL_DOT_SIZE}
        paused={state === 'breathing'}
      />
    </span>
  )
}
