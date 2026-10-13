// Serves a live graph of local Claude Code sessions, built by tailing their transcripts,
// plus read-only views of the plans and memory notes Claude keeps.
// Loopback-only, with no hooks and no runtime dependencies. It never writes Claude Code's files or your
// code; the only thing it writes is its own state (settings, dismissals) in its data folder.

import { createServer } from 'node:http'
import { watch } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createArtifactIndex } from './artifacts.mjs'
import { applyLines, createGraph, day, ensureNode, forget, replay, setLive, snapshot, timeline, waitingSessions } from './graph.mjs'
import { createLibrary } from './library.mjs'
import { createRepoResolver, readText } from './repos.mjs'
import { createStore, settingDefaults } from './store.mjs'
import { agentTranscripts, listDir } from './transcripts.mjs'

const PORT = Number(process.env.AGENT_ORRERY_PORT ?? 4777)
// Inside Docker the server must listen on all interfaces; compose publishes it on 127.0.0.1 only.
const BIND_HOST = process.env.AGENT_ORRERY_BIND ?? '127.0.0.1'
const HOUR_MS = 3_600_000
const WINDOW_MS = Number(process.env.AGENT_ORRERY_WINDOW_HOURS ?? 6) * HOUR_MS
const WAITING_WINDOW_MS = Number(process.env.AGENT_ORRERY_WAITING_HOURS ?? 24) * HOUR_MS
const CLAUDE_DIR = process.env.AGENT_ORRERY_CLAUDE_DIR ?? join(homedir(), '.claude')
const PROJECTS_DIR = join(CLAUDE_DIR, 'projects')
// Where Agent Orrery keeps its own state. compose.yaml mounts a folder here; it's the only one it writes.
const DATA_DIR = process.env.AGENT_ORRERY_DATA_DIR ?? join(homedir(), '.config', 'agent-orrery')
// Claude Code keeps a small status file per running session here, named by its process id.
const SESSIONS_DIR = join(CLAUDE_DIR, 'sessions')
// Only these names are opened; the folder also holds each session's secret key file.
const STATUS_FILE = /^\d{1,10}\.json$/
// Your plan's usage, written by the status line bridge (statusline/orrery-usage.sh), if you set it up.
const USAGE_DIR = join(CLAUDE_DIR, 'orrery')
const USAGE_FILE = join(USAGE_DIR, 'usage.json')
const SECONDS_IN_MS = 1000
const EPOCH_MS_FROM = 1e12
const WEB_DIR = fileURLToPath(new URL('./web/dist/', import.meta.url))
// File events trigger a read straight away; the slower check catches events that get lost,
// which happens with Docker's file sharing.
const EVENT_DEBOUNCE_MS = 150
const FALLBACK_INTERVAL_MS = 5_000
const POLL_INTERVAL_MS = 1_000
const DISCOVER_EVERY_MS = 30_000
const READ_CHUNK_BYTES = 4 * 1024 * 1024
const MIN_PUSH_MS = 1_000

const library = createLibrary({ claudeDir: CLAUDE_DIR })
const resolveRepo = createRepoResolver()
const graph = createGraph({ resolveRepo, plansDir: library.plansDir })
const artifacts = createArtifactIndex({ projectsDir: PROJECTS_DIR, resolveRepo })
const tracked = new Map()
const sessionDirs = new Map()

function track(path, nodeId) {
  if (!tracked.has(path)) tracked.set(path, { nodeId, offset: 0, rest: Buffer.alloc(0) })
}

async function discoverSessions() {
  const cutoff = Date.now() - Math.max(WINDOW_MS, WAITING_WINDOW_MS)
  for (const project of await listDir(PROJECTS_DIR)) {
    const projectDir = join(PROJECTS_DIR, project)
    for (const name of await listDir(projectDir)) {
      const path = join(projectDir, name)
      if (!name.endsWith('.jsonl') || tracked.has(path)) continue
      const info = await stat(path).catch(() => null)
      if (!info || info.mtimeMs < cutoff) continue
      const sessionId = name.slice(0, -'.jsonl'.length)
      ensureNode(graph, sessionId, { kind: 'session', label: sessionId.slice(0, 8), sessionId })
      sessionDirs.set(sessionId, join(projectDir, sessionId))
      track(path, sessionId)
    }
  }
}

// A workflow's agents say which phase of it they belong to; that names them better than their type.
const agentTypeOf = (meta) => (typeof meta.workflowPhase === 'string' && meta.workflowPhase ? `${meta.workflowPhase} (workflow)` : (meta.agentType ?? null))

