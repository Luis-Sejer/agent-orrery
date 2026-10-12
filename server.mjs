// Serves a live graph of local Claude Code sessions, built by tailing their transcripts,
// plus read-only views of the plans and memory notes Claude keeps.
// Read-only and loopback-only: no hooks, no runtime dependencies, nothing written to disk.

import { createServer } from 'node:http'
import { watch } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { applyLines, createGraph, ensureNode, replay, snapshot, timeline, waitingSessions } from './graph.mjs'
import { createLibrary } from './library.mjs'
import { createRepoResolver } from './repos.mjs'

const PORT = Number(process.env.AGENT_ORRERY_PORT ?? 4777)
// Inside Docker the server must listen on all interfaces; compose publishes it on 127.0.0.1 only.
const BIND_HOST = process.env.AGENT_ORRERY_BIND ?? '127.0.0.1'
const HOUR_MS = 3_600_000
const WINDOW_MS = Number(process.env.AGENT_ORRERY_WINDOW_HOURS ?? 6) * HOUR_MS
const WAITING_WINDOW_MS = Number(process.env.AGENT_ORRERY_WAITING_HOURS ?? 24) * HOUR_MS
const CLAUDE_DIR = process.env.AGENT_ORRERY_CLAUDE_DIR ?? join(homedir(), '.claude')
const PROJECTS_DIR = join(CLAUDE_DIR, 'projects')
const WEB_DIR = fileURLToPath(new URL('./web/dist/', import.meta.url))
// File events trigger a read straight away; the slower check catches events that get lost,
// which happens with Docker's file sharing.
const EVENT_DEBOUNCE_MS = 150
const FALLBACK_INTERVAL_MS = 5_000
const POLL_INTERVAL_MS = 1_000
const DISCOVER_EVERY_MS = 30_000

const library = createLibrary({ claudeDir: CLAUDE_DIR })
const graph = createGraph({ resolveRepo: createRepoResolver(), plansDir: library.plansDir })
const tracked = new Map()
const sessionDirs = new Map()

async function listDir(path) {
  return readdir(path).catch(() => [])
}

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

async function discoverSubagents() {
  for (const [sessionId, sessionDir] of sessionDirs) {
    const subagentDir = join(sessionDir, 'subagents')
    for (const name of await listDir(subagentDir)) {
      const path = join(subagentDir, name)
      if (!name.startsWith('agent-') || !name.endsWith('.jsonl') || tracked.has(path)) continue
      const agentId = name.slice('agent-'.length, -'.jsonl'.length)
      const meta = await readFile(join(subagentDir, `agent-${agentId}.meta.json`), 'utf8')
        .then(JSON.parse)
        .catch(() => ({}))
      ensureNode(graph, agentId, {
        kind: 'subagent',
        label: String(meta.description ?? agentId),
        agentType: meta.agentType ?? null,
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
    const chunk = Buffer.alloc(info.size - entry.offset)
    await handle.read(chunk, 0, chunk.length, entry.offset)
    entry.offset = info.size
    // Keep the unfinished last line as bytes, so a UTF-8 character split across reads stays intact.
    const data = Buffer.concat([entry.rest, chunk])
    const end = data.lastIndexOf(0x0a) + 1
    entry.rest = data.subarray(end)
    applyLines(graph, entry.nodeId, data.subarray(0, end).toString('utf8'))
  } finally {
    await handle.close()
  }
}

const clients = new Set()
let lastPayload = ''

async function tick(discover) {
  if (discover) {
    await discoverSessions()
    await discoverSubagents()
  }
  for (const [path, entry] of tracked) await readAppended(path, entry)
  const now = Date.now()
  const payload = JSON.stringify(snapshot(graph, now - WINDOW_MS, now - WAITING_WINDOW_MS))
  if (payload === lastPayload) return
  lastPayload = payload
  for (const response of clients) response.write(`data: ${payload}\n\n`)
}

// Runs one tick at a time; a request during a tick runs another straight after it.
function createScheduler() {
  let running = false
  let again = false
  let discoverNext = true
  let lastDiscovery = 0
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
      await tick(discover).catch((error) => console.error('agent-orrery: read failed', error))
    } while (again)
    running = false
  }
  let timer = null
  return {
    soon({ discover = false } = {}) {
      discoverNext ||= discover
      clearTimeout(timer)
      timer = setTimeout(run, EVENT_DEBOUNCE_MS)
    },
    now: run,
  }
}

function startWatching(scheduler) {
  const poll = () => setInterval(scheduler.now, POLL_INTERVAL_MS)
  try {
    const watcher = watch(PROJECTS_DIR, { recursive: true }, (_event, name) => {
      if (!name || !name.endsWith('.jsonl')) return
      // A transcript we don't track yet means a new session or subagent.
      scheduler.soon({ discover: !tracked.has(join(PROJECTS_DIR, name)) })
    })
    const fallback = setInterval(scheduler.now, FALLBACK_INTERVAL_MS)
    watcher.on('error', (error) => {
      console.warn('agent-orrery: file events stopped, polling instead', error.message)
      watcher.close()
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
    return waitingSessions(snapshot(graph, now - WINDOW_MS, now - WAITING_WINDOW_MS))
  },
  '/api/timeline': (query) => timeline(graph, query.get('id') ?? ''),
  '/api/replay': (query) => {
    const at = Number(query.get('at'))
    return Number.isFinite(at) && query.get('at') ? replay(graph, at, WINDOW_MS, WAITING_WINDOW_MS) : null
  },
  '/api/window': () => ({ windowMs: WINDOW_MS }),
  '/api/plans': () => library.listPlans(),
  '/api/plan': (query) => library.readPlan(query.get('name') ?? ''),
  '/api/memory': () => library.listMemory(),
  '/api/memory/note': (query) => library.readMemory(query.get('project') ?? '', query.get('name') ?? ''),
  '/api/search': (query) => library.search(query.get('q') ?? ''),
}

function createHandler(webFiles) {
  return async function handle(request, response) {
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
    const body = await readFile(file)
    response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': CONTENT_TYPES[extname(file)] }).end(body)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const webFiles = await listWebFiles(WEB_DIR)
  if (!webFiles.has('/index.html')) console.warn('agent-orrery: no built page in web/dist; run `pnpm build` first')
  const handle = createHandler(webFiles)
  createServer((request, response) => {
    handle(request, response).catch(() => response.writeHead(500, SECURITY_HEADERS).end())
  }).listen(PORT, BIND_HOST, () => console.log(`agent-orrery: http://127.0.0.1:${PORT}`))
  const scheduler = createScheduler()
  scheduler.now()
  console.log(`agent-orrery: following transcripts with ${startWatching(scheduler)}`)
}
