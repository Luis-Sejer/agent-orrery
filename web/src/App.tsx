import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'

import { Drawer } from './components/Drawer'
import { GraphCanvas } from './components/GraphCanvas'
import { Icon } from './components/Icon'
import { Inbox, TurnOverlay } from './components/Inbox'
import { Library } from './components/Library'
import { ReplayBar } from './components/ReplayBar'
import { SearchPalette } from './components/SearchPalette'
import { SettingsMenu } from './components/SettingsMenu'
import { awaitAgents, statusOf } from './status'
import type { Filter, View } from './types'
import { foldWorktrees } from './rooms'
import { applyDismissals, useDismissed } from './useDismissed'
import { useGraph, useNow } from './useGraph'
import { useNotifications } from './useNotifications'
import { useReplay } from './useReplay'
import { HudContext, useTheme } from './useTheme'
import { useArrangement, useCleanView, usePauseMotion, useView, useWorktreeRooms } from './useView'
import { useVoice } from './useVoice'

const VIEWS: { value: View; label: string }[] = [
  { value: 'orrery', label: 'Orrery' },
  { value: 'graph', label: 'Agents' },
  { value: 'plans', label: 'Plans' },
  { value: 'memory', label: 'Memory' },
]

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform)
// A control appears once React and React Flow have drawn it; look for it this often, this many times.
const FOCUS_RETRY_MS = 30
const FOCUS_TRIES = 15

// Moves focus to whatever the selector finds, once it exists. preventScroll keeps the canvas from
// scrolling its overflow to the element, which would throw it out of line with React Flow. A timer,
// not an animation frame: a page with nothing to repaint may not get a frame for a while.
function focusSoon(selector: string, tries = FOCUS_TRIES) {
  setTimeout(() => {
    const element = document.querySelector<HTMLElement>(selector)
    if (element) element.focus({ preventScroll: true })
    else if (tries > 1) focusSoon(selector, tries - 1)
  }, FOCUS_RETRY_MS)
}

const byRoom = (selector: string, room: string) => `${selector}[data-room="${CSS.escape(room)}"]`
const isShown = (element: HTMLElement | null): element is HTMLElement => !!element?.isConnected && element.getClientRects().length > 0

