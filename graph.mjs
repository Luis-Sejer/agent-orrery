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
const EDIT_TOOLS = new Set([...WRITE_TOOLS, 'NotebookEdit'])
// Two sessions editing the same file this close together are probably working over each other.
const COLLISION_MS = 10 * 60_000
const EDITS_LIMIT = 200
// Times a session waited on you, kept for the day view and the "waited on you" totals.
const YOU_WAITS_LIMIT = 200
const TIMELINE_LIMIT = 80
// Replay needs the state changes of the last several hours, which is far fewer than the records.
const HISTORY_LIMIT = 400
const UNKNOWN_MODEL = 'unknown'
const SYNTHETIC_MODEL = '<synthetic>'
const TASK_TOOL_USE_ID = /<tool-use-id>([\w-]{1,100})<\/tool-use-id>/
const TASK_ID = /<task-id>([\w-]{1,100})<\/task-id>/
const TASK_STOP_TOOL = 'TaskStop'
// Claude Code's older name for stopping a background shell.
const KILL_SHELL_TOOL = 'KillShell'
// A background shell is a satellite of its agent until it ends; one that never reports ending is
// dropped after this long.
const SHELL_CAP_MS = 12 * 60 * 60_000
const SHELLS_LIMIT = 20
// Where a background command listens: a loopback address with its port, or just a port. Only these
// are taken from a command or its description; the rest of it is never kept.
const LOOPBACK_ADDRESS = /\b((?:[a-z0-9-]{1,63}\.)*localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})\b/i
const PORT_SETTING = /(?:--port[= ]|(?:^|\s)-p ?|\bPORT=)(\d{2,5})(?=\s|$|;|&)/
const MAX_PORT = 65_535
const ARTIFACT_TOOL = 'Artifact'
// A published artifact's address on claude.ai, the one thing taken from the reply to a publish.
const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]{6,80}/
const ARTIFACTS_LIMIT = 50
const MAX_TITLE_LENGTH = 120
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
  Artifact: 'composing',
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
  [ARTIFACT_TOOL]: describeArtifact,
}

// What an Artifact call does to the list of published artifacts: publishes one (a new page, a
// republish or one made from a type) or deletes one. Reads, lists and asset uploads change nothing.
export function artifactCall(input) {
  const action = input?.action ?? 'publish'
  if (action === 'delete' && !input.path && typeof input.url === 'string') return { kind: 'delete', url: input.url.match(ARTIFACT_URL)?.[0] ?? null }
  if (action !== 'publish' || input?.asset === true) return null
  // A republish names its file (often a data file), so only a title given outright renames a page.
  const titled = typeof input?.title === 'string' && input.title.trim() !== ''
  const named = titled ? input.title.trim() : typeof input?.file_path === 'string' ? basename(input.file_path).replace(/\.[a-z]+$/i, '') : 'Artifact'
  return { kind: 'publish', title: named.slice(0, MAX_TITLE_LENGTH), titled, url: typeof input?.url === 'string' ? (input.url.match(ARTIFACT_URL)?.[0] ?? null) : null }
}

// The first artifact address in a tool result: the page that was published (a page made from a type
// names the type's address after its own).
export function artifactUrlIn(content) {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n') : ''
  return text.match(ARTIFACT_URL)?.[0] ?? null
}

function describeArtifact(input) {
  const call = artifactCall(input)
  if (call?.kind === 'publish') return `Published ${call.title}`
  if (call?.kind === 'delete') return 'Deleted an artifact'
  return 'Looked at artifacts'
}

function describeTool(name, input) {
  const describe = DESCRIBE_TOOL[name]
  if (describe) return String(describe(input))
  // MCP tools are named mcp__server__tool; the last part reads best.
  return `Used ${String(name).split('__').pop()}`
}

