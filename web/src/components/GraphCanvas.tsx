import { useEffect, useMemo, useRef, useState } from 'react'
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, useReactFlow, type Edge } from '@xyflow/react'

import { buildFlow, type FlowOptions } from '../layout'
import { buildOrrery, type Arrangement, type Polar } from '../radial'
import { useOrbit, type CanvasNode } from '../useOrbit'
import { statusOf } from '../status'
import type { GraphSnapshot } from '../types'
import { edgeTypes, nodeTypes } from './FlowNodes'

const FOCUS_ZOOM = 0.95
const FOCUS_DURATION_MS = 600

interface GraphCanvasProps extends FlowOptions {
  // Rooms in a grid (Agents), or rings around you (Orrery).
  layout: 'grid' | 'orrery'
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
  if (node.type === 'fold') return 'mini-finished'
  return `mini-${statusOf(node.data.node, now)}`
}

export function GraphCanvas({ layout, arrangement, graph, theme, focusRequest, onSelect, ...options }: GraphCanvasProps) {
  const { fitView, setCenter } = useReactFlow()
  const { nodes: laidOut, edges, polar } = useMemo<{ nodes: CanvasNode[]; edges: Edge[]; polar: Map<string, Polar> | null }>(
    () => (layout === 'orrery' ? buildOrrery(graph, options, arrangement) : { ...buildFlow(graph, options), polar: null }),
    [layout, graph, options, arrangement],
  )
  // The orrery's rings steady themselves while you point at an agent or a pile, or have one selected.
  const [pointing, setPointing] = useState(false)
  const nodes = useOrbit(laidOut, polar, pointing || options.selectedId !== null)
  const hasFitted = useRef(false)

  // Fit once, when the first data arrives; after that the viewport is the user's.
  useEffect(() => {
    if (hasFitted.current || nodes.length === 0) return
    hasFitted.current = true
    requestAnimationFrame(() => fitView({ padding: 0.12 }))
  }, [nodes.length, fitView])

  useEffect(() => {
    if (!focusRequest) return
    const target = nodes.find((node) => node.id === focusRequest.id)
    if (!target) return
    setCenter(target.position.x + target.width! / 2, target.position.y + target.height! / 2, {
      zoom: FOCUS_ZOOM,
      duration: FOCUS_DURATION_MS,
    })
    // Only a new request should move the view, not every data update, so nodes is left out.
  }, [focusRequest])

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      colorMode={theme}
      onNodeClick={(_, node) => (node.type === 'session' || node.type === 'agent' || node.type === 'orbit') && onSelect(node.id)}
      onPaneClick={() => onSelect(null)}
      onNodeMouseEnter={(_, node) => setPointing(node.type !== 'backdrop' && node.type !== 'room')}
      onNodeMouseLeave={() => setPointing(false)}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      minZoom={0.15}
      maxZoom={1.6}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
      <MiniMap pannable zoomable nodeClassName={(node) => minimapClass(node as CanvasNode, options.now)} />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}