async function discoverSubagents() {
  for (const [sessionId, sessionDir] of sessionDirs) {
    for (const { path, metaPath, agentId } of await agentTranscripts(sessionDir)) {
      if (tracked.has(path)) continue
      const meta = await readFile(metaPath, 'utf8')
        .then(JSON.parse)
        .catch(() => ({}))
      // A workflow's agents have no spawning call of their own, so they belong to the session.
      ensureNode(graph, agentId, {
        kind: 'subagent',
        label: String(meta.description ?? agentId),
        agentType: agentTypeOf(meta),
        model: meta.model ?? null,
        spawnToolUseId: meta.toolUseId ?? null,
        sessionId,
      })
      track(path, agentId)
    }
  }
}

async function readAppended(path, entry) {
  const info = await stat(path).catch(() => null)
  if (!info || info.size === entry.offset) return
  if (info.size < entry.offset) entry.offset = 0
  const handle = await open(path, 'r')
  try {
    // In chunks, so a large transcript's first read never needs it all in memory at once.
    while (entry.offset < info.size) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, info.size - entry.offset))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, entry.offset)
      if (bytesRead === 0) break
      entry.offset += bytesRead
      // Keep the unfinished last line as bytes, so a UTF-8 character split across reads stays intact.
      // It's copied: a view would keep the whole chunk alive for as long as the file is tracked.
      const data = Buffer.concat([entry.rest, chunk.subarray(0, bytesRead)])
      const end = data.lastIndexOf(0x0a) + 1
      entry.rest = Buffer.from(data.subarray(end))
      applyLines(graph, entry.nodeId, data.subarray(0, end).toString('utf8'))
    }
  } finally {
    await handle.close()
  }
}

// Whether a process is still running. Errors other than "no such process" (EPERM) mean it is.
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== 'ESRCH'
  }
}

// What each running session is doing, in Claude Code's own words: busy, shell, idle or waiting, and
// for a wait what it waits for. Null when the folder can't be read (an older Claude Code, or not
// shared with Docker), which means unknown, not that every session has ended.
async function readLiveSessions() {
  const names = await readdir(SESSIONS_DIR).catch(() => null)
  if (!names) return null
  const sessions = []
  for (const name of names) {
    if (!STATUS_FILE.test(name)) continue
    let file
    try {
      file = JSON.parse(readText(join(SESSIONS_DIR, name)))
    } catch {
      continue
    }
    // A crash leaves its file behind until the next Claude Code starts. Process ids can only be
    // checked on the same system; inside Docker the file has to be believed.
    if (file.pidDomain === process.platform && Number.isInteger(file.pid) && !isAlive(file.pid)) continue
    const waitingFor = typeof file.waitingFor === 'string' ? file.waitingFor : null
    sessions.push({ sessionId: file.sessionId, status: file.status, waitingFor, since: file.statusUpdatedAt })
  }
  return sessions
}

// A time from the status line: epoch seconds or milliseconds, or an ISO date. Null if none of those.
function timeOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < EPOCH_MS_FROM ? value * SECONDS_IN_MS : value
  if (typeof value === 'string') return Date.parse(value) || null
  return null
}

function windowOf(value) {
  const percent = value?.used_percentage
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return null
  return { percent: Math.min(100, Math.max(0, percent)), resetsAt: timeOf(value.resets_at) }
}

// The plan's session (five-hour) and weekly windows, and when they were seen; null without the bridge.
export function parseUsage(text) {
  try {
    const usage = JSON.parse(text)
    const at = timeOf(usage.at)
    const fiveHour = windowOf(usage.five_hour)
    const sevenDay = windowOf(usage.seven_day)
    return at && (fiveHour || sevenDay) ? { at, fiveHour, sevenDay } : null
  } catch {
    return null
  }
}

const readUsage = () => parseUsage(readText(USAGE_FILE))

const clients = new Set()
let lastPayload = ''
let lastPushAt = 0
let pushTimer = null

// At most one push a second: the page redraws on each one, and busy agents write many times a second.
function push(payload) {
  lastPayload = payload
  const wait = lastPushAt + MIN_PUSH_MS - Date.now()
  if (wait > 0) {
    pushTimer ??= setTimeout(() => {
      pushTimer = null
      send()
    }, wait)
    return
  }
  send()
}

function send() {
  lastPushAt = Date.now()
  for (const response of clients) response.write(`data: ${lastPayload}\n\n`)
}

// Transcripts and nodes older than discovery would pick up are dropped; a new line brings them back.
function forgetOld() {
  const cutoff = Date.now() - Math.max(WINDOW_MS, WAITING_WINDOW_MS)
  const forgotten = forget(graph, cutoff)
  for (const [path, entry] of tracked) if (forgotten.has(entry.nodeId)) tracked.delete(path)
  for (const id of forgotten) sessionDirs.delete(id)
}