export function createGraph({ resolveRepo = () => null, plansDir = null } = {}) {
  // live: what Claude Code itself says each running session is doing (see setLive); null until known.
  // aliases: the names sessions use for each other (a session's name, its socket), to its session id.
  return { nodes: new Map(), messages: new Map(), toolUseOwner: new Map(), resolveRepo, plansDir, live: null, seenLive: new Set(), aliases: new Map(), messageIds: new Set() }
}

const SOCKET_PID = /^uds:.*\/(\d{1,10})\.sock$/
const MESSAGE_IDS_LIMIT = 5_000

// A message's other end as a node id: a session's id, whatever name or socket the message used for it.
export function resolveAgent(graph, id) {
  if (graph.nodes.get(id)?.kind === 'session') return id
  const pid = id.match(SOCKET_PID)?.[1]
  return graph.aliases.get(id) ?? (pid && graph.aliases.get(`pid:${pid}`)) ?? id
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
      // Background shells still running, servers included, by tool use id: { since, host, port }.
      // Unlike backgroundTasks they outlast the turn: they end when the shell does.
      shells: new Map(),
      shellTaskIds: new Map(),
      history: [],
      // Files it edited lately, by path: { first, last, repo }, for spotting two agents in one file.
      edits: new Map(),
      // [start, end] spans in which it waited on you and you answered.
      youWaits: [],
      // Artifacts it published, by address, and its publish calls still waiting for their reply.
      artifacts: new Map(),
      artifactCalls: new Map(),
      // Tool calls so far: the page sends a packet along its line for each new one.
      toolCount: 0,
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

// A message carries an id only between sessions; one seen twice (queued, then delivered) counts once.
function isRepeat(graph, messageId) {
  if (typeof messageId !== 'string') return false
  if (graph.messageIds.has(messageId)) return true
  graph.messageIds.add(messageId)
  if (graph.messageIds.size > MESSAGE_IDS_LIMIT) graph.messageIds.delete(graph.messageIds.values().next().value)
  return false
}

// side: who wrote it down. A message between two agents with transcripts is written by both, the sender
// (its SendMessage call) and the receiver, so each side is counted apart and the larger count wins.
function addMessage(graph, from, to, at, side = 'sent') {
  // Peers have no transcript of their own, so a message is their only sign of life.
  for (const id of [from, to]) {
    const node = ensureNode(graph, id, SOCKET_PID.test(id) && !graph.nodes.has(id) ? { label: 'Another session' } : {})
    if (node.kind === 'peer') {
      node.lastAt = Math.max(node.lastAt, at)
      markFirstSeen(node, at)
    }
  }
  const key = `${from}>${to}`
  const edge = graph.messages.get(key) ?? { from, to, count: 0, sent: 0, received: 0, lastAt: 0, firstAt: at }
  edge[side] += 1
  edge.count = Math.max(edge.sent, edge.received)
  edge.lastAt = Math.max(edge.lastAt, at)
  edge.firstAt = Math.min(edge.firstAt, at)
  graph.messages.set(key, edge)
}

function recordToolUse(graph, node, block, record, at) {
  if (block.input?.run_in_background === true && !SPAWN_TOOLS.has(String(block.name))) node.backgroundTasks.set(block.id, { name: String(block.name), since: at })
  if (block.input?.run_in_background === true && String(block.name) === 'Bash') startShell(node, block, at)
  const name = String(block.name)
  node.toolCount += 1
  if (name === TASK_STOP_TOOL || name === KILL_SHELL_TOOL) closeBackgroundTask(node, { taskId: block.input?.task_id ?? block.input?.shell_id })
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
  if (EDIT_TOOLS.has(name)) for (const path of pathsInToolInput(block.input, record.cwd)) recordEdit(node, path, at, graph.resolveRepo(path))
  addEvent(node, { at, activity: node.activity, text: describeTool(name, block.input), repo: repo ?? node.home ?? null })

  const recipient = block.input?.to
  if (name === MESSAGE_TOOL && typeof recipient === 'string') addMessage(graph, node.id, recipient, at)
  if (name === QUESTION_TOOL) node.waiting = { reason: 'question', since: at }
  if (SPAWN_TOOLS.has(name)) node.lastSpawnAt = at
  if (name === ARTIFACT_TOOL) {
    const call = artifactCall(block.input)
    if (call?.kind === 'publish') node.artifactCalls.set(block.id, { ...call, at })
    if (call?.kind === 'delete' && call.url) node.artifacts.delete(call.url)
  }
}

// A publish is known once its reply names the page; a failed one leaves nothing behind.
function settleArtifact(node, block) {
  const call = node.artifactCalls.get(block.tool_use_id)
  if (!call) return
  node.artifactCalls.delete(block.tool_use_id)
  const url = block.is_error ? null : (artifactUrlIn(block.content) ?? call.url)
  if (!url) return
  const earlier = node.artifacts.get(url)
  node.artifacts.delete(url)
  node.artifacts.set(url, { title: earlier && !call.titled ? earlier.title : call.title, url, at: call.at })
  if (node.artifacts.size > ARTIFACTS_LIMIT) node.artifacts.delete(node.artifacts.keys().next().value)
}

function recordEdit(node, path, at, repo) {
  const edit = node.edits.get(path)
  // A file left alone longer than the collision window starts afresh.
  if (edit && at - edit.last < COLLISION_MS) edit.last = Math.max(edit.last, at)
  else node.edits.set(path, { first: at, last: at, repo })
  if (node.edits.size > EDITS_LIMIT) {
    for (const [key, { last }] of node.edits) if (at - last >= COLLISION_MS) node.edits.delete(key)
  }
}

function addYouWait(node, start, end) {
  if (!(start > 0) || end <= start) return
  node.youWaits.push([start, end])
  if (node.youWaits.length > YOU_WAITS_LIMIT) node.youWaits.splice(0, node.youWaits.length - YOU_WAITS_LIMIT)
}

const hasToolResult = (record) => Array.isArray(record.message?.content) && record.message.content.some((block) => block?.type === 'tool_result')
const isHumanPrompt = (record) => record.origin?.kind === 'human' || (!record.origin && isTypedPrompt(record))

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
    settleArtifact(node, block)
    // A background call answers at once with its task id; notifications and TaskStop use that id.
    const taskId = record.toolUseResult?.backgroundTaskId
    if (typeof taskId === 'string' && node.backgroundTasks.has(block.tool_use_id)) node.backgroundTaskIds.set(taskId, block.tool_use_id)
    if (typeof taskId === 'string' && node.shells.has(block.tool_use_id)) node.shellTaskIds.set(taskId, block.tool_use_id)
  }
  if (isHumanPrompt(record)) {
    node.openTools.clear()
    node.artifactCalls.clear()
    // Only the current turn's background calls count: earlier ones may have been killed, or never
    // end at all (a dev server), and Claude Code doesn't always say when they finish.
    node.backgroundTasks.clear()
    node.backgroundTaskIds.clear()
  }
}

