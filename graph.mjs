// Turns Claude Code transcript records into a graph of who spawned and messaged whom.
// Only metadata is kept: titles, tool names, repo names, file basenames and timestamps.
// Message text, tool inputs, commands and tool outputs are never stored.

import { basename } from 'node:path'

import { AREA_SEPARATOR, WORKTREE_SEPARATOR, pathsInToolInput } from './repos.mjs'

const QUESTION_TOOL = 'AskUserQuestion'
// Subagents end by handing their report back through this tool, not with an end_turn.
const HANDBACK_TOOL = 'SubagentHandback'
const MESSAGE_TOOL = 'SendMessage'
const SPAWN_TOOLS = new Set(['Agent', 'Task'])
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])
const TIMELINE_LIMIT = 80
// Replay needs the state changes of the last several hours, which is far fewer than the records.
const HISTORY_LIMIT = 400
const UNKNOWN_MODEL = 'unknown'
const SYNTHETIC_MODEL = '<synthetic>'
const TASK_TOOL_USE_ID = /<tool-use-id>([\w-]{1,100})<\/tool-use-id>/
const TASK_ID = /<task-id>([\w-]{1,100})<\/task-id>/
const TASK_STOP_TOOL = 'TaskStop'
// As long as an agent counts as running after its last record (STALE_MS in web/src/status.ts).
const HISTORY_MERGE_MS = 15 * 60_000
// Some prices depend on the request, not just the model: fast mode, and long prompts on models
// that price them higher. The usage key carries those as tags ("claude-opus-5-5 fast").
const LONG_PROMPT_TOKENS = 100_000

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
  SubagentHandback: () => 'Handed back its report',
  [MESSAGE_TOOL]: () => 'Sent a message',
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
    node = {
      id,
      kind: 'peer',
      label: id,
      lastAt: 0,
      firstAt: 0,
      lastTool: null,
      repos: {},
      events: [],
      plans: new Set(),
      // No prototype, so a model named __proto__ is just another key.
      usage: Object.create(null),
      lastMessageId: null,
      openTools: new Map(),
      // Calls running in the background (run_in_background), until their task notification arrives.
      backgroundTasks: new Map(),
      // A background call's task id (from its result) → its tool use id, for notifications and TaskStop.
      backgroundTaskIds: new Map(),
      history: [],
    }
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

function markFirstSeen(node, at) {
  if (at > 0 && (!node.firstAt || at < node.firstAt)) node.firstAt = at
}

// Appends only when something replay shows has changed; the last entry also remembers
// the latest record under that state, so a busy agent doesn't look quiet in a replay.
function recordHistory(node, at) {
  const entry = [at, node.activity ?? null, node.waiting?.reason ?? null, node.lastTool]
  const last = node.history.at(-1)
  // An unchanged state is merged only across a short gap, so a long silence still reads as idle.
  if (last && at - last[4] < HISTORY_MERGE_MS && entry.every((value, index) => index === 0 || value === last[index])) {
    last[4] = Math.max(last[4], at)
    return
  }
  node.history.push([...entry, at])
  if (node.history.length > HISTORY_LIMIT) node.history.splice(0, node.history.length - HISTORY_LIMIT)
}

