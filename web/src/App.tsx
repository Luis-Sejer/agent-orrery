import { useCallback, useEffect, useMemo, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'

import { Drawer } from './components/Drawer'
import { GraphCanvas } from './components/GraphCanvas'
import { Inbox } from './components/Inbox'
import { Library } from './components/Library'
import { statusOf } from './status'
import type { Filter, View } from './types'
import { applyDismissals, useDismissed } from './useDismissed'
import { useGraph, useNow } from './useGraph'

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

export function App() {
  const { graph: liveGraph, connection } = useGraph()
  const now = useNow()
  const { dismissals, dismiss, restoreAll } = useDismissed()
  const graph = useMemo(() => applyDismissals(liveGraph, dismissals), [liveGraph, dismissals])
  const dismissedCount = graph.nodes.filter((node) => node.dismissed).length
  const [view, setView] = useState<View>('graph')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusRequest, setFocusRequest] = useState<{ id: string; at: number } | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [expandedRooms, setExpandedRooms] = useState<ReadonlySet<string>>(new Set())
  const [openPlan, setOpenPlan] = useState<string | null>(null)

  const nodesById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph])
  const selected = selectedId ? (nodesById.get(selectedId) ?? null) : null
  const waitingCount = graph.nodes.filter((node) => statusOf(node, now) === 'waiting').length

  useEffect(() => {
    document.title = waitingCount > 0 ? `(${waitingCount}) Agent graph` : 'Agent graph'
  }, [waitingCount])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => event.key === 'Escape' && setSelectedId(null)
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Selecting from a list also moves the canvas to the agent.
  const selectAndFocus = useCallback((id: string) => {
    setView('graph')
    setSelectedId(id)
    setFocusRequest({ id, at: Date.now() })
  }, [])

  const expandRoom = useCallback((room: string) => setExpandedRooms((rooms) => new Set(rooms).add(room)), [])

  const openPlanInLibrary = (name: string) => {
    setOpenPlan(name)
    setView('plans')
  }

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
          {view === 'graph' && (
            <>
              <label className="search">
                <span className="visually-hidden">Search agents</span>
                <input type="search" placeholder="Search agents, repos and branches" value={search} onChange={(event) => setSearch(event.target.value)} />
              </label>
              <div className="tabs" role="group" aria-label="Show">
                {FILTERS.map((option) => (
                  <button key={option.value} type="button" className={filter === option.value ? 'on' : ''} aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>
                    {option.label}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="tabs views" role="group" aria-label="View">
            {VIEWS.map((option) => (
              <button key={option.value} type="button" className={view === option.value ? 'on' : ''} aria-pressed={view === option.value} onClick={() => setView(option.value)}>
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {view === 'graph' && (
          <>
            <ReactFlowProvider>
              <GraphCanvas
                graph={graph}
                now={now}
                selectedId={selectedId}
                expandedRooms={expandedRooms}
                filter={filter}
                search={search}
                onExpand={expandRoom}
                focusRequest={focusRequest}
                onSelect={setSelectedId}
              />
            </ReactFlowProvider>
            {graph.nodes.length === 0 && (
              <p className="canvas-empty">
                No Claude Code activity in the last few hours. Start a session and it appears here.
              </p>
            )}
          </>
        )}
        {view !== 'graph' && <Library key={view} kind={view} nodes={graph.nodes} now={now} openPlan={openPlan} onSelectNode={selectAndFocus} />}
      </main>

      {selected && view === 'graph' && (
        <Drawer
          node={selected}
          parent={selected.parentId ? (nodesById.get(selected.parentId) ?? null) : null}
          now={now}
          onClose={() => setSelectedId(null)}
          onSelect={selectAndFocus}
          onOpenPlan={openPlanInLibrary}
          onDismiss={dismiss}
        />
      )}
    </div>
  )
}
