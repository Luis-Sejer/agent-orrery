// Every artifact your agents published, from all their transcripts rather than only the live window,
// so the Artifacts view can find last week's too. Each transcript is read once, then only what has
// been added to it since. Only titles, addresses, times and where they were made are kept.

import { open, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { artifactCall, artifactUrlIn } from './graph.mjs'

const READ_CHUNK_BYTES = 4 * 1024 * 1024
const MAX_RESULTS = 20
const MIN_QUERY = 2
// Cheap checks before a line is parsed: most lines are none of these.
const MIGHT_MATTER = ['"Artifact"', 'claude.ai/', '"ai-title"']

async function listDir(path) {
  return readdir(path).catch(() => [])
}

// Everything worth reading: sessions, and their subagents beside them.
async function transcripts(projectsDir) {
  const found = []
  for (const project of await listDir(projectsDir)) {
    for (const name of await listDir(join(projectsDir, project))) {
      if (!name.endsWith('.jsonl')) continue
      const sessionId = name.slice(0, -'.jsonl'.length)
      found.push({ path: join(projectsDir, project, name), sessionId, agentId: null })
      const subagents = join(projectsDir, project, sessionId, 'subagents')
      for (const agent of await listDir(subagents)) {
        if (agent.startsWith('agent-') && agent.endsWith('.jsonl')) found.push({ path: join(subagents, agent), sessionId, agentId: agent.slice('agent-'.length, -'.jsonl'.length) })
      }
    }
  }
  return found
}

export function createArtifactIndex({ projectsDir, resolveRepo = () => null }) {
  // Per transcript: how far it has been read, its unfinished last line, publishes waiting for their
  // reply, and what it found.
  const files = new Map()
  const sessionTitles = new Map()

  function apply(file, record) {
    if (record.type === 'ai-title' && !file.agentId) sessionTitles.set(file.sessionId, String(record.aiTitle).slice(0, 200))
    if (record.cwd && !file.repo) file.repo = resolveRepo(record.cwd) ?? basename(record.cwd)
    const content = Array.isArray(record.message?.content) ? record.message.content : []
    const at = Date.parse(record.timestamp ?? '') || 0
    for (const block of content) {
      if (block?.type === 'tool_use' && block.name === 'Artifact') {
        const call = artifactCall(block.input)
        if (call?.kind === 'publish') file.calls.set(block.id, { ...call, at })
        if (call?.kind === 'delete' && call.url) file.deleted.set(call.url, at)
      }
      if (block?.type === 'tool_result' && file.calls.has(block.tool_use_id)) {
        const call = file.calls.get(block.tool_use_id)
        file.calls.delete(block.tool_use_id)
        const url = block.is_error ? null : (artifactUrlIn(block.content) ?? call.url)
        // Every publish is kept, so the oldest can name the page and the newest date it.
        if (url) file.published.set(`${url} ${call.at}`, { title: call.title, titled: call.titled, url, at: call.at })
      }
    }
  }

  async function readNew(file) {
    const info = await stat(file.path).catch(() => null)
    if (!info || info.size === file.offset) return
    if (info.size < file.offset) Object.assign(file, { offset: 0, rest: Buffer.alloc(0), calls: new Map(), published: new Map(), deleted: new Map() })
    const handle = await open(file.path, 'r')
    try {
      while (file.offset < info.size) {
        const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, info.size - file.offset))
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, file.offset)
        if (bytesRead === 0) break
        file.offset += bytesRead
        const data = Buffer.concat([file.rest, chunk.subarray(0, bytesRead)])
        const end = data.lastIndexOf(0x0a) + 1
        file.rest = Buffer.from(data.subarray(end))
        for (const line of data.subarray(0, end).toString('utf8').split('\n')) {
          if (!MIGHT_MATTER.some((marker) => line.includes(marker)) && !(file.calls.size > 0 && line.includes('tool_result'))) continue
          try {
            apply(file, JSON.parse(line))
          } catch {
            // A malformed line is skipped, as in the live graph.
          }
        }
      }
    } finally {
      await handle.close()
    }
  }

  async function list() {
    for (const found of await transcripts(projectsDir)) {
      if (!files.has(found.path)) files.set(found.path, { ...found, offset: 0, rest: Buffer.alloc(0), repo: null, calls: new Map(), published: new Map(), deleted: new Map() })
      // A fork's copy of the parent's message may hold a publish call, but its reply is only in the
      // parent's transcript, so it is never counted twice.
      await readNew(files.get(found.path)).catch(() => {})
    }
    const deleted = new Map()
    for (const file of files.values()) for (const [url, at] of file.deleted) deleted.set(url, Math.max(at, deleted.get(url) ?? 0))
    // A page keeps its first title unless a later publish gives it a new one, and its latest time;
    // one deleted since is gone.
    const publishes = [...files.values()].flatMap((file) => [...file.published.values()].map((artifact) => ({ ...artifact, file })))
    const latest = new Map()
    for (const { file, titled, ...artifact } of publishes.sort((a, b) => a.at - b.at)) {
      const earlier = latest.get(artifact.url)
      const title = earlier && !titled ? earlier.title : artifact.title
      latest.set(artifact.url, { title, url: artifact.url, at: artifact.at, sessionId: file.sessionId, agentId: file.agentId, repo: file.repo })
    }
    for (const [url, at] of deleted) if ((latest.get(url)?.at ?? Infinity) < at) latest.delete(url)
    return [...latest.values()].map((artifact) => ({ ...artifact, session: sessionTitles.get(artifact.sessionId) ?? null })).sort((a, b) => b.at - a.at)
  }

  async function search(query) {
    const needle = query.trim().toLowerCase()
    if (needle.length < MIN_QUERY) return []
    return (await list()).filter((artifact) => `${artifact.title}\n${artifact.session ?? ''}\n${artifact.repo ?? ''}`.toLowerCase().includes(needle)).slice(0, MAX_RESULTS)
  }

  return { list, search }
}