// Where a background command will listen, from the command or its description: a loopback host and
// port, or a port alone (then it's localhost). Null when neither says.
export function addressOf(...texts) {
  for (const text of texts) {
    if (typeof text !== 'string') continue
    const found = text.match(LOOPBACK_ADDRESS)
    if (found && Number(found[2]) <= MAX_PORT) return { host: found[1].toLowerCase() === '0.0.0.0' ? 'localhost' : found[1].toLowerCase(), port: Number(found[2]) }
  }
  for (const text of texts) {
    const port = typeof text === 'string' ? Number(text.match(PORT_SETTING)?.[1]) : NaN
    if (port > 0 && port <= MAX_PORT) return { host: 'localhost', port }
  }
  return null
}

function startShell(node, block, at) {
  const address = addressOf(block.input?.command, block.input?.description)
  node.shells.set(block.id, { since: at, host: address?.host ?? null, port: address?.port ?? null })
  if (node.shells.size > SHELLS_LIMIT) node.shells.delete(node.shells.keys().next().value)
}

function closeBackgroundTask(node, { toolUseId, taskId }) {
  if (toolUseId) node.backgroundTasks.delete(toolUseId)
  if (taskId && node.backgroundTaskIds.has(taskId)) node.backgroundTasks.delete(node.backgroundTaskIds.get(taskId))
  if (toolUseId) node.shells.delete(toolUseId)
  if (taskId && node.shellTaskIds.has(taskId)) node.shells.delete(node.shellTaskIds.get(taskId))
}