export function App() {
  const { graph: liveGraph, connection, loaded } = useGraph()
  const clock = useNow()
  const replay = useReplay()
  // While replaying, time stands still at the replay moment, so every status and "ago" matches it.
  const now = replay.view ? replay.view.at : clock
  const { dismissals, dismiss, restoreAll } = useDismissed()
  const { preference, theme, hud, choose: chooseTheme } = useTheme()
  const [worktreeRooms, setWorktreeRooms] = useWorktreeRooms()
  const graph = useMemo(() => {
    const shown = replay.view?.graph ?? applyDismissals(liveGraph, dismissals)
    return awaitAgents(worktreeRooms === 'on' ? shown : foldWorktrees(shown), now)
  }, [replay.view, liveGraph, dismissals, worktreeRooms, now])
  const dismissedCount = graph.nodes.filter((node) => node.dismissed).length
  const { view, setView, toCanvas } = useView()
  const [arrangement, arrange] = useArrangement()
  const [clean, setClean] = useCleanView()
  const onCanvas = view === 'graph' || view === 'orrery'
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusRequest, setFocusRequest] = useState<{ id: string; at: number } | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [expandedRooms, setExpandedRooms] = useState<ReadonlySet<string>>(new Set())
  const [openRequest, setOpenRequest] = useState<{ key: string; at: number } | null>(null)
  const [searching, setSearching] = useState(false)

  const nodesById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph])
  const selected = selectedId ? (nodesById.get(selectedId) ?? null) : null
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const waitingCount = graph.nodes.filter((node) => statusOf(node, now) === 'waiting').length

  useEffect(() => {
    document.title = waitingCount > 0 ? `(${waitingCount}) Agent Orrery` : 'Agent Orrery'
  }, [waitingCount])

  // Every motion check reads data-still (see motion.ts), so Pause motion holds the page still.
  useEffect(() => {
    document.documentElement.toggleAttribute('data-still', pauseMotion === 'on')
  }, [pauseMotion])

  // Opening the drawer moves focus to its heading; closing it gives focus back to what opened it.
  const opener = useRef<HTMLElement | null>(null)
  const [drawerOpened, setDrawerOpened] = useState(0)
  const select = useCallback((id: string) => {
    const from = document.activeElement
    if (from instanceof HTMLElement && !from.closest('.drawer')) opener.current = from
    setSelectedId(id)
    setDrawerOpened((count) => count + 1)
  }, [])
  const returnTo = useRef<HTMLElement | null>(null)
  const closeDrawer = useCallback(() => {
    returnTo.current = opener.current
    opener.current = null
    setSelectedId(null)
  }, [])
  // After the drawer has gone, so focus doesn't land on a button that is about to disappear.
  useEffect(() => {
    if (selectedId) return
    const back = returnTo.current
    returnTo.current = null
    if (isShown(back)) back.focus({ preventScroll: true })
  }, [selectedId])
  useEffect(() => {
    if (drawerOpened === 0) return
    const heading = document.querySelector<HTMLElement>('.drawer h2')
    heading?.focus({ preventScroll: true })
    heading?.scrollIntoView({ block: 'start' })
  }, [drawerOpened])
  // Clicking the empty canvas deselects without moving focus.
  const selectOnCanvas = useCallback((id: string | null) => (id ? select(id) : setSelectedId(null)), [select])

  // Selecting from a list or a notification also moves the canvas to the agent, on the canvas you used last.
  const selectAndFocus = useCallback(
    (id: string) => {
      toCanvas()
      select(id)
      setFocusRequest({ id, at: Date.now() })
    },
    [select],
  )

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
  const voice = useVoice({ nodes: graph.nodes, now, loaded: loaded && !replay.open, hud })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setSearching(true)
      } else if (event.key === 'Escape' && selectedRef.current && !(event.target instanceof Element && event.target.closest('dialog, [popover]'))) {
        // Escape in the search palette or the settings closes those, not the drawer behind them.
        closeDrawer()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeDrawer])

  // Opening a pile focuses its room's "Hide finished", and hiding them focuses the pile, so focus
  // never falls off a button that is gone.
  const expandRoom = useCallback((room: string) => {
    setExpandedRooms((rooms) => new Set(rooms).add(room))
    focusSoon(byRoom('.room-fold', room))
  }, [])
  const collapseRoom = useCallback((room: string) => {
    setExpandedRooms((rooms) => {
      const next = new Set(rooms)
      next.delete(room)
      return next
    })
    focusSoon(byRoom(':is(.fold, .pile)', room))
  }, [])

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

  const empty = loaded && graph.nodes.length === 0

  return (
    <HudContext.Provider value={hud}>
      <div className={`app${selected && onCanvas ? ' with-drawer' : ''}${clean === 'on' ? ' clean' : ''}`}>
        <Inbox
          nodes={graph.nodes}
          now={now}
          connection={replay.open ? 'replay' : connection}
          selectedId={selectedId}
          dismissedCount={dismissedCount}
          onSelect={selectAndFocus}
          onDismiss={replay.open ? undefined : dismiss}
          onRestoreDismissed={restoreAll}
        />

        <div className="toolbar">
          <button type="button" className="search-button" aria-label="Search everything" aria-keyshortcuts={IS_MAC ? 'Meta+K' : 'Control+K'} onClick={() => setSearching(true)}>
            <Icon name="search" />
            <span>Search everything</span>
            <kbd>{IS_MAC ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
          <div className="tabs views" role="group" aria-label="View">
            {VIEWS.map((option) => (
              <button key={option.value} type="button" className={view === option.value ? 'on' : ''} aria-pressed={view === option.value} onClick={() => switchView(option.value)}>
                {option.label}
              </button>
            ))}
          </div>
          <SettingsMenu
            onCanvas={onCanvas}
            inOrrery={view === 'orrery'}
            filter={filter}
            onFilter={setFilter}
            arrangement={arrangement}
            onArrange={arrange}
            replaying={replay.open}
            onReplay={replay.open ? replay.stop : replay.start}
            notifications={notifications}
            voice={voice}
            pauseMotion={pauseMotion === 'on'}
            onPauseMotion={(on) => setPauseMotion(on ? 'on' : 'off')}
            theme={preference}
            onTheme={chooseTheme}
            clean={clean === 'on'}
            onClean={(on) => setClean(on ? 'on' : 'off')}
            worktreeRooms={worktreeRooms === 'on'}
            onWorktreeRooms={(on) => setWorktreeRooms(on ? 'on' : 'off')}
          />
        </div>

        <main className={`stage${onCanvas ? '' : ' reading'}${empty && onCanvas ? ' empty' : ''}`}>

          {onCanvas && (
            <>
              {/* A new canvas when replay starts or ends, so it fits what's shown. */}
              <ReactFlowProvider key={`${view}-${replay.open ? (replay.view ? 'replay' : 'loading') : 'live'}`}>
                <GraphCanvas
                  layout={view === 'orrery' ? 'orrery' : 'grid'}
                  arrangement={arrangement}
                  graph={graph}
                  theme={theme}
                  now={now}
                  selectedId={selectedId}
                  expandedRooms={expandedRooms}
                  filter={filter}
                  onExpand={expandRoom}
                  onCollapse={collapseRoom}
                  focusRequest={focusRequest}
                  onSelect={selectOnCanvas}
                />
              </ReactFlowProvider>
              {empty && <p className="canvas-empty">No Claude Code activity in the last few hours. Start a session and it appears here.</p>}
              {clean === 'on' && <TurnOverlay nodes={graph.nodes} now={now} onSelect={selectAndFocus} />}
            </>
          )}
          {replay.open && (
            <ReplayBar at={replay.at} now={clock} windowMs={replay.windowMs} playing={replay.playing} onSeek={replay.seek} onTogglePlay={replay.togglePlay} onLive={replay.stop} />
          )}
          {!onCanvas && <Library key={view} kind={view} nodes={graph.nodes} now={now} openRequest={openRequest} onSelectNode={selectAndFocus} />}
        </main>

        {selected && onCanvas && (
          <Drawer
            node={selected}
            parent={selected.parentId ? (nodesById.get(selected.parentId) ?? null) : null}
            children={graph.nodes.filter((node) => node.parentId === selected.id)}
            now={now}
            onClose={closeDrawer}
            onSelect={selectAndFocus}
            onOpenPlan={openPlan}
            onDismiss={
              replay.open
                ? undefined
                : (node) => {
                    dismiss(node)
                    closeDrawer()
                  }
            }
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
    </HudContext.Provider>
  )
}
