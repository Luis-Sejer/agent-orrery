import { useEffect, useState } from 'react'

// One answer to "should things move?": not when the system asks for reduced motion, and not when
// Pause motion is on in the settings, which sets data-still on <html>. The stylesheet asks the same
// two questions.
const REDUCED = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null

export function prefersStill(): boolean {
  return document.documentElement.hasAttribute('data-still') || !!REDUCED?.matches
}

// Calls back whenever the answer may have changed.
export function onStillChange(callback: () => void): () => void {
  const switched = new MutationObserver(callback)
  switched.observe(document.documentElement, { attributeFilter: ['data-still'] })
  REDUCED?.addEventListener('change', callback)
  return () => {
    switched.disconnect()
    REDUCED?.removeEventListener('change', callback)
  }
}

export function useStill(): boolean {
  const [still, setStill] = useState(prefersStill)
  useEffect(() => onStillChange(() => setStill(prefersStill())), [])
  return still
}
