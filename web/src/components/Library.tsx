import { useEffect, useMemo, useRef, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { ago } from '../status'
import { getJson } from '../useGraph'
import type { AgentNode, MemoryProject, PlanSummary } from '../types'

interface Item {
  key: string
  url: string
  title: string
  detail: string | null
}

interface LibraryProps {
  kind: 'plans' | 'memory'
  nodes: AgentNode[]
  now: number
  // A one-off request to open a plan (its name) or a memory note (project/name).
  openRequest: { key: string; at: number } | null
  onSelectNode: (id: string) => void
}

// Tables, task lists and strikethrough, as GitHub renders them; plans use tables a lot.
const REMARK_PLUGINS = [remarkGfm]

const SIBLING_NOTE = /^[\w.-]+\.md$/

// Plans and notes can quote anything, so web links open elsewhere and images are never fetched.
// A link to a sibling .md file (the memory index links every note) opens that note here instead.
function markdownComponents(openSibling: (name: string) => void): Components {
  return {
    a: ({ href, children }) =>
      href && SIBLING_NOTE.test(href) ? (
        <a
          href={href}
          onClick={(event) => {
            // Never follow it: the server has no such page, even when the note is filtered out of the list.
            event.preventDefault()
            openSibling(href)
          }}
        >
          {children}
        </a>
      ) : (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      ),
  }
}

function useDocument(url: string | null): string | null {
  const [content, setContent] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setContent(null)
    if (url) getJson<{ content: string }>(url).then((result) => !cancelled && setContent(result?.content ?? ''))
    return () => {
      cancelled = true
    }
  }, [url])
  return content
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/

interface Note {
  fields: Record<string, string>
  body: string
}

// Memory notes start with YAML frontmatter; show it as a header, not as Markdown.
function splitFrontmatter(content: string): Note {
  const match = content.match(FRONTMATTER)
  if (!match) return { fields: {}, body: content }
  const fields: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const field = line.match(/^(\w+):\s*(.*)$/)
    if (field) fields[field[1]] = field[2].replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"')
  }
  return { fields, body: content.slice(match[0].length) }
}

const planUrl = (name: string) => `/api/plan?name=${encodeURIComponent(name)}`
const noteUrl = (project: string, name: string) =>
  `/api/memory/note?project=${encodeURIComponent(project)}&name=${encodeURIComponent(name)}`

function planItems(plans: PlanSummary[], now: number): Item[] {
  return plans.map((plan) => ({ key: plan.name, url: planUrl(plan.name), title: plan.title, detail: `Changed ${ago(plan.modifiedAt, now)} ago` }))
}

function noteItems(project: MemoryProject | undefined): Item[] {
  return (project?.notes ?? []).map((note) => ({
    key: `${project!.project}/${note.name}`,
    url: noteUrl(project!.project, note.name),
    title: note.title,
    detail: note.description,
  }))
}

