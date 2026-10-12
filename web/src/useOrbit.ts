import { useEffect, useRef, useState } from 'react'

import type { FlowNode } from './layout'
import { placeAt, turnsAt, type OrreryNode, type Polar } from './radial'

export type CanvasNode = FlowNode | OrreryNode

// About 30 frames a second is plenty for rings that take minutes per lap.
const FRAME_MS = 33
// A moved agent glides to its new place and settles in about 600 ms.
const EASE_RATE = 7
// After a hidden tab or a long frame, step at most this far, so nothing jumps.
const MAX_STEP_SECONDS = 0.1
// Pausing eases the rings to a stop, and back up, in about 400 ms.
const PACE_RATE = 7.5
const STOPPED = 0.001
const SETTLED_RADIANS = 0.0005
const SETTLED_PX = 0.3

const shortest = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from))

// Turns the orrery's rings, and glides agents between rings when their status changes. Positions
// are worked out each frame from the layout and how far the rings have turned, so edges, the
// minimap and focus all follow. Rings ease to a stop while paused, and never turn under reduced motion.
export function useOrbit(nodes: CanvasNode[], polar: Map<string, Polar> | null, paused: boolean): CanvasNode[] {
  const [frame, setFrame] = useState<CanvasNode[] | null>(null)
  const input = useRef({ nodes, polar, paused })
  input.current = { nodes, polar, paused }
  const orbiting = polar !== null

  useEffect(() => {
    if (!orbiting) return
    const reduced = matchMedia('(prefers-reduced-motion: reduce)')
    const shown = new Map<string, { angle: number; r: number }>()
    let seconds = 0
    // How fast the rings turn, from 0 (steadied) to 1 (full speed).
    let pace = 1
    let last = performance.now()
    let drawn: CanvasNode[] | null = null
    let settled = false
    let request = 0

    const tick = (now: number) => {
      request = requestAnimationFrame(tick)
      if (now - last < FRAME_MS) return
      const step = Math.min(MAX_STEP_SECONDS, (now - last) / 1000)
      last = now
      const { nodes, polar, paused } = input.current
      if (!polar) return
      const still = reduced.matches
      pace += ((paused ? 0 : 1) - pace) * (1 - Math.exp(-PACE_RATE * step))
      if (pace < STOPPED) pace = 0
      if (!still) seconds += step * pace
      if ((still || pace === 0) && settled && drawn === nodes) return
      const turns = turnsAt(still ? 0 : seconds)
      const ease = still ? 1 : 1 - Math.exp(-EASE_RATE * step)
      settled = true
      const next = nodes.map((node) => {
        if (node.type === 'backdrop') return { ...node, data: { ...node.data, turns } }
        const at = polar.get(node.id)
        if (!at) return node
        const goal = { angle: at.angle + turns[at.ring], r: at.r }
        const was = shown.get(node.id) ?? goal
        const turn = shortest(was.angle, goal.angle)
        const angle = was.angle + turn * ease
        const r = was.r + (goal.r - was.r) * ease
        if (Math.abs(turn) > SETTLED_RADIANS || Math.abs(goal.r - r) > SETTLED_PX) settled = false
        shown.set(node.id, { angle, r })
        return placeAt(node as OrreryNode, angle, r)
      })
      drawn = nodes
      setFrame(next)
    }
    request = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(request)
  }, [orbiting])

  return orbiting && frame ? frame : nodes
}
