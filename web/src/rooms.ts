import type { GraphSnapshot } from './types'

// Mirrors repos.mjs: the server tags a room in a worktree with its branch ("shop ⎇ feat/x › apps/web").
const WORKTREE_SEPARATOR = ' ⎇ '
const AREA_SEPARATOR = ' › '

// A worktree's room folded into its repository's, keeping any area.
export function foldWorktree(key: string): string {
  const at = key.indexOf(WORKTREE_SEPARATOR)
  if (at === -1) return key
  const area = key.indexOf(AREA_SEPARATOR, at)
  return key.slice(0, at) + (area === -1 ? '' : key.slice(area))
}

// Worktrees are rooms of their own only when you ask for it; otherwise they join their repository.
export function foldWorktrees(graph: GraphSnapshot): GraphSnapshot {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      room: node.room && foldWorktree(node.room),
      home: node.home && foldWorktree(node.home),
      repos: [...new Set(node.repos.map(foldWorktree))],
    })),
  }
}
