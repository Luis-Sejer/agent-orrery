import { useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, useReactFlow, useStore, useStoreApi, type AriaLabelConfig, type Edge } from '@xyflow/react'

import { buildFlow, buildTree, type FlowOptions } from '../layout'
import { prefersStill } from '../motion'
import { buildOrrery, galaxyView, type Arrangement, type BackdropNode, type Polar } from '../radial'
import { useOrbit, type CanvasNode } from '../useOrbit'
import { statusOf } from '../status'
import type { GraphSnapshot } from '../types'
import { edgeTypes, nodeTypes } from './FlowNodes'

const FOCUS_ZOOM = 0.95
const FIT_PADDING = 0.12
const MIN_ZOOM = 0.15
const MAX_ZOOM = 1.6
const FOCUS_DURATION_MS = 600
// About as long as agents take to glide to their new rings.
const REARRANGE_MS = 700
// Zoomed out further than this, a galaxy shows suns, repository names and orbs, and hides agents' names.
const FAR_ZOOM = 0.55
// A clicked agent closer than this to the canvas's edge (once the drawer has taken its room) is panned into view.
const REVEAL_MARGIN = 24
const REVEAL_AFTER_MS = 80
// Agents open their details; nodes can't be moved or deleted, so React Flow's own hint would mislead.
// React Flow reads the "keyboardDisabled" text while keyboard access is on.
const OPEN_HINT = 'Press Enter to open details.'
const ARIA_LABELS: Partial<AriaLabelConfig> = { 'node.a11yDescription.default': OPEN_HINT, 'node.a11yDescription.keyboardDisabled': OPEN_HINT }
const OPENS_DETAILS = new Set(['session', 'agent', 'orbit'])
const duration = (ms: number) => (prefersStill() ? 0 : ms)

interface GraphCanvasProps extends FlowOptions {
  // Rooms in a grid or a tree of who started whom (Agents), or rings around you (Orrery).
  layout: 'grid' | 'tree' | 'orrery'
  // The orrery's rings: by status, or one per repository.
  arrangement: Arrangement
  graph: GraphSnapshot
  theme: 'light' | 'dark'
  focusRequest: { id: string; at: number } | null
  onSelect: (id: string | null) => void
}

// Colours live in the stylesheet, so the minimap follows the theme.
function minimapClass(node: CanvasNode, now: number): string {
  if (node.type === 'room') return 'mini-room'
  if (node.type === 'backdrop') return 'mini-backdrop'
  if (node.type === 'fold' || node.type === 'pile') return 'mini-finished'
  return `mini-${statusOf(node.data.node, now)}`
}