function isToolResultOnly(record) {
  const content = record.message?.content
  return Array.isArray(content) && content.length > 0 && content.every((block) => block?.type === 'tool_result')
}

// A forked subagent's transcript starts with a copy of the parent's message that spawned it. That
// message is the parent's: its calls, its spawns and its tokens.
const isCopiedSpawn = (node, record) =>
  node.kind === 'subagent' && record.type === 'assistant' && Array.isArray(record.message?.content) && record.message.content.some((block) => block?.type === 'tool_use' && block.id === node.spawnToolUseId)

// A message from another agent: a line from it, and a step in the timeline. Only who sent it is read.
function receiveMessage(graph, node, origin, at) {
  if (isRepeat(graph, origin.msg_id)) return
  const from = String(origin.from)
  if (!graph.nodes.has(from)) ensureNode(graph, from, { label: String(origin.name ?? from) })
  addMessage(graph, from, node.id, at, 'received')
  addEvent(node, { at, activity: 'connecting', text: `Message from ${origin.name ? String(origin.name) : graph.nodes.get(from).label}`, repo: null })
}

// A message from another session that arrives while this one is busy is written only as a queued
// command, absorbed into the turn under way.
const queuedPrompt = (record) => record.type === 'attachment' && record.attachment?.type === 'queued_command' && record.attachment.origin?.kind === 'human'

function finishSubagents(graph, sessionId, at) {
  for (const node of graph.nodes.values()) {
    if (node.kind === 'subagent' && node.sessionId === sessionId && !node.waiting && node.lastAt <= at) node.waiting = { reason: 'reply', since: at }
  }
}

// Some carry no origin, only the command's mode.
const queuedNotice = (record) =>
  record.type === 'attachment' && record.attachment?.type === 'queued_command' && (record.attachment.origin?.kind ?? record.attachment.commandMode) === 'task-notification'

// The ids of the call a task notification is about, and nothing else from its text.
function idsIn(text) {
  const content = typeof text === 'string' ? text : ''
  return { toolUseId: content.match(TASK_TOOL_USE_ID)?.[1], taskId: content.match(TASK_ID)?.[1] }
}

const queuedMessage = (record) => (record.type === 'attachment' && record.attachment?.type === 'queued_command' && record.attachment.origin?.kind === 'peer' ? record.attachment.origin : null)