// Reads the files named by file events, or every tracked file when none are named.
async function tick(discover, paths) {
  if (discover) {
    forgetOld()
    await discoverSessions()
    await discoverSubagents()
  }
  for (const [path, entry] of tracked) if (!paths || paths.has(path)) await readAppended(path, entry)
  const now = Date.now()
  setLive(graph, await readLiveSessions(), now)
  const payload = JSON.stringify({ ...snapshot(graph, now - WINDOW_MS, now - WAITING_WINDOW_MS, now), usage: readUsage() })
  if (payload !== lastPayload) push(payload)
}

// Runs one tick at a time; a request during a tick runs another straight after it.
function createScheduler() {
  let running = false
  let again = false
  let discoverNext = true
  let lastDiscovery = 0
  // Files named by file events since the last read; null means read them all.
  let named = null
  let everything = true
  async function run() {
    if (running) {
      again = true
      return
    }
    running = true
    do {
      again = false
      const discover = discoverNext || Date.now() - lastDiscovery >= DISCOVER_EVERY_MS
      discoverNext = false
      if (discover) lastDiscovery = Date.now()
      const paths = everything || discover ? null : named
      named = null
      everything = false
      await tick(discover, paths).catch((error) => console.error('agent-orrery: read failed', error))
    } while (again)
    running = false
  }
  let timer = null
  return {
    // A burst of events reads once, 150 ms after the first; waiting for a pause would put a busy
    // agent's updates off until the fallback check.
    soon({ discover = false, path = null } = {}) {
      discoverNext ||= discover
      if (path && !everything) (named ??= new Set()).add(path)
      timer ??= setTimeout(() => {
        timer = null
        run()
      }, EVENT_DEBOUNCE_MS)
    },
    now() {
      everything = true
      return run()
    },
  }
}

function startWatching(scheduler) {
  const poll = () => setInterval(scheduler.now, POLL_INTERVAL_MS)
  try {
    const watcher = watch(PROJECTS_DIR, { recursive: true }, (_event, name) => {
      if (!name || !name.endsWith('.jsonl')) return
      // A transcript we don't track yet means a new session or subagent.
      const path = join(PROJECTS_DIR, name)
      scheduler.soon({ discover: !tracked.has(path), path })
    })
    // A permission prompt changes a session's status file, not its transcript.
    let statusWatcher = null
    try {
      statusWatcher = watch(SESSIONS_DIR, (_event, name) => name && STATUS_FILE.test(name) && scheduler.soon())
      statusWatcher.on('error', () => statusWatcher.close())
    } catch {
      // No sessions folder (yet): the fallback check reads it once it exists.
    }
    // The bridge rewrites its file whenever a status line is drawn.
    let usageWatcher = null
    try {
      usageWatcher = watch(USAGE_DIR, () => scheduler.soon())
      usageWatcher.on('error', () => usageWatcher.close())
    } catch {
      // No bridge set up: the fallback check picks it up if one appears.
    }
    const fallback = setInterval(scheduler.now, FALLBACK_INTERVAL_MS)
    watcher.on('error', (error) => {
      console.warn('agent-orrery: file events stopped, polling instead', error.message)
      watcher.close()
      statusWatcher?.close()
      usageWatcher?.close()
      clearInterval(fallback)
      poll()
    })
    return 'file events'
  } catch {
    poll()
    return 'polling'
  }
}

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`])
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((host) => `http://${host}`))
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
}
const escapeAttribute = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// The page starts from its state in a meta tag, so it draws with the right settings at once; a script
// tag would need the CSP loosened.
export function withState(html, state) {
  return html.replace('<head>', `<head><meta name="agent-orrery-state" content="${escapeAttribute(JSON.stringify(state))}">`)
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
}

// Rejects DNS rebinding (foreign Host) and cross-site requests (foreign Origin or Sec-Fetch-Site).
// Opening the page itself from a link elsewhere is fine: the other site can't read a top-level page.
export function isTrustedRequest(headers) {
  if (!ALLOWED_HOSTS.has(headers.host)) return false
  if (headers.origin !== undefined && !ALLOWED_ORIGINS.has(headers.origin)) return false
  const site = headers['sec-fetch-site']
  if (site === undefined || site === 'same-origin' || site === 'none') return true
  return headers['sec-fetch-mode'] === 'navigate' && headers['sec-fetch-dest'] === 'document'
}

// Writes come only from the page itself: on top of the checks for every request, a write must say it
// came from our own origin, as a browser always does for a fetch that changes something, and send JSON,
// which a form on another site can't.
export function isTrustedWrite(headers) {
  return isTrustedRequest(headers) && ALLOWED_ORIGINS.has(headers.origin) && headers['sec-fetch-site'] !== 'cross-site' && headers['content-type']?.split(';')[0].trim() === 'application/json'
}