export function GraphCanvas({ layout, arrangement, graph, theme, focusRequest, onSelect, now, selectedId, expandedRooms, filter, onExpand, onCollapse }: GraphCanvasProps) {
  // One options object per change, not per render: the layout rebuilds whenever it changes, and the
  // orbit re-renders 30 times a second.
  const options = useMemo<FlowOptions>(
    () => ({ now, selectedId, expandedRooms, filter, onExpand, onCollapse }),
    [now, selectedId, expandedRooms, filter, onExpand, onCollapse],
  )
  const { fitView, fitBounds, setCenter } = useReactFlow()
  const { nodes: laidOut, edges, polar } = useMemo<{ nodes: CanvasNode[]; edges: Edge[]; polar: Map<string, Polar> | null }>(
    () => (layout === 'orrery' ? buildOrrery(graph, options, arrangement) : { ...(layout === 'tree' ? buildTree : buildFlow)(graph, options), polar: null }),
    [layout, graph, options, arrangement],
  )
  // The orrery's rings steady themselves while you point at an agent or a pile, have one selected,
  // or move through them with the keyboard.
  const [pointing, setPointing] = useState(false)
  const [focused, setFocused] = useState(false)
  const nodes = useOrbit(laidOut, polar, pointing || focused || options.selectedId !== null)
  // Fitted to what's there before the first data arrives, and once more when it does.
  const fitted = useRef<'nothing' | 'empty' | 'data'>('nothing')
  const far = useStore((state) => state.transform[2] < FAR_ZOOM)
  const galaxy = layout === 'orrery' && arrangement === 'galaxy'
  // The zoom, as --zoom on the canvas, so a galaxy's names and suns keep a readable size however far
  // out you are. Set straight on the element, as it changes every frame of a zoom.
  const store = useStoreApi()
  const canvas = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const show = (zoom: number) => canvas.current?.style.setProperty('--zoom', String(zoom))
    show(store.getState().transform[2])
    return store.subscribe((state) => show(state.transform[2]))
  }, [store])

  // The orrery is fitted to its backdrop, which spans all of it; a galaxy is centred on you as well.
  function fitOrrery(ms: number) {
    const backdrop = laidOut.find((node): node is BackdropNode => node.type === 'backdrop')
    if (!backdrop) return fitView({ padding: FIT_PADDING, duration: duration(ms) })
    if (backdrop.data.systems.length === 0) {
      return fitBounds({ ...backdrop.position, width: backdrop.width!, height: backdrop.height! }, { padding: FIT_PADDING, duration: duration(ms) })
    }
    const { width, height } = store.getState()
    const { x, y, zoom } = galaxyView(backdrop.data.box, width, height, FIT_PADDING, MAX_ZOOM)
    return setCenter(x, y, { zoom: Math.max(MIN_ZOOM, zoom), duration: duration(ms) })
  }

  // Fit when the first data arrives (and to the empty orrery until then); after that the viewport is the user's.
  const loaded = graph.nodes.length > 0
  useEffect(() => {
    if (nodes.length === 0 || fitted.current === 'data' || fitted.current === (loaded ? 'data' : 'empty')) return
    fitted.current = loaded ? 'data' : 'empty'
    requestAnimationFrame(() => fitOrrery(0))
  }, [nodes.length, loaded])

  // A new arrangement keeps the canvas: agents glide to their new rings while the view eases to the
  // orrery's new size. The first arrangement was fitted above.
  const arrangedAs = useRef(arrangement)
  useEffect(() => {
    if (arrangedAs.current === arrangement) return
    arrangedAs.current = arrangement
    fitOrrery(REARRANGE_MS)
  }, [arrangement, laidOut])

  useEffect(() => {
    if (!focusRequest) return
    const target = nodes.find((node) => node.id === focusRequest.id)
    if (!target) return
    setCenter(target.position.x + target.width! / 2, target.position.y + target.height! / 2, {
      zoom: FOCUS_ZOOM,
      duration: duration(FOCUS_DURATION_MS),
    })
    // Only a new request should move the view, not every data update, so nodes is left out.
  }, [focusRequest])

  const nodesRef = useRef(nodes)
  nodesRef.current = nodes

  // Opening the drawer narrows the canvas; a clicked agent it would cover moves into view, keeping the zoom.
  function reveal(id: string) {
    setTimeout(
      () => {
        const element = canvas.current?.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`)
        const target = nodesRef.current.find((node) => node.id === id)
        if (!element || !target || !canvas.current) return
        const box = element.getBoundingClientRect()
        const view = canvas.current.getBoundingClientRect()
        const inside = box.left >= view.left + REVEAL_MARGIN && box.right <= view.right - REVEAL_MARGIN && box.top >= view.top && box.bottom <= view.bottom
        if (inside) return
        setCenter(target.position.x + target.width! / 2, target.position.y + target.height! / 2, { zoom: store.getState().transform[2], duration: duration(FOCUS_DURATION_MS) })
      },
      // Once the drawer has taken its column and the canvas has been resized.
      REVEAL_AFTER_MS,
    )
  }

  function open(id: string) {
    onSelect(id)
    reveal(id)
  }

  // Enter or Space on a focused agent opens it, as a click does.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const element = event.target as HTMLElement
    if (!element.classList.contains('react-flow__node')) return
    const id = element.dataset.id
    if (!id || !OPENS_DETAILS.has(nodes.find((node) => node.id === id)?.type ?? '')) return
    event.preventDefault()
    open(id)
  }

  // Only keyboard focus steadies the rings; a click selects, which steadies them anyway.
  const onFocus = (event: FocusEvent<HTMLDivElement>) => setFocused((event.target as HTMLElement).matches(':focus-visible'))
  const onBlur = (event: FocusEvent<HTMLDivElement>) => !event.currentTarget.contains(event.relatedTarget) && setFocused(false)

  return (
    <ReactFlow
      ref={canvas}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      colorMode={theme}
      className={galaxy ? `galaxy${far ? ' far' : ''}` : undefined}
      onNodeClick={(_, node) => OPENS_DETAILS.has(node.type ?? '') && open(node.id)}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      ariaLabelConfig={ARIA_LABELS}
      edgesFocusable={false}
      onPaneClick={() => onSelect(null)}
      onNodeMouseEnter={(_, node) => setPointing(node.type !== 'backdrop' && node.type !== 'room')}
      onNodeMouseLeave={() => setPointing(false)}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      minZoom={MIN_ZOOM}
      maxZoom={MAX_ZOOM}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
      <MiniMap pannable zoomable nodeClassName={(node) => minimapClass(node as CanvasNode, options.now)} />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}
