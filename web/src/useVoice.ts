import { useCallback, useEffect, useRef, useState } from 'react'

import type { AgentNode } from './types'
import { newWaits } from './useNotifications'

const STORAGE_KEY = 'agent-orrery:voice'
// Spelled the way it's said; speech engines read "T.Y.C.H.O." letter by letter and "Tycho" wrongly.
const GREETING = 'Tyko online.'
// macOS novelty and compact voices, which sound like toys or robots.
const NOVELTY = /\b(Fred|Albert|Bad News|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/

function storedOn(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on'
  } catch {
    return false
  }
}

function store(on: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off')
  } catch {
    // Storage can be off (private window); the choice then lasts until the page reloads.
  }
}

// "storefront-api" reads better aloud as "storefront api".
const sayable = (text: string) => text.replace(/[-_/]+/g, ' ')

export function announcement(node: AgentNode): string {
  const where = node.room ? ` in ${sayable(node.room)}` : ''
  return node.waiting?.reason === 'question' ? `${node.label} asked you a question${where}.` : `${node.label} is waiting on you${where}.`
}

// The best British voice on this machine: Premium, then Enhanced, then Daniel, then any British,
// then any English, then the default. Only voices that run locally: a network voice would send
// session titles to a speech service.
export function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const usable = voices.filter((voice) => voice.localService && !NOVELTY.test(voice.name))
  const british = usable.filter((voice) => voice.lang.replace('_', '-').startsWith('en-GB'))
  const named = (pattern: RegExp) => british.find((voice) => pattern.test(voice.name))
  return (
    named(/Premium/) ??
    named(/Enhanced/) ??
    named(/\bDaniel\b/) ??
    british[0] ??
    usable.find((voice) => voice.lang.startsWith('en')) ??
    usable.find((voice) => voice.default) ??
    null
  )
}

interface VoiceOptions {
  nodes: AgentNode[]
  now: number
  // Like notifications, only waits that start after the first data has arrived are announced.
  loaded: boolean
  hud: boolean
}

// Says out loud when a session starts waiting on you, even while you're looking at the page.
export function useVoice({ nodes, now, loaded, hud }: VoiceOptions) {
  const supported = typeof speechSynthesis !== 'undefined'
  const [enabled, setEnabled] = useState(() => supported && storedOn())
  const seen = useRef<Set<string> | null>(null)
  const greet = useRef(true)
  const voices = useRef<SpeechSynthesisVoice[]>([])

  // The list is often empty at first and fills in later.
  useEffect(() => {
    if (!supported) return
    const load = () => {
      voices.current = speechSynthesis.getVoices()
    }
    load()
    speechSynthesis.addEventListener('voiceschanged', load)
    return () => speechSynthesis.removeEventListener('voiceschanged', load)
  }, [supported])

  useEffect(() => {
    if (!loaded) return
    const { fresh, keys } = newWaits(seen.current, nodes, now)
    // Waits seen before stay seen, so one that leaves and comes back isn't announced twice.
    seen.current = new Set([...(seen.current ?? []), ...keys])
    const voice = enabled && fresh.length > 0 ? pickVoice(voices.current) : null
    if (!voice) return
    for (const node of fresh) {
      const utterance = new SpeechSynthesisUtterance(announcement(node))
      utterance.voice = voice
      if (hud && greet.current) {
        utterance.text = `${GREETING} ${utterance.text}`
        greet.current = false
      }
      speechSynthesis.speak(utterance)
    }
  }, [nodes, now, loaded, enabled, hud])

  const toggle = useCallback(() => {
    if (enabled) speechSynthesis.cancel()
    greet.current = !enabled
    setEnabled(!enabled)
    store(!enabled)
  }, [enabled])

  return { supported, enabled, toggle }
}