export function applyRecord(graph, nodeId, record) {
  const node = graph.nodes.get(nodeId)
  if (isCopiedSpawn(node, record)) return
  const queued = queuedMessage(record)
  if (queued?.from) receiveMessage(graph, node, queued, Date.parse(record.timestamp ?? '') || 0)
  // A background command that ends while the session is busy is reported the same way: only its ids are read.
  if (queuedNotice(record)) closeBackgroundTask(node, idsIn(record.attachment.prompt))
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
  // A session that moves its working folder (into a worktree, or another repository) belongs there now.
  if (record.type === 'relocated' && typeof record.relocatedCwd === 'string' && record.relocatedCwd) node.home = graph.resolveRepo(record.relocatedCwd) ?? basename(record.relocatedCwd)
  // A workflow agent's transcript ends with its result: it has finished, as a subagent does at its hand-back.
  if (record.type === 'result' && node.kind === 'subagent') node.waiting = { reason: 'reply', since: Date.parse(record.timestamp ?? '') || node.lastAt }
  // Stopping a session's agents (Esc twice, or killing them) ends the subagents that were still at work.
  if (record.type === 'system' && record.subtype === 'agents_killed') finishSubagents(graph, node.id, Date.parse(record.timestamp ?? '') || 0)
  // A prompt you type while the session is busy is written only as a queued command; it's your reply all the same.
  if (queuedPrompt(record)) {
    const at = Date.parse(record.timestamp ?? '') || 0
    if (node.waiting && node.kind === 'session') addYouWait(node, node.waiting.since, at)
    if (node.kind === 'session') addEvent(node, { at, activity: 'listening', text: 'You replied', repo: null })
  }

  // A name you give a session (/rename) wins over the title Claude Code keeps writing for it; an empty
  // one hands the title back.
  if (record.type === 'custom-title' && node.kind === 'session') {
    const name = String(record.customTitle ?? '').trim().slice(0, MAX_TITLE_LENGTH)
    node.customTitle = name || null
    if (name) node.label = name
  }
  if (record.type === 'ai-title' && node.kind === 'session' && !node.customTitle) node.label = String(record.aiTitle)

  if (record.type === 'user' && isActivity(record)) {
    // The handback's own tool result doesn't wake a subagent; a new message to it does.
    // A task notification that lands after the turn ended doesn't end the wait either; if the model
    // takes it up, its own records follow within seconds.
    const notification = record.origin?.kind === 'task-notification'
    if (!notification && (!node.handedBack || !isToolResultOnly(record))) {
      // You ended the wait: by prompting, or by answering its question (written only once answered).
      const answered = isHumanPrompt(record) || (node.waiting?.reason === 'question' && hasToolResult(record))
      if (node.waiting && answered && node.kind === 'session') addYouWait(node, node.waiting.since, at)
      node.waiting = null
      node.handedBack = false
    }
    closeTools(node, record)
    const origin = record.origin
    if (origin?.kind === 'task-notification') {
      // Only the id of the finished call is read from the notification, to stop waiting on it.
      const content = record.message?.content
      closeBackgroundTask(node, idsIn(typeof content === 'string' ? content : ''))
    } else if (isInterruption(record)) {
      node.waiting = { reason: 'reply', since: at }
      if (node.kind === 'session') addEvent(node, { at, activity: 'listening', text: 'You stopped it', repo: null })
    } else if (origin?.kind === 'peer' && origin.from && !origin.handback) {
      // A hand-back answers a spawn the graph already shows, so only other messages add a line.
      receiveMessage(graph, node, origin, at)
    } else if (isHumanPrompt(record)) {
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

let reportedError = false

// A session with no status file that has been silent this long, with no call open, has ended. Sessions
// we saw running end as soon as their file goes; the grace is for headless runs that may write none.
const CLOSED_GRACE_MS = 2 * 60_000

// Takes what Claude Code says its running sessions are doing (~/.claude/sessions): a list of
// { sessionId, status, waitingFor, since }, or null when it can't be read. A permission prompt or a
// question that has ended is remembered as time spent waiting on you.
const LIVE_STATUSES = new Set(['busy', 'shell', 'idle', 'waiting'])
// What a waiting session needs from you, by Claude Code's waitingFor; anything else is some dialog.
const WAIT_REASONS = { 'input needed': 'question', 'permission prompt': 'permission', 'sandbox request': 'permission' }

export function setLive(graph, sessions, now) {
  const previous = graph.live
  const known = (sessions ?? []).filter((entry) => typeof entry.sessionId === 'string' && LIVE_STATUSES.has(entry.status))
  // Other sessions address one by its name or its socket; remember those, even once it has closed.
  for (const entry of sessions ?? []) for (const alias of entry.aliases ?? []) if (typeof entry.sessionId === 'string') graph.aliases.set(alias, entry.sessionId)
  graph.live =
    sessions &&
    new Map(
      known.map(({ sessionId, status, waitingFor, since }) => [
        sessionId,
        { status, since: Number.isFinite(since) ? since : now, ...(status === 'waiting' && { reason: WAIT_REASONS[waitingFor] ?? 'dialog' }) },
      ]),
    )
  sessions = known
  for (const entry of sessions ?? []) graph.seenLive.add(entry.sessionId)
  for (const [id, before] of previous ?? []) {
    const after = graph.live?.get(id)
    if (before.status !== 'waiting' || (after?.status === 'waiting' && after.since === before.since)) continue
    const node = graph.nodes.get(id)
    if (node) addYouWait(node, before.since, after?.since ?? now)
  }
}

const openShells = (node, now) => [...node.shells.values()].filter((shell) => now - shell.since < SHELL_CAP_MS)

// Shell means a background command runs, but nobody waits on a server: when every shell the session
// and its subagents still have open serves an address, it's ready for you.
function serving(graph, node, entry, now) {
  if (entry.status !== 'shell') return entry
  const shells = [...graph.nodes.values()].filter((other) => other === node || other.sessionId === node.id).flatMap((other) => openShells(other, now))
  return shells.length > 0 && shells.every((shell) => shell.port !== null) ? { ...entry, status: 'idle' } : entry
}

// A session's live state, or { status: 'closed' } once it has ended; a subagent only ever ends with
// its session. Null means unknown, and the transcript has to tell.
function liveOf(graph, node, now) {
  if (!graph.live || now === null || node.kind === 'peer') return null
  const id = node.kind === 'session' ? node.id : node.sessionId
  const entry = graph.live.get(id)
  if (entry) return node.kind === 'session' ? serving(graph, node, entry, now) : null
  const session = graph.nodes.get(id)
  if (!session) return null
  const ended = graph.seenLive.has(id) || (session.openTools.size === 0 && now - session.lastAt > CLOSED_GRACE_MS)
  return ended ? { status: 'closed' } : null
}

export function applyLines(graph, nodeId, text) {
  for (const line of text.split('\n')) {
    if (!line) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      // A malformed line is skipped; one bad record must not stop the rest of the file.
      continue
    }
    try {
      applyRecord(graph, nodeId, record)
    } catch (error) {
      // A record we fail on is skipped too, but that's a bug of ours, so say so (once).
      if (!reportedError) console.error('agent-orrery: skipped a record it could not read', error)
      reportedError = true
    }
  }
}

function mainRepo(repos) {
  let best = null
  for (const [repo, count] of Object.entries(repos)) if (!best || count > repos[best]) best = repo
  return best
}

const repoOfRoom = (room) => room.split(AREA_SEPARATOR)[0]

// A session's room is its working folder (where it started, or last moved to). At a monorepo's root, that's the area it worked in most there.
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

// Its background shells still running: none in a replay, none once its session has ended, and none
// older than the cap.
function shellsOf(graph, node, now) {
  if (now === null || liveOf(graph, node, now)?.status === 'closed') return []
  return openShells(node, now)
}

function publicNode(graph, node, now) {
  const parentId = parentOf(graph, node)
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
    shells: shellsOf(graph, node, now),
    owesReply: node.kind === 'session' && node.owesReply === true,
    usage: node.usage,
    agentType: node.agentType ?? null,
    model: node.model ?? null,
    sessionId: node.sessionId ?? null,
    parentId,
    plans: [...node.plans],
    live: liveOf(graph, node, now),
    youWaits: node.youWaits,
    artifacts: [...node.artifacts.values()].reverse(),
    toolCount: node.toolCount,
  }
}

const parentOf = (graph, node) => (node.kind === 'subagent' ? (graph.toolUseOwner.get(node.spawnToolUseId) ?? node.sessionId) : null)
const sessionOf = (node) => (node.kind === 'session' ? node.id : node.sessionId)

// Whether two agents' edits of one file could have crossed. A parent and the subagent it started hand
// work to each other, so they never count. Agents of one session count while their edits overlap;
// separate sessions don't know about each other, so editing within the window of each other counts.
function editsCross(graph, a, b, editA, editB) {
  if (parentOf(graph, a) === b.id || parentOf(graph, b) === a.id) return false
  const gap = Math.max(editA.first, editB.first) - Math.min(editA.last, editB.last)
  return sessionOf(a) === sessionOf(b) ? gap <= 0 : gap < COLLISION_MS
}

// Pairs of agents that edited the same file lately: [{ a, b, files (basenames), repo, at }].
function collisions(graph, nodes, now) {
  const editors = new Map()
  for (const node of nodes) {
    for (const [path, edit] of node.edits ?? []) if (now - edit.last < COLLISION_MS) editors.set(path, [...(editors.get(path) ?? []), [node, edit]])
  }
  const pairs = new Map()
  for (const [path, list] of editors) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [[a, editA], [b, editB]] = [list[i], list[j]].sort(([x], [y]) => (x.id < y.id ? -1 : 1))
        if (!editsCross(graph, a, b, editA, editB)) continue
        const key = `${a.id}>${b.id}`
        const pair = pairs.get(key) ?? { a: a.id, b: b.id, files: [], repo: editA.repo ?? editB.repo ?? null, at: 0 }
        if (!pair.files.includes(basename(path))) pair.files.push(basename(path))
        pair.at = Math.max(pair.at, editA.last, editB.last)
        pairs.set(key, pair)
      }
    }
  }
  return [...pairs.values()]
}

