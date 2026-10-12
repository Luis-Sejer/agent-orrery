// Turns Claude Code transcript records into a graph of who spawned and messaged whom.
// Only metadata is kept: titles, tool names, repo names, file basenames and timestamps.
// Message text, tool inputs, commands and tool outputs are never stored.

import { basename } from 'node:path'

import { pathsInToolInput } from './repos.mjs'

const QUESTION_TOOL = 'AskUserQuestion'
const MESSAGE_TOOL = 'SendMessage'
const SPAWN_TOOLS = new Set(['Agent', 'Task'])
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])
const TIMELINE_LIMIT = 80

// Maps a tool to the thinking-orb state that best describes it.
const ACTIVITY_BY_TOOL = {
  Bash: 'working',
  Read: 'searching',
  Grep: 'searching',
  Glob: 'searching',
  LS: 'searching',
  WebSearch: 'searching',
  WebFetch: 'searching',
  ToolSearch: 'searching',
  Edit: 'composing',
  MultiEdit: 'composing',
  Write: 'composing',
  NotebookEdit: 'composing',
  Agent: 'connecting',
  Task: 'connecting',
  SendMessage: 'connecting',
  AskUserQuestion: 'listening',
}

// Agents often read and edit through the shell, so a command is classified by what it does.
// Only the resulting state is kept; the command itself is never stored.
const SHELL_READERS = /^(cat|head|tail|less|grep|rg|ag|find|fd|ls|tree|wc|stat|file|du|jq|awk|which|sed -n|git (log|show|diff|status|blame|grep|branch|ls-files)|gh (pr|issue|run|api|repo) (view|list|diff|checks))\b/
const SHELL_WRITERS = /(^|[;&|]\s*)(sed -i|perl -pi|tee|cp|mv|mkdir|rm|touch|patch|git (add|commit|mv|rm|apply|checkout -b))\b|(^|[^0-9&>])>>?\s*(?!&|\/dev\/null)[\w~/.$"']/
const SHELL_PREFIX = /^(cd\s+\S+|export\s+\S+|source\s+\S+)\s*(&&|;)\s*/

export function shellActivity(command) {
  if (typeof command !== 'string') return 'working'
  let rest = command.trim()
  while (SHELL_PREFIX.test(rest)) rest = rest.replace(SHELL_PREFIX, '')
  if (SHELL_WRITERS.test(rest)) return 'composing'
  if (SHELL_READERS.test(rest)) return 'searching'
  return 'working'
}

const SHELL_EVENT_TEXT = { composing: 'Changed files in the shell', searching: 'Read files in the shell', working: 'Ran a command' }

const fileName = (input) => basename(String(input?.file_path ?? input?.notebook_path ?? 'a file'))

const DESCRIBE_TOOL = {
  Read: (input) => `Read ${fileName(input)}`,
  Edit: (input) => `Edited ${fileName(input)}`,
  MultiEdit: (input) => `Edited ${fileName(input)}`,
  Write: (input) => `Wrote ${fileName(input)}`,
  NotebookEdit: (input) => `Edited ${fileName(input)}`,
  Bash: (input) => SHELL_EVENT_TEXT[shellActivity(input?.command)],
  Grep: () => 'Searched the code',
  Glob: () => 'Looked for files',
  WebSearch: () => 'Searched the web',
  WebFetch: () => 'Read a web page',
  Agent: (input) => `Started ${input?.description ?? 'a subagent'}`,
  Task: (input) => `Started ${input?.description ?? 'a subagent'}`,
  AskUserQuestion: () => 'Asked you a question',
}

function describeTool(name, input) {
  const describe = DESCRIBE_TOOL[name]
  if (describe) return String(describe(input))
  // MCP tools are named mcp__server__tool; the last part reads best.
  return `Used ${String(name).split('__').pop()}`
}

export function createGraph({ resolveRepo = () => null, plansDir = null } = {}) {
  return { nodes: new Map(), messages: new Map(), toolUseOwner: new Map(), resolveRepo, plansDir }
}

export function ensureNode(graph, id, fields) {
  let node = graph.nodes.get(id)
  if (!node) {
    node = { id, kind: 'peer', label: id, lastAt: 0, lastTool: null, repos: {}, events: [], plans: new Set() }
    graph.nodes.set(id, node)
  }
  return Object.assign(node, fields)
}

function addEvent(node, event) {
  // A turn can end several times in a row (subagent hand-backs); one line says it.
  if (node.events.at(-1)?.text === event.text && event.activity === 'listening') return
  node.events.push(event)
  if (node.events.length > TIMELINE_LIMIT) node.events.splice(0, node.events.length - TIMELINE_LIMIT)
}

function addMessage(graph, from, to, at) {
  // Peers have no transcript of their own, so a message is their only sign of life.
  for (const id of [from, to]) {
    const node = ensureNode(graph, id, {})
    if (node.kind === 'peer') node.lastAt = Math.max(node.lastAt, at)
  }
  const key = `${from}>${to}`
  const edge = graph.messages.get(key) ?? { from, to, count: 0, lastAt: 0 }
  edge.count += 1
  edge.lastAt = Math.max(edge.lastAt, at)
  graph.messages.set(key, edge)
}

function recordToolUse(graph, node, block, record, at) {
  const name = String(block.name)
  node.lastTool = name
  node.activity = name === 'Bash' ? shellActivity(block.input?.command) : (ACTIVITY_BY_TOOL[name] ?? 'working')
  graph.toolUseOwner.set(block.id, node.id)

  let repo = null
  for (const path of pathsInToolInput(block.input, record.cwd)) {
    if (graph.plansDir && WRITE_TOOLS.has(name) && path.startsWith(graph.plansDir)) node.plans.add(basename(path))
    const pathRepo = graph.resolveRepo(path)
    if (!pathRepo) continue
    node.repos[pathRepo] = (node.repos[pathRepo] ?? 0) + 1
    repo ??= pathRepo
  }
  addEvent(node, { at, activity: node.activity, text: describeTool(name, block.input), repo: repo ?? node.home ?? null })

  const recipient = block.input?.to
  if (name === MESSAGE_TOOL && typeof recipient === 'string') addMessage(graph, node.id, recipient, at)
  if (name === QUESTION_TOOL) node.waiting = { reason: 'question', since: at }
  if (SPAWN_TOOLS.has(name)) node.lastSpawnAt = at
}

function isTypedPrompt(record) {
  const content = record.message?.content
  if (typeof content === 'string') return true
  return Array.isArray(content) && content.some((block) => block?.type === 'text')
}

// Records that mean someone did something. Attachments, system notes and the summary that
// compaction writes are bookkeeping: they mustn't make an idle session look busy.
function isActivity(record) {
  if (record.type === 'assistant') return true
  return record.type === 'user' && !record.isMeta && !record.isCompactSummary
}

export function applyRecord(graph, nodeId, record) {
  const node = graph.nodes.get(nodeId)
  const at = Date.parse(record.timestamp ?? '') || 0
  if (isActivity(record) && at > node.lastAt) node.lastAt = at
  if (record.gitBranch) node.branch = record.gitBranch
  if (record.cwd && !node.home) node.home = graph.resolveRepo(record.cwd) ?? basename(record.cwd)

  if (record.type === 'ai-title' && node.kind === 'session') node.label = String(record.aiTitle)

  if (record.type === 'user' && isActivity(record)) {
    node.waiting = null
    const origin = record.origin
    if (origin?.kind === 'peer' && origin.from) {
      const from = String(origin.from)
      if (!graph.nodes.has(from)) ensureNode(graph, from, { label: String(origin.name ?? from) })
      addMessage(graph, from, nodeId, at)
      addEvent(node, { at, activity: 'connecting', text: `Message from ${graph.nodes.get(from).label}`, repo: null })
    } else if (origin?.kind === 'human' || (!origin && isTypedPrompt(record))) {
      if (node.kind === 'session') addEvent(node, { at, activity: 'listening', text: 'You replied', repo: null })
    }
  }

  if (record.type === 'assistant') {
    const turnEnded = record.message?.stop_reason === 'end_turn'
    node.waiting = turnEnded ? { reason: 'reply', since: at } : null
    const content = record.message?.content ?? []
    if (!turnEnded && !content.some((block) => block?.type === 'tool_use')) node.activity = 'solving'
    for (const block of content) {
      if (block?.type === 'tool_use') recordToolUse(graph, node, block, record, at)
    }
    if (turnEnded && node.kind === 'session') addEvent(node, { at, activity: 'listening', text: 'Finished its turn', repo: null })
  }
}

export function applyLines(graph, nodeId, text) {
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      applyRecord(graph, nodeId, JSON.parse(line))
    } catch {
      // A malformed line is skipped; one bad record must not stop the rest of the file.
    }
  }
}