export function Library({ kind, nodes, now, openRequest, onSelectNode }: LibraryProps) {
  const [plans, setPlans] = useState<PlanSummary[]>([])
  const [memory, setMemory] = useState<MemoryProject[]>([])
  const [project, setProject] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Item | null>(null)
  const content = useDocument(selected?.url ?? null)

  useEffect(() => {
    if (kind === 'plans') getJson<PlanSummary[]>('/api/plans').then((result) => setPlans(result ?? []))
    else getJson<MemoryProject[]>('/api/memory').then((result) => setMemory(result ?? []))
  }, [kind])

  const currentProject = memory.find((entry) => entry.project === project) ?? memory[0]
  const items = useMemo(() => {
    const all = kind === 'plans' ? planItems(plans, now) : noteItems(currentProject)
    const needle = query.trim().toLowerCase()
    return needle ? all.filter((item) => `${item.title} ${item.detail ?? ''}`.toLowerCase().includes(needle)) : all
  }, [kind, plans, currentProject, query, now])

  const [pendingKey, setPendingKey] = useState<string | null>(null)

  // A note lives in a project, so opening one switches to its project first.
  useEffect(() => {
    if (!openRequest) return
    setPendingKey(openRequest.key)
    setQuery('')
    if (kind === 'memory') setProject(openRequest.key.split('/')[0])
  }, [kind, openRequest])

  // Open the requested item once the list has it; otherwise start on the first item.
  useEffect(() => {
    const wanted = pendingKey ? items.find((item) => item.key === pendingKey) : null
    if (wanted) {
      setSelected(wanted)
      setPendingKey(null)
    } else if (!selected && !pendingKey && items.length > 0) setSelected(items[0])
  }, [pendingKey, items, selected])

  // Read through a ref so the Markdown components stay the same and the reader isn't
  // re-rendered (losing any text selection) every time the clock ticks.
  const itemsRef = useRef(items)
  itemsRef.current = items
  const components = useMemo(
    () =>
      markdownComponents((name) => {
        const sibling = itemsRef.current.find((item) => item.key === name || item.key.endsWith(`/${name}`))
        if (sibling) setSelected(sibling)
      }),
    [],
  )

  const note = useMemo(() => (content === null ? null : splitFrontmatter(content)), [content])

  const writers = selected && kind === 'plans' ? nodes.filter((node) => node.plans.includes(selected.key)) : []

  return (
    <div className="library">
      <div className="library-list">
        <div className="library-controls">
          {kind === 'memory' && memory.length > 0 && (
            <label>
              <span className="visually-hidden">Project</span>
              <select
                value={currentProject?.project}
                onChange={(event) => {
                  setProject(event.target.value)
                  setSelected(null)
                }}
              >
                {memory.map((entry) => (
                  <option key={entry.project} value={entry.project}>
                    {entry.label} ({entry.notes.length})
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span className="visually-hidden">Filter</span>
            <input
              type="search"
              placeholder={kind === 'plans' ? 'Filter plans' : 'Filter notes'}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        <nav aria-label={kind === 'plans' ? 'Plans' : 'Memory notes'}>
          {items.length === 0 && (
            <p className="empty-note">
              {query ? 'Nothing matches that filter.' : kind === 'plans' ? "Claude hasn't saved any plans yet." : "Claude hasn't saved any memory yet."}
            </p>
          )}
          <ol>
            {items.map((item) => (
              <li key={item.key}>
                <button type="button" className={selected?.key === item.key ? 'selected' : ''} aria-current={selected?.key === item.key} onClick={() => setSelected(item)}>
                  <strong>{item.title}</strong>
                  {item.detail && <span>{item.detail}</span>}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      </div>

      {/* With nothing saved there is nothing to read, so no empty reader either. */}
      {(selected || items.length > 0) && (
        <article className="reader">
          {!selected && <p className="empty-note">Choose {kind === 'plans' ? 'a plan' : 'a note'} to read it.</p>}
          {selected && writers.length > 0 && (
            <p className="written-by">
              Written by{' '}
              {writers.map((writer) => (
                <button key={writer.id} type="button" className="link" onClick={() => onSelectNode(writer.id)}>
                  {writer.label}
                </button>
              ))}
            </p>
          )}
          {selected && content === null && <p className="empty-note">Loading…</p>}
          {note && (
            <>
              {(note.fields.description || note.fields.type) && (
                <header className="note-header">
                  <h2 className="serif">{selected?.title}</h2>
                  {note.fields.description && <p>{note.fields.description}</p>}
                  {note.fields.type && <span className="chip">{note.fields.type}</span>}
                </header>
              )}
              <div className="markdown">
                <Markdown skipHtml disallowedElements={['img']} remarkPlugins={REMARK_PLUGINS} components={components}>
                  {note.body}
                </Markdown>
              </div>
            </>
          )}
        </article>
      )}
    </div>
  )
}
