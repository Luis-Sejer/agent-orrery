import { useEffect, useState } from 'react'

import { isArtifactUrl } from '../artifacts'
import { getJson } from '../useGraph'
import type { AgentNode, ArtifactEntry } from '../types'
import { startOfDay } from '../waits'

const REFRESH_MS = 30_000
const DAY_MS = 24 * 3_600_000

interface ArtifactsViewProps {
  nodes: AgentNode[]
  now: number
  onSelectNode: (id: string) => void
}

function useArtifacts(): ArtifactEntry[] | null {
  const [artifacts, setArtifacts] = useState<ArtifactEntry[] | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = () =>
      getJson<ArtifactEntry[]>('/api/artifacts').then((result) => {
        if (!cancelled && result) setArtifacts(result.filter(({ url }) => isArtifactUrl(url)))
      })
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])
  return artifacts
}

// "Today", "Yesterday", or the date.
function dayName(at: number, now: number): string {
  const today = startOfDay(now)
  if (at >= today) return 'Today'
  if (at >= today - DAY_MS) return 'Yesterday'
  return new Date(at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
}

const clock = (at: number) => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

// Everything your agents published on claude.ai, newest first, from every transcript Claude Code has
// kept. Each opens in a new tab; the session that made it opens here, while it's in view.
export function ArtifactsView({ nodes, now, onSelectNode }: ArtifactsViewProps) {
  const artifacts = useArtifacts()
  const [filter, setFilter] = useState('')
  const needle = filter.trim().toLowerCase()
  const shown = (artifacts ?? []).filter((artifact) => !needle || [artifact.title, artifact.session, artifact.repo].join(' ').toLowerCase().includes(needle))
  const inView = new Set(nodes.map((node) => node.id))
  const days = shown.reduce((byDay, artifact) => byDay.set(dayName(artifact.at, now), [...(byDay.get(dayName(artifact.at, now)) ?? []), artifact]), new Map<string, ArtifactEntry[]>())

  return (
    <section className="day artifacts" aria-labelledby="artifacts-heading">
      <header className="day-header">
        <h1 id="artifacts-heading" className="serif">
          Artifacts
        </h1>
        <p className="lede">
          {artifacts === null
            ? 'Looking through your sessions…'
            : artifacts.length === 0
              ? 'Nothing published yet. When an agent publishes an artifact, it shows up here.'
              : `${artifacts.length} ${artifacts.length === 1 ? 'artifact' : 'artifacts'} your agents published. Each opens on claude.ai.`}
        </p>
        {(artifacts?.length ?? 0) > 0 && (
          <input className="artifact-filter" type="search" placeholder="Filter by title, session or repository" aria-label="Filter artifacts" value={filter} onChange={(event) => setFilter(event.target.value)} />
        )}
      </header>

      {needle && shown.length === 0 && <p className="empty-note">No artifact matches “{filter.trim()}”.</p>}
      {[...days].map(([day, members]) => (
        <section key={day} className="artifact-day" aria-label={day}>
          <h2 className="serif">{day}</h2>
          <ul className="artifact-list">
            {members.map((artifact) => {
              const agentId = artifact.agentId && inView.has(artifact.agentId) ? artifact.agentId : inView.has(artifact.sessionId) ? artifact.sessionId : null
              return (
                <li key={artifact.url}>
                  <a className="artifact-title" href={artifact.url} target="_blank" rel="noopener noreferrer">
                    {artifact.title}
                  </a>
                  <span className="artifact-meta">
                    {[artifact.session, artifact.repo].filter(Boolean).join(', ')}
                    <time dateTime={new Date(artifact.at).toISOString()}>{clock(artifact.at)}</time>
                  </span>
                  {agentId && (
                    <button type="button" className="link" onClick={() => onSelectNode(agentId)}>
                      Show its {agentId === artifact.sessionId ? 'session' : 'agent'}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </section>
  )
}