// One API message is split over several records that repeat its usage, so each id counts once.
function addUsage(node, message) {
  const usage = message?.usage
  // An API error is written as a <synthetic> message with no usage worth pricing.
  if (!usage || message.model === SYNTHETIC_MODEL) return
  // One message is written as one record per content block, all with the same input and cache
  // counts; its output count grows, and only the last record has the final one.
  if (message.id && message.id === node.lastMessageId) {
    const output = usage.output_tokens ?? 0
    node.usage[node.lastUsageKey].output += Math.max(0, output - node.lastOutput)
    node.lastOutput = Math.max(node.lastOutput, output)
    return
  }
  node.lastMessageId = message.id ?? null
  node.lastOutput = usage.output_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const prompt = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + cacheWrite
  const tags = `${usage.speed === 'fast' ? ' fast' : ''}${prompt > LONG_PROMPT_TOKENS ? ' long' : ''}`
  node.lastUsageKey = `${message.model ?? UNKNOWN_MODEL}${tags}`
  const totals = (node.usage[node.lastUsageKey] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
  totals.input += usage.input_tokens ?? 0
  totals.output += usage.output_tokens ?? 0
  totals.cacheRead += usage.cache_read_input_tokens ?? 0
  totals.cacheWrite1h += write1h
  totals.cacheWrite5m += usage.cache_creation ? (usage.cache_creation.ephemeral_5m_input_tokens ?? 0) : cacheWrite
}

function addMessage(graph, from, to, at) {
  // Peers have no transcript of their own, so a message is their only sign of life.
  for (const id of [from, to]) {
    const node = ensureNode(graph, id, {})
    if (node.kind === 'peer') {
      node.lastAt = Math.max(node.lastAt, at)
      markFirstSeen(node, at)
    }
  }
  const key = `${from}>${to}`
  const edge = graph.messages.get(key) ?? { from, to, count: 0, lastAt: 0, firstAt: at }
  edge.count += 1
  edge.lastAt = Math.max(edge.lastAt, at)
  edge.firstAt = Math.min(edge.firstAt, at)
  graph.messages.set(key, edge)
}

function recordToolUse(graph, node, block, record, at) {
  if (block.input?.run_in_background === true && !SPAWN_TOOLS.has(String(block.name))) node.backgroundTasks.set(block.id, { name: String(block.name), since: at })
  const name = String(block.name)
  if (name === TASK_STOP_TOOL) closeBackgroundTask(node, { taskId: block.input?.task_id })
  node.lastTool = name
  node.activity = name === 'Bash' ? shellActivity(block.input?.command) : (ACTIVITY_BY_TOOL[name] ?? 'working')
  // Only spawns are looked up (to find a subagent's parent), so only they are kept.
  if (SPAWN_TOOLS.has(name)) graph.toolUseOwner.set(block.id, node.id)
  // A spawn waits for its subagent, not for you, so only the other calls can look stuck.
  if (!SPAWN_TOOLS.has(name)) node.openTools.set(block.id, { name, since: at })

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
  // Messages from other agents, hand-backs included, are written as meta records but are real.
  const fromPeer = record.origin?.kind === 'peer'
  return record.type === 'user' && (!record.isMeta || fromPeer) && !record.isCompactSummary
}

// Stopping a session (Esc) is written as a user record; it leaves the session waiting on you.
const INTERRUPTED = '[Request interrupted'
function isInterruption(record) {
  const content = record.message?.content
  const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter((block) => block?.type === 'text').map((block) => block.text) : []
  return texts.some((text) => typeof text === 'string' && text.startsWith(INTERRUPTED))
}

// A result closes its call; a new prompt settles whatever was left open, such as an interrupted call.
function closeTools(node, record) {
  const content = Array.isArray(record.message?.content) ? record.message.content : []
  for (const block of content) {
    if (block?.type !== 'tool_result') continue
    node.openTools.delete(block.tool_use_id)
    // A background call answers at once with its task id; notifications and TaskStop use that id.
    const taskId = record.toolUseResult?.backgroundTaskId
    if (typeof taskId === 'string' && node.backgroundTasks.has(block.tool_use_id)) node.backgroundTaskIds.set(taskId, block.tool_use_id)
  }
  const origin = record.origin
  if (origin?.kind === 'human' || (!origin && isTypedPrompt(record))) {
    node.openTools.clear()
    // Only the current turn's background calls count: earlier ones may have been killed, or never
    // end at all (a dev server), and Claude Code doesn't always say when they finish.
    node.backgroundTasks.clear()
    node.backgroundTaskIds.clear()
  }
}

function closeBackgroundTask(node, { toolUseId, taskId }) {
  if (toolUseId) node.backgroundTasks.delete(toolUseId)
  if (taskId && node.backgroundTaskIds.has(taskId)) node.backgroundTasks.delete(node.backgroundTaskIds.get(taskId))
}

function isToolResultOnly(record) {
  const content = record.message?.content
  return Array.isArray(content) && content.length > 0 && content.every((block) => block?.type === 'tool_result')
}

export function applyRecord(graph, nodeId, record) {
  const node = graph.nodes.get(nodeId)
  const at = Date.parse(record.timestamp ?? '') || 0
  if (isActivity(record)) {
    // After a tool result or a prompt the model owes a reply. Claude Code holds back a message that asks
    // you a question until you answer it, so a long silence here usually means a question is open.
    // A task notification is news for an idle session, not something the model is busy answering.
    node.owesReply = record.type === 'user' && record.origin?.kind !== 'task-notification'
    node.lastAt = Math.max(node.lastAt, at)
    markFirstSeen(node, at)
  }
  if (record.gitBranch) node.branch = record.gitBranch
  if (record.cwd && !node.home) node.home = graph.resolveRepo(record.cwd) ?? basename(record.cwd)

  if (record.type === 'ai-title' && node.kind === 'session') node.label = String(record.aiTitle)

  if (record.type === 'user' && isActivity(record)) {
    // The handback's own tool result doesn't wake a subagent; a new message to it does.
    // A task notification that lands after the turn ended doesn't end the wait either; if the model
    // takes it up, its own records follow within seconds.
    const notification = record.origin?.kind === 'task-notification'
    if (!notification && (!node.handedBack || !isToolResultOnly(record))) {
      node.waiting = null
      node.handedBack = false
    }
    closeTools(node, record)
    const origin = record.origin
    if (origin?.kind === 'task-notification') {
      // Only the id of the finished call is read from the notification, to stop waiting on it.
      const content = record.message?.content
      const text = typeof content === 'string' ? content : ''
      closeBackgroundTask(node, { toolUseId: text.match(TASK_TOOL_USE_ID)?.[1], taskId: text.match(TASK_ID)?.[1] })
    } else if (isInterruption(record)) {
      node.waiting = { reason: 'reply', since: at }
      if (node.kind === 'session') addEvent(node, { at, activity: 'listening', text: 'You stopped it', repo: null })
    } else if (origin?.kind === 'peer' && origin.from && !origin.handback) {
      // A hand-back answers a spawn the graph already shows, so only other messages add a line.
      const from = String(origin.from)
      if (!graph.nodes.has(from)) ensureNode(graph, from, { label: String(origin.name ?? from) })
      addMessage(graph, from, nodeId, at)
      addEvent(node, { at, activity: 'connecting', text: `Message from ${graph.nodes.get(from).label}`, repo: null })
    } else if (origin?.kind === 'human' || (!origin && isTypedPrompt(record))) {
      if (node.kind === 'session') addEvent(node, { at, activity: 'listening', text: 'You replied', repo: null })
    }
  }

  if (record.type === 'assistant') {
    const content = record.message?.content ?? []
    node.handedBack = content.some((block) => block?.type === 'tool_use' && block.name === HANDBACK_TOOL)
    // An API error ends the turn too: the session waits for you to try again.
    const turnEnded = record.message?.stop_reason === 'end_turn' || node.handedBack || record.isApiErrorMessage === true
    node.waiting = turnEnded ? { reason: 'reply', since: at } : null
    addUsage(node, record.message)
    if (turnEnded) node.openTools.clear()
    if (!turnEnded && !content.some((block) => block?.type === 'tool_use')) node.activity = 'solving'
    for (const block of content) {
      if (block?.type === 'tool_use') recordToolUse(graph, node, block, record, at)
    }
    if (turnEnded && node.kind === 'session') addEvent(node, { at, activity: 'listening', text: 'Finished its turn', repo: null })
  }
  if (isActivity(record) && at > 0) recordHistory(node, at)
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

const repoOfRoom = (room) => room.split(AREA_SEPARATOR)[0]

// A session's room is where it started. Started at a monorepo's root, that's the area it worked in most there.
function sessionRoom(node) {
  if (!node.home || node.home.includes(AREA_SEPARATOR)) return node.home ?? mainRepo(node.repos)
  const inHome = Object.entries(node.repos).filter(([key]) => key.startsWith(node.home + AREA_SEPARATOR))
  return mainRepo(Object.fromEntries(inHome)) ?? node.home
}

// A monorepo splits into a room per area only while two or more of its areas are busy; otherwise
// it stays one room, so a repository used one area at a time looks the same as any other.
function collapseAreas(nodes) {
  // Counted across a repository and its worktrees, which the page folds together by default.
  const repositoryOf = (key) => repoOfRoom(key).split(WORKTREE_SEPARATOR)[0]
  const areaOf = (key) => key.split(AREA_SEPARATOR)[1] ?? ''
  const busy = new Map()
  for (const { room } of nodes) if (room) busy.set(repositoryOf(room), (busy.get(repositoryOf(room)) ?? new Set()).add(areaOf(room)))
  const keep = (key) => (key && (busy.get(repositoryOf(key))?.size ?? 0) < 2 ? repoOfRoom(key) : key)
  for (const node of nodes) {
    node.room = keep(node.room)
    node.home = keep(node.home)
    node.repos = [...new Set(node.repos.map(keep))]
  }
}

function oldestOpenTool(node) {
  let oldest = null
  for (const tool of node.openTools.values()) if (!oldest || tool.since < oldest.since) oldest = tool
  return oldest && { name: oldest.name, since: oldest.since }
}

function publicNode(graph, node) {
  const parentId = node.kind === 'subagent' ? (graph.toolUseOwner.get(node.spawnToolUseId) ?? node.sessionId) : null
  const room = node.kind === 'session' ? sessionRoom(node) : (mainRepo(node.repos) ?? graph.nodes.get(parentId)?.home ?? null)
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
    pendingTool: oldestOpenTool(node),
    background: [...node.backgroundTasks.values()],
    owesReply: node.kind === 'session' && node.owesReply === true,
    usage: node.usage,
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
  collapseAreas(nodes)
  const messages = [...graph.messages.values()].filter((edge) => ids.has(edge.from) && ids.has(edge.to))
  return { nodes, messages }
}

// The state a node had at `at`: the latest history entry that is not later than it.
function nodeAt(node, at) {
  const entry = node.history.findLast((candidate) => candidate[0] <= at)
  // Before the oldest kept entry there's nothing to show but that the node existed.
  if (!entry) return { ...node, activity: null, lastTool: null, waiting: null, openTools: new Map(), backgroundTasks: new Map(), lastAt: Math.min(node.firstAt, at) }
  const [since, activity, reason, lastTool, lastAt] = entry
  return { ...node, activity, lastTool, lastAt: Math.min(lastAt, at), waiting: reason && { reason, since }, openTools: new Map(), backgroundTasks: new Map() }
}

// The graph as it was at `at`, through the same visibility rules as the live snapshot.
export function replay(graph, at, windowMs, waitingWindowMs = windowMs) {
  const nodes = new Map()
  for (const node of graph.nodes.values()) if (node.firstAt && node.firstAt <= at) nodes.set(node.id, nodeAt(node, at))
  const messages = new Map()
  for (const [key, edge] of graph.messages) if (edge.firstAt <= at) messages.set(key, { ...edge, lastAt: Math.min(edge.lastAt, at) })
  return snapshot({ ...graph, nodes, messages }, at - windowMs, at - waitingWindowMs)
}

// The sessions waiting on you, oldest wait first: what the menu bar companion lists.
// The same rule as statusOf in web/src/status.ts: a subagent runs until it hands back, for 15 minutes
// after its last record, or two hours while a tool call is still open.
const RUNNING_MS = 15 * 60_000
const RUNNING_WITH_OPEN_TOOL_MS = 2 * 60 * 60_000
const isRunning = (node, now) => !node.waiting && now - node.lastAt < (node.pendingTool ? RUNNING_WITH_OPEN_TOOL_MS : RUNNING_MS)
// How long a session may stay silent after a tool result before it's probably asking you something
// (HELD_REPLY_MS in web/src/status.ts).
const HELD_REPLY_MS = 3 * 60_000
const probablyAsking = (node, now) => node.owesReply && !node.waiting && !node.pendingTool && now - node.lastAt >= HELD_REPLY_MS
// A background call counts for half an hour at most (BACKGROUND_MS in web/src/status.ts).
const BACKGROUND_MS = 30 * 60_000
const runsInBackground = (node, now) => (node.background ?? []).some((task) => now - task.since < BACKGROUND_MS)

// A session whose turn ended while its subagents or background calls still run is waiting on them, not on you.
export function waitingSessions({ nodes }, now = Date.now()) {
  const busy = new Set(nodes.filter((node) => node.kind === 'subagent' && isRunning(node, now)).map((node) => node.sessionId))
  for (const node of nodes) if (node.kind === 'session' && runsInBackground(node, now)) busy.add(node.id)
  const asking = (node) => (probablyAsking(node, now) ? { reason: 'question', since: node.lastAt } : null)
  return nodes
    .filter((node) => node.kind === 'session')
    .map((node) => ({ node, waiting: asking(node) ?? node.waiting }))
    .filter(({ node, waiting }) => waiting && (waiting.reason === 'question' || !busy.has(node.id)))
    .map(({ node, waiting }) => ({ id: node.id, label: node.label, room: node.room, branch: node.branch, reason: waiting.reason, since: waiting.since }))
    .sort((a, b) => a.since - b.since)
}

// Drops nodes whose last activity is older than the cutoff, and the messages that touch them.
// Returns their ids, so their transcripts can stop being read.
export function forget(graph, cutoff) {
  const forgotten = new Set()
  for (const [id, node] of graph.nodes) if (node.lastAt > 0 && node.lastAt < cutoff) forgotten.add(id)
  for (const id of forgotten) graph.nodes.delete(id)
  for (const [key, edge] of graph.messages) if (forgotten.has(edge.from) || forgotten.has(edge.to)) graph.messages.delete(key)
  return forgotten
}

export function timeline(graph, id) {
  return graph.nodes.get(id)?.events ?? null
}