function mainRepo(repos) {
  let best = null
  for (const [repo, count] of Object.entries(repos)) if (!best || count > repos[best]) best = repo
  return best
}

function publicNode(graph, node) {
  const parentId = node.kind === 'subagent' ? (graph.toolUseOwner.get(node.spawnToolUseId) ?? node.sessionId) : null
  const room = node.kind === 'session' ? (node.home ?? mainRepo(node.repos)) : (mainRepo(node.repos) ?? graph.nodes.get(parentId)?.home ?? null)
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    branch: node.branch ?? null,
    home: node.home ?? null,
    room,
    repos: Object.keys(node.repos),
    activity: node.activity ?? null,
    lastTool: node.lastTool,
    lastAt: node.lastAt,
    waiting: node.waiting ?? null,
    agentType: node.agentType ?? null,
    model: node.model ?? null,
    sessionId: node.sessionId ?? null,
    parentId,
    plans: [...node.plans],
  }
}

// A session waiting on you stays visible longer than everything else, so a real wait
// doesn't silently drop off the list.
export function snapshot(graph, since, waitingSince = since) {
  const isVisible = (node) => node.lastAt >= since || (node.kind === 'session' && node.waiting && node.lastAt >= waitingSince)
  const visible = [...graph.nodes.values()].filter(isVisible)
  const ids = new Set(visible.map((node) => node.id))
  const nodes = visible.map((node) => publicNode(graph, node))
  for (const node of nodes) if (!ids.has(node.parentId)) node.parentId = null
  const messages = [...graph.messages.values()].filter((edge) => ids.has(edge.from) && ids.has(edge.to))
  return { nodes, messages }
}

export function timeline(graph, id) {
  return graph.nodes.get(id)?.events ?? null
}
