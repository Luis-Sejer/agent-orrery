import { useEffect, useMemo, useRef } from 'react'
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, useReactFlow } from '@xyflow/react'

import { buildFlow, SESSION_SIZE, type FlowNode, type FlowOptions } from '../layout'
import { statusOf } from '../status'
import type { GraphSnapshot } from '../types'
import { edgeTypes, nodeTypes } from './FlowNodes'

const FOCUS_ZOOM = 0.95
const FOCUS_DURATION_MS = 600

interface GraphCanvasProps extends FlowOptions {
  graph: GraphSnapshot
  theme: 'light' | 'dark'
  focusRequest: { id: string; at: number } | null
  onSelect: (id: string | null) => void
}

// Colours live in the stylesheet, so the minimap follows the theme.
function minimapClass(node: FlowNode, now: number): string {
  if (node.type === 'room') return 'mini-room'
  if (node.type === 'fold') return 'mini-finished'
  return `mini-${statusOf(node.data.node, now)}`
}

export function GraphCanvas({ graph, theme, focusRequest, onSelect, ...options }: GraphCanvasProps) {
  const { fitView, setCenter } = useReactFlow()
  const { nodes, edges } = useMemo(() => buildFlow(graph, options), [graph, options])
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
    setCenter(target.position.x + SESSION_SIZE.width / 2, target.position.y + SESSION_SIZE.height / 2, {
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
      onNodeClick={(_, node) => node.type !== 'room' && node.type !== 'fold' && onSelect(node.id)}
      onPaneClick={() => onSelect(null)}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      minZoom={0.15}
      maxZoom={1.6}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
      <MiniMap pannable zoomable nodeClassName={(node) => minimapClass(node as FlowNode, options.now)} />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}
