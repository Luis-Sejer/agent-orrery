import { useCallback, useEffect, useMemo, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'

import { Drawer } from './components/Drawer'
import { GraphCanvas } from './components/GraphCanvas'
import { Icon } from './components/Icon'
import { Inbox } from './components/Inbox'
import { Library } from './components/Library'
import { ReplayBar } from './components/ReplayBar'
import { SearchPalette } from './components/SearchPalette'
import { statusOf } from './status'
import type { Filter, View } from './types'
import { applyDismissals, useDismissed } from './useDismissed'
import { useGraph, useNow } from './useGraph'
import { useNotifications } from './useNotifications'
import { useReplay } from './useReplay'
import { useTheme } from './useTheme'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'waiting', label: 'Waiting on you' },
  { value: 'running', label: 'Running' },
  { value: 'finished', label: 'Finished' },
]

const VIEWS: { value: View; label: string }[] = [
  { value: 'graph', label: 'Agents' },
  { value: 'plans', label: 'Plans' },
  { value: 'memory', label: 'Memory' },
]

const THEME_ICONS = { system: 'system', light: 'sun', dark: 'moon' } as const
const THEME_NAMES = { system: 'system', light: 'light', dark: 'dark' }
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform)

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}

export function App() {
  const { graph: liveGraph, connection, loaded } = useGraph()
  const clock = useNow()
  const replay = useReplay()
  // While replaying, time stands still at the replay moment, so every status and "ago" matches it.
  const now = replay.view ? replay.view.at : clock
  const { dismissals, dismiss, restoreAll } = useDismissed()
  const { preference, theme, cycle: cycleTheme, next: nextTheme } = useTheme()
  const graph = useMemo(() => replay.view?.graph ?? applyDismissals(liveGraph, dismissals), [replay.view, liveGraph, dismissals])
  const dismissedCount = graph.nodes.filter((node) => node.dismissed).length
  const [view, setView] = useState<View>('graph')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusRequest, setFocusRequest] = useState<{ id: string; at: number } | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [expandedRooms, setExpandedRooms] = useState<ReadonlySet<string>>(new Set())
  const [openRequest, setOpenRequest] = useState<{ key: string; at: number } | null>(null)
  const [searching, setSearching] = useState(false)

  const nodesById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph])
  const selected = selectedId ? (nodesById.get(selectedId) ?? null) : null
  const waitingCount = graph.nodes.filter((node) => statusOf(node, now) === 'waiting').length

  useEffect(() => {
    document.title = waitingCount > 0 ? `(${waitingCount}) Agent Orrery` : 'Agent Orrery'
  }, [waitingCount])

  // Selecting from a list or a notification also moves the canvas to the agent.
  const selectAndFocus = useCallback((id: string) => {
    setView('graph')
    setSelectedId(id)
    setFocusRequest({ id, at: Date.now() })
  }, [])

  // The menu bar companion opens the dashboard at #agent=<id>.
  useEffect(() => {
    if (!loaded) return
    const openFromHash = () => {
      const id = new URLSearchParams(window.location.hash.slice(1)).get('agent')
      if (!id || !nodesById.has(id)) return
      history.replaceState(null, '', window.location.pathname + window.location.search)
      selectAndFocus(id)
    }
    openFromHash()
    window.addEventListener('hashchange', openFromHash)
    return () => window.removeEventListener('hashchange', openFromHash)
  }, [loaded, nodesById, selectAndFocus])

    const notifications = useNotifications({ nodes: graph.nodes, now, loaded: loaded && !replay.open, onOpen: selectAndFocus })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const searchShortcut = (event.key === 'k' && (event.metaKey || event.ctrlKey)) || (event.key === '/' && !isTyping(event.target))
      if (searchShortcut) {
        event.preventDefault()
        setSearching(true)
      } else if (event.key === 'Escape') setSelectedId(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const expandRoom = useCallback((room: string) => setExpandedRooms((rooms) => new Set(rooms).add(room)), [])
  const collapseRoom = useCallback(
    (room: string) =>
      setExpandedRooms((rooms) => {
        const next = new Set(rooms)
        next.delete(room)
        return next
      }),
    [],
  )

  const openInLibrary = useCallback((kind: 'plans' | 'memory', key: string) => {
    setOpenRequest({ key, at: Date.now() })
    setView(kind)
  }, [])
  const openPlan = useCallback((name: string) => openInLibrary('plans', name), [openInLibrary])
  const openNote = useCallback((project: string, name: string) => openInLibrary('memory', `${project}/${name}`), [openInLibrary])

  function switchView(next: View) {
    setOpenRequest(null)
    setView(next)
  }

  const notificationLabel = notifications.blocked
    ? 'Notifications are blocked in your browser settings'
    : notifications.enabled
      ? 'Notifications are on; turn them off'
      : 'Notify me when an agent is waiting on me'

  return (
    <div className={`app${selected && view === 'graph' ? ' with-drawer' : ''}`}>
      <Inbox
        nodes={graph.nodes}
        now={now}
        connection={connection}
        selectedId={selectedId}
        dismissedCount={dismissedCount}
        onSelect={selectAndFocus}
        onDismiss={dismiss}
        onRestoreDismissed={restoreAll}
      />

      <main className="stage">
        <div className="toolbar">
          <button type="button" className="search-button" onClick={() => setSearching(true)}>
            <Icon name="search" />
            <span>Search everything</span>
            <kbd>{IS_MAC ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
          {view === 'graph' && (
            <div className="tabs" role="group" aria-label="Show">
              {FILTERS.map((option) => (
                <button key={option.value} type="button" className={filter === option.value ? 'on' : ''} aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>
                  {option.label}
                </button>
              ))}
            </div>
          )}
          <div className="tabs views" role="group" aria-label="View">
            {VIEWS.map((option) => (
              <button key={option.value} type="button" className={view === option.value ? 'on' : ''} aria-pressed={view === option.value} onClick={() => switchView(option.value)}>
                {option.label}
              </button>
            ))}
          </div>
          <div className="tabs" role="group" aria-label="Replay">
            <button type="button" className={replay.open ? 'on' : ''} aria-pressed={replay.open} onClick={replay.open ? replay.stop : replay.start}>
              Replay
            </button>
          </div>
          {notifications.supported && (
            <button
              type="button"
              className={`icon-button${notifications.enabled ? ' on' : ''}`}
              aria-label={notificationLabel}
              title={notificationLabel}
              aria-pressed={notifications.enabled}
              disabled={notifications.blocked}
              onClick={notifications.toggle}
            >
              <Icon name={notifications.enabled ? 'bell' : 'bellOff'} />
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label={`Theme: ${THEME_NAMES[preference]}. Switch to ${THEME_NAMES[nextTheme]}`}
            title={`Theme: ${THEME_NAMES[preference]}`}
            onClick={cycleTheme}
          >
            <Icon name={THEME_ICONS[preference]} />
          </button>
        </div>

        {view === 'graph' && (
          <>
            <ReactFlowProvider>
              <GraphCanvas
                graph={graph}
                theme={theme}
                now={now}
                selectedId={selectedId}
                expandedRooms={expandedRooms}
                filter={filter}
                onExpand={expandRoom}
                onCollapse={collapseRoom}
                focusRequest={focusRequest}
                onSelect={setSelectedId}
              />
            </ReactFlowProvider>
            {loaded && graph.nodes.length === 0 && (
              <p className="canvas-empty">No Claude Code activity in the last few hours. Start a session and it appears here.</p>
            )}
          </>
        )}
        {replay.open && (
          <ReplayBar at={replay.at} now={clock} windowMs={replay.windowMs} playing={replay.playing} onSeek={replay.seek} onTogglePlay={replay.togglePlay} onLive={replay.stop} />
        )}
        {view !== 'graph' && <Library key={view} kind={view} nodes={graph.nodes} now={now} openRequest={openRequest} onSelectNode={selectAndFocus} />}
      </main>

      {selected && view === 'graph' && (
        <Drawer
          node={selected}
          parent={selected.parentId ? (nodesById.get(selected.parentId) ?? null) : null}
          children={graph.nodes.filter((node) => node.parentId === selected.id)}
          now={now}
          onClose={() => setSelectedId(null)}
          onSelect={selectAndFocus}
          onOpenPlan={openPlan}
          onDismiss={dismiss}
        />
      )}

      <SearchPalette
        open={searching}
        nodes={graph.nodes}
        now={now}
        onClose={() => setSearching(false)}
        onSelectNode={selectAndFocus}
        onOpenPlan={openPlan}
        onOpenNote={openNote}
      />
    </div>
  )
}
