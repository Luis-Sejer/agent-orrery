import { useEffect, useMemo, useRef } from 'react'
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, useReactFlow } from '@xyflow/react'

import { buildFlow, SESSION_SIZE, type FlowNode, type FlowOptions } from '../layout'
import { statusOf } from '../status'
import type { GraphSnapshot } from '../types'
import { edgeTypes, nodeTypes } from './FlowNodes'

const FOCUS_ZOOM = 0.95
const FOCUS_DURATION_MS = 600
const MINIMAP_COLOURS = { waiting: '#c0504a', running: '#34955f', finished: '#c4cbc9' }

interface GraphCanvasProps extends FlowOptions {
  graph: GraphSnapshot
  focusRequest: { id: string; at: number } | null
  onSelect: (id: string | null) => void
}

function minimapColour(node: FlowNode, now: number): string {
  if (node.type === 'room') return 'rgba(22, 41, 37, 0.06)'
  if (node.type === 'fold') return MINIMAP_COLOURS.finished
  return MINIMAP_COLOURS[statusOf(node.data.node, now)]
}

export function GraphCanvas({ graph, focusRequest, onSelect, ...options }: GraphCanvasProps) {
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
      onNodeClick={(_, node) => node.type !== 'room' && node.type !== 'fold' && onSelect(node.id)}
      onPaneClick={() => onSelect(null)}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      minZoom={0.15}
      maxZoom={1.6}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="rgba(22, 41, 37, 0.14)" />
      <MiniMap pannable zoomable nodeColor={(node) => minimapColour(node as FlowNode, options.now)} maskColor="rgba(248, 249, 250, 0.7)" />
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}