const MAX_BODY_BYTES = 64 * 1024

async function readJsonBody(request) {
  let size = 0
  const chunks = []
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

// The built page is served from a fixed list made at start-up, so a URL can never name another file.
async function listWebFiles(directory, files = new Map()) {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await listWebFiles(path, files)
    else if (CONTENT_TYPES[extname(entry.name)]) files.set(`/${relative(WEB_DIR, path)}`, path)
  }
  return files
}

function sendJson(response, body) {
  if (body === null) {
    response.writeHead(404, SECURITY_HEADERS).end()
    return
  }
  response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' }).end(JSON.stringify(body))
}

const API_ROUTES = {
  '/api/waiting': () => {
    const now = Date.now()
    return waitingSessions(snapshot(graph, now - WINDOW_MS, now - WAITING_WINDOW_MS, now), now)
  },
  '/api/timeline': (query) => timeline(graph, query.get('id') ?? ''),
  '/api/replay': (query) => {
    const at = Number(query.get('at'))
    return Number.isFinite(at) && query.get('at') ? replay(graph, at, WINDOW_MS, WAITING_WINDOW_MS) : null
  },
  '/api/window': () => ({ windowMs: WINDOW_MS }),
  '/api/usage': () => readUsage() ?? {},
  '/api/day': (query) => {
    const since = Number(query.get('since'))
    return Number.isFinite(since) && query.get('since') ? day(graph, since) : null
  },
  '/api/plans': () => library.listPlans(),
  '/api/plan': (query) => library.readPlan(query.get('name') ?? ''),
  '/api/memory': () => library.listMemory(),
  '/api/memory/note': (query) => library.readMemory(query.get('project') ?? '', query.get('name') ?? ''),
  '/api/search': async (query) => ({ ...(await library.search(query.get('q') ?? '')), artifacts: await artifacts.search(query.get('q') ?? '') }),
  '/api/artifacts': () => artifacts.list(),
}

// Every open page hears about a change made in another, so a dismissal shows everywhere at once.
function sendState(state, to = clients) {
  for (const response of to) response.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`)
}

const WRITE_ROUTES = {
  '/api/settings': (store, body) => store.changeSettings(body),
  '/api/dismissals': (store, body) => store.changeDismissals(body),
}

function createHandler(webFiles, store) {
  return async function handle(request, response) {
    const write = WRITE_ROUTES[new URL(request.url, 'http://localhost').pathname]
    if (request.method === 'PATCH' && write && isTrustedWrite(request.headers)) {
      const body = await readJsonBody(request)
      if (body === null) {
        response.writeHead(400, SECURITY_HEADERS).end()
        return
      }
      await write(store, body)
      sendState(store.get())
      response.writeHead(204, SECURITY_HEADERS).end()
      return
    }
    if (!isTrustedRequest(request.headers) || request.method !== 'GET') {
      const { host, origin } = request.headers
      console.warn(`agent-orrery: refused ${request.method} host=${host} origin=${origin} site=${request.headers['sec-fetch-site']}`)
      response.writeHead(403, SECURITY_HEADERS).end()
      return
    }
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname === '/events') {
      response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream' })
      response.write(`data: ${lastPayload || '{"nodes":[],"messages":[]}'}\n\n`)
      // A page that reconnects may have missed changes made while it was away.
      sendState(store.get(), [response])
      clients.add(response)
      request.on('close', () => clients.delete(response))
      return
    }
    const route = API_ROUTES[url.pathname]
    if (route) {
      sendJson(response, await route(url.searchParams))
      return
    }
    const file = webFiles.get(url.pathname === '/' ? '/index.html' : url.pathname)
    if (!file) {
      response.writeHead(404, SECURITY_HEADERS).end()
      return
    }
    const body = file.endsWith('index.html') ? withState(await readFile(file, 'utf8'), store.get()) : await readFile(file)
    response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': CONTENT_TYPES[extname(file)] }).end(body)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const webFiles = await listWebFiles(WEB_DIR)
  if (!webFiles.has('/index.html')) console.warn('agent-orrery: no built page in web/dist; run `pnpm build` first')
  const handle = createHandler(webFiles, createStore({ dir: DATA_DIR, defaults: settingDefaults() }))
  createServer((request, response) => {
    handle(request, response).catch(() => response.writeHead(500, SECURITY_HEADERS).end())
  }).listen(PORT, BIND_HOST, () => console.log(`agent-orrery: http://127.0.0.1:${PORT}`))
  const scheduler = createScheduler()
  scheduler.now()
  console.log(`agent-orrery: following transcripts with ${startWatching(scheduler)}`)
}
