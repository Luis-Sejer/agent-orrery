import { useCallback, useEffect, useRef, useState } from 'react'

import { statusOf } from './status'
import type { AgentNode } from './types'

const STORAGE_KEY = 'agent-orrery:notifications'

// One key per wait, so a session that waits again after you reply notifies again.
const waitKey = (node: AgentNode) => `${node.id}:${node.waiting?.since ?? 0}`

// The sessions that started waiting since the last look, and the keys to remember for next time.
export function newWaits(seen: ReadonlySet<string> | null, nodes: AgentNode[], now: number): { fresh: AgentNode[]; keys: Set<string> } {
  const waiting = nodes.filter((node) => statusOf(node, now) === 'waiting')
  const fresh = seen ? waiting.filter((node) => !seen.has(waitKey(node))) : []
  return { fresh, keys: new Set(waiting.map(waitKey)) }
}

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

function lookingElsewhere(): boolean {
  return document.visibilityState !== 'visible' || !document.hasFocus()
}

interface NotificationOptions {
  nodes: AgentNode[]
  now: number
  // Notifications only start once the first data has arrived, so sessions that were
  // already waiting when the page opened don't all notify at once.
  loaded: boolean
  onOpen: (id: string) => void
}

export function useNotifications({ nodes, now, loaded, onOpen }: NotificationOptions) {
  const supported = typeof Notification !== 'undefined'
  const [enabled, setEnabled] = useState(() => supported && Notification.permission === 'granted' && storedOn())
  const [blocked, setBlocked] = useState(() => supported && Notification.permission === 'denied')
  const seen = useRef<Set<string> | null>(null)
  const openRef = useRef(onOpen)
  openRef.current = onOpen

  useEffect(() => {
    if (!loaded) return
    const { fresh, keys } = newWaits(seen.current, nodes, now)
    if (enabled && lookingElsewhere()) {
      for (const node of fresh) {
        const where = node.room ? ` in ${node.room}` : ''
        const asked = node.waiting?.probably ? 'Probably asking you a question' : 'Asked you a question'
        const body = node.waiting?.reason === 'question' ? `${asked}${where}` : `Finished${where}, waiting on you`
        const notification = new Notification(node.label, { body, tag: node.id })
        notification.onclick = () => {
          window.focus()
          openRef.current(node.id)
          notification.close()
        }
      }
    }
    // Waits seen before stay seen, so one that leaves and comes back isn't announced twice.
    seen.current = new Set([...(seen.current ?? []), ...keys])
  }, [nodes, now, loaded, enabled])

  const toggle = useCallback(async () => {
    if (!supported) return
    if (enabled) {
      setEnabled(false)
      store(false)
      return
    }
    const permission = await Notification.requestPermission()
    setBlocked(permission === 'denied')
    if (permission !== 'granted') return
    setEnabled(true)
    store(true)
  }, [enabled, supported])

  return { supported, enabled, blocked, toggle }
}