// A session waiting on you stays visible longer than everything else, so a real wait
// doesn't silently drop off the list. Collisions are live only: pass now to get them.
export function snapshot(graph, since, waitingSince = since, now = null) {
  const isVisible = (node) => node.lastAt >= since || (node.kind === 'session' && node.waiting && node.lastAt >= waitingSince)
  // A placeholder for a name or socket that turned out to be a session we know is that session.
  const canonical = (id) => {
    const resolved = resolveAgent(graph, id)
    return graph.nodes.has(resolved) ? resolved : id
  }
  const visible = [...graph.nodes.values()].filter((node) => isVisible(node) && canonical(node.id) === node.id)
  const ids = new Set(visible.map((node) => node.id))
  const nodes = visible.map((node) => publicNode(graph, node, now))
  for (const node of nodes) if (!ids.has(node.parentId)) node.parentId = null
  collapseAreas(nodes)
  const joined = new Map()
  for (const edge of graph.messages.values()) {
    const [from, to] = [canonical(edge.from), canonical(edge.to)]
    if (from === to || !ids.has(from) || !ids.has(to)) continue
    const key = `${from}>${to}`
    const same = joined.get(key)
    joined.set(key, same ? { ...same, sent: same.sent + edge.sent, received: same.received + edge.received, lastAt: Math.max(same.lastAt, edge.lastAt), firstAt: Math.min(same.firstAt, edge.firstAt) } : { ...edge, from, to })
  }
  const messages = [...joined.values()].map(({ sent, received, ...edge }) => ({ ...edge, count: Math.max(sent, received) }))
  return { nodes, messages, collisions: now === null ? [] : collisions(graph, visible, now) }
}

