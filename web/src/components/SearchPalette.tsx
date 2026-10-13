import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

import { orbStateOf, statusOf } from '../status'
import { getJson } from '../useGraph'
import type { AgentNode } from '../types'
import { Icon } from './Icon'
import { Orb } from './Orb'

const MIN_QUERY = 2
const MAX_AGENTS = 5
const DEBOUNCE_MS = 180
const STATUS_RANK = { waiting: 0, running: 1, finished: 2 }

interface PlanHit {
  name: string
  title: string
  snippet: string
}

interface NoteHit {
  project: string
  label: string
  name: string
  title: string
  snippet: string
}

interface SearchResults {
  plans: PlanHit[]
  notes: NoteHit[]
}

interface Result {
  key: string
  group: 'Agents' | 'Plans' | 'Memory'
  title: string
  detail: string
  node?: AgentNode
  open: () => void
}

interface SearchPaletteProps {
  open: boolean
  nodes: AgentNode[]
  now: number
  onClose: () => void
  onSelectNode: (id: string) => void
  onOpenPlan: (name: string) => void
  onOpenNote: (project: string, name: string) => void
}

// Wraps each match in <mark>, as text, so nothing in a plan or note can become markup.
function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>
  const parts: ReactNode[] = []
  const lower = text.toLowerCase()
  let from = 0
  let at = lower.indexOf(needle)
  while (at !== -1) {
    parts.push(text.slice(from, at), <mark key={at}>{text.slice(at, at + needle.length)}</mark>)
    from = at + needle.length
    at = lower.indexOf(needle, from)
  }
  parts.push(text.slice(from))
  return <>{parts}</>
}

// An agent whose own name matches beats one that only shares a matching branch or repo.
function matchAgents(nodes: AgentNode[], needle: string, now: number): AgentNode[] {
  const nameMatches = (node: AgentNode) => (node.label.toLowerCase().includes(needle) ? 0 : 1)
  return nodes
    .filter((node) => node.kind !== 'peer')
    .filter((node) => [node.label, node.room, node.branch, node.agentType, ...node.repos].join(' ').toLowerCase().includes(needle))
    .sort((a, b) => nameMatches(a) - nameMatches(b) || STATUS_RANK[statusOf(a, now)] - STATUS_RANK[statusOf(b, now)] || b.lastAt - a.lastAt)
    .slice(0, MAX_AGENTS)
}

function useLibrarySearch(needle: string): SearchResults {
  const [results, setResults] = useState<SearchResults>({ plans: [], notes: [] })
  useEffect(() => {
    if (needle.length < MIN_QUERY) {
      setResults({ plans: [], notes: [] })
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      getJson<SearchResults>(`/api/search?q=${encodeURIComponent(needle)}`).then((found) => {
        if (!cancelled && found) setResults(found)
      })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [needle])
  return results
}

export function SearchPalette({ open, nodes, now, onClose, onSelectNode, onOpenPlan, onOpenNote }: SearchPaletteProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const needle = query.trim().toLowerCase()
  const library = useLibrarySearch(needle)

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) {
      setQuery('')
      setActive(0)
      element.showModal()
    }
    if (!open && element.open) element.close()
  }, [open])

  const results = useMemo<Result[]>(() => {
    if (needle.length < MIN_QUERY) return []
    const agents = matchAgents(nodes, needle, now).map((node) => ({
      key: `agent:${node.id}`,
      group: 'Agents' as const,
      title: node.label,
      detail: [node.kind === 'session' ? 'session' : node.agentType, node.room, node.branch].filter(Boolean).join(', '),
      node,
      open: () => onSelectNode(node.id),
    }))
    const plans = library.plans.map((plan) => ({
      key: `plan:${plan.name}`,
      group: 'Plans' as const,
      title: plan.title,
      detail: plan.snippet,
      open: () => onOpenPlan(plan.name),
    }))
    const notes = library.notes.map((note) => ({
      key: `note:${note.project}/${note.name}`,
      group: 'Memory' as const,
      title: note.title,
      detail: `${note.label}: ${note.snippet}`,
      open: () => onOpenNote(note.project, note.name),
    }))
    return [...agents, ...plans, ...notes]
  }, [needle, nodes, now, library, onSelectNode, onOpenPlan, onOpenNote])

  useEffect(() => setActive(0), [needle])

  const groups = [...results.reduce((byGroup, result) => byGroup.set(result.group, [...(byGroup.get(result.group) ?? []), result]), new Map<Result['group'], Result[]>())]
  const searched = needle.length >= MIN_QUERY

  function choose(result: Result | undefined) {
    if (!result) return
    onClose()
    result.open()
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((current) => (results.length === 0 ? 0 : (current + step + results.length) % results.length))
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      choose(results[active])
    }
  }

  return (
    <dialog
      ref={dialog}
      className="palette"
      aria-label="Search agents, plans and memory"
      onClose={onClose}
      onClick={(event) => event.target === dialog.current && onClose()}
    >
      <div className="palette-field">
        <Icon name="search" />
        <input
          type="search"
          role="combobox"
          aria-label="Search agents, plans and memory"
          aria-expanded={results.length > 0}
          aria-autocomplete="list"
          placeholder="Search agents, plans and memory"
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          aria-controls="palette-results"
          aria-activedescendant={results[active] ? `result-${active}` : undefined}
        />
        <kbd>esc</kbd>
      </div>
      {!searched && <p className="palette-hint">Type to search agents by name, repo or branch, and the text of plans and memory notes.</p>}
      {searched && results.length === 0 && <p className="palette-hint">Nothing matches “{query.trim()}”.</p>}
      <p className="visually-hidden" role="status">
        {searched ? (results.length === 0 ? 'No results' : `${results.length} ${results.length === 1 ? 'result' : 'results'}`) : ''}
      </p>
      <div id="palette-results" className="palette-results" role="listbox" aria-label="Results">
        {groups.map(([group, members]) => (
          <div key={group} role="group" aria-label={group}>
            <span className="palette-group" aria-hidden="true">
              {group}
            </span>
            {members.map((result) => {
              const index = results.indexOf(result)
              return (
                <button
                  key={result.key}
                  type="button"
                  id={`result-${index}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === active}
                  className={index === active ? 'active' : ''}
                  onMouseMove={() => setActive(index)}
                  onClick={() => choose(result)}
                >
                  {result.node && <Orb state={orbStateOf(result.node, now)} size={20} />}
                  <span className="palette-text">
                    <strong>
                      <Highlight text={result.title} needle={needle} />
                    </strong>
                    <span>
                      <Highlight text={result.detail} needle={needle} />
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </dialog>
  )
}
