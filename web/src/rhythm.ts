import type { CSSProperties } from 'react'

const BEAM_SECONDS = 3.4
const BEAM_SPREAD = 0.24
const ORB_SPEED_SPREAD = 0.16

// A stable number in [0, 1) from an id (FNV-1a), so each card keeps its own timing across redraws.
export function phaseOf(id: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  // MurmurHash3's finaliser: ids that differ only in their last character still land far apart.
  hash ^= hash >>> 16
  hash = Math.imul(hash, 0x85ebca6b)
  hash ^= hash >>> 13
  hash = Math.imul(hash, 0xc2b2ae35)
  hash ^= hash >>> 16
  return (hash >>> 0) / 0x100000000
}

// Beams that start at different points and run at slightly different speeds, so a column of
// waiting cards doesn't pulse in lockstep.
export function beamStyle(id: string): CSSProperties {
  const phase = phaseOf(id)
  const duration = BEAM_SECONDS * (1 - BEAM_SPREAD / 2 + phase * BEAM_SPREAD)
  return { '--beam-duration': `${duration.toFixed(2)}s`, '--beam-delay': `${(-phase * duration).toFixed(2)}s` } as CSSProperties
}

export function orbSpeed(id: string): number {
  return 1 - ORB_SPEED_SPREAD / 2 + phaseOf(`orb:${id}`) * ORB_SPEED_SPREAD
}