// The state a node had at `at`: the latest history entry that is not later than it.
function nodeAt(node, at) {
  const entry = node.history.findLast((candidate) => candidate[0] <= at)
  // Before the oldest kept entry there's nothing to show but that the node existed.
  const youWaits = node.youWaits.filter(([, end]) => end <= at)
  const artifacts = new Map([...node.artifacts].filter(([, artifact]) => artifact.at <= at))
  const past = { openTools: new Map(), backgroundTasks: new Map(), youWaits, artifacts }
  if (!entry) return { ...node, ...past, activity: null, lastTool: null, waiting: null, lastAt: Math.min(node.firstAt, at) }
  const [since, activity, reason, lastTool, lastAt] = entry
  return { ...node, ...past, activity, lastTool, lastAt: Math.min(lastAt, at), waiting: reason && { reason, since } }
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

// What Claude Code itself says, where it says it (the same rule as liveWait in web/src/status.ts):
// a prompt or dialog open, or a turn over with nothing left running, is waiting on you; busy isn't.
function liveWait(node) {
  const { live } = node
  if (live.status === 'waiting') return { reason: live.reason, since: live.since }
  if (live.status === 'idle') return node.waiting ?? { reason: 'reply', since: live.since }
  return null
}

// A session whose turn ended while its subagents or background calls still run is waiting on them, not on you.
export function waitingSessions({ nodes }, now = Date.now()) {
  const busy = new Set(nodes.filter((node) => node.kind === 'subagent' && isRunning(node, now)).map((node) => node.sessionId))
  for (const node of nodes) if (node.kind === 'session' && runsInBackground(node, now)) busy.add(node.id)
  const asking = (node) => (probablyAsking(node, now) ? { reason: 'question', since: node.lastAt } : null)
  const guessed = (node) => {
    const waiting = asking(node) ?? node.waiting
    return waiting && (waiting.reason === 'question' || !busy.has(node.id)) ? waiting : null
  }
  return nodes
    .filter((node) => node.kind === 'session')
    .map((node) => ({ node, waiting: node.live ? liveWait(node) : guessed(node) }))
    .filter(({ waiting }) => waiting)
    .map(({ node, waiting }) => ({ id: node.id, label: node.label, room: node.room, branch: node.branch, reason: waiting.reason, since: waiting.since }))
    .sort((a, b) => a.since - b.since)
}

// Drops nodes whose last activity is older than the cutoff, plus any named in `gone` (their
// transcript was deleted), and the messages that touch them.
// Returns their ids, so their transcripts can stop being read.
export function forget(graph, cutoff, gone = []) {
  const forgotten = new Set(gone)
  for (const [id, node] of graph.nodes) if (node.lastAt > 0 && node.lastAt < cutoff) forgotten.add(id)
  for (const id of forgotten) {
    graph.nodes.delete(id)
    graph.seenLive.delete(id)
  }
  for (const [alias, id] of graph.aliases) if (forgotten.has(id)) graph.aliases.delete(alias)
  for (const [key, edge] of graph.messages) if (forgotten.has(edge.from) || forgotten.has(edge.to)) graph.messages.delete(key)
  return forgotten
}

// Records closer together than this read as one stretch of work in the day view.
const SPAN_JOIN_MS = 2 * 60_000

// Joins [start, end] spans that overlap or nearly touch.
export function joinSpans(spans, gap = 0) {
  const joined = []
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = joined.at(-1)
    if (last && start - last[1] <= gap) last[1] = Math.max(last[1], end)
    else joined.push([start, end])
  }
  return joined
}

// When an agent was working, from its history: every stretch that wasn't a wait.
function workSpans(node, since) {
  const spans = node.history.filter(([, , reason]) => !reason).map(([start, , , , last]) => [start, last])
  return joinSpans(spans, SPAN_JOIN_MS).filter(([, end]) => end >= since)
}

// For the day view: per session from `since`, when it worked and when its subagents did.
export function day(graph, since) {
  const agentSpans = new Map()
  for (const node of graph.nodes.values()) {
    if (node.kind === 'subagent' && node.sessionId) agentSpans.set(node.sessionId, [...(agentSpans.get(node.sessionId) ?? []), ...workSpans(node, since)])
  }
  return [...graph.nodes.values()]
    .filter((node) => node.kind === 'session' && node.lastAt >= since)
    .map((node) => ({ id: node.id, runs: workSpans(node, since), agentRuns: joinSpans(agentSpans.get(node.id) ?? [], SPAN_JOIN_MS) }))
}

export function timeline(graph, id) {
  return graph.nodes.get(id)?.events ?? null
}
