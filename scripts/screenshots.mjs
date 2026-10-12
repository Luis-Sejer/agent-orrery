// Takes the README screenshots from the demo data, so they never show real sessions.
// Needs Google Chrome; set CHROME_PATH if it isn't in the usual place.
//
//   pnpm screenshots

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEMO_PORT = '4791'
const DEBUG_PORT = 9341
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false }
const OUT_DIR = fileURLToPath(new URL('../docs/screenshots/', import.meta.url))
const DEMO = fileURLToPath(new URL('./demo.mjs', import.meta.url))
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return
    await sleep(250)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()
  const socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve) => socket.addEventListener('open', resolve))
  let id = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    pending.get(message.id)?.(message.result)
    pending.delete(message.id)
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      pending.set(++id, resolve)
      socket.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value
  return { send, evaluate, close: () => socket.close() }
}

const clickView = (name) => `[...document.querySelectorAll('.views button')].find((b) => b.textContent === '${name}').click()`
const clickNode = (label) => `[...document.querySelectorAll('.react-flow__node')].find((n) => n.textContent.includes('${label}')).click()`

const SHOTS = [
  { name: 'overview', steps: [] },
  { name: 'focus', steps: [clickNode('Checkout redesign')] },
  { name: 'plans', steps: [clickView('Plans')] },
  { name: 'memory', steps: [clickView('Memory'), `[...document.querySelectorAll('.library-list button')][2].click()`] },
]

const chromePath = CHROME_CANDIDATES.find((path) => existsSync(path))
if (!chromePath) throw new Error('Google Chrome not found; set CHROME_PATH')

const demo = spawn(process.execPath, [DEMO], { stdio: 'ignore', env: { ...process.env, AGENT_GRAPH_PORT: DEMO_PORT } })
const profile = mkdtempSync(join(tmpdir(), 'agent-graph-chrome-'))
const chrome = spawn(chromePath, ['--headless=new', '--hide-scrollbars', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })

try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${DEMO_PORT}/`)).ok, 'the demo server')
  await waitFor(async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).ok, 'Chrome')
  const page = await connect()
  await page.send('Emulation.setDeviceMetricsOverride', VIEWPORT)
  mkdirSync(OUT_DIR, { recursive: true })

  for (const shot of SHOTS) {
    await page.send('Page.navigate', { url: `http://127.0.0.1:${DEMO_PORT}/` })
    await waitFor(async () => (await page.evaluate("document.querySelectorAll('.card').length")) > 5, 'the graph')
    // Let the first data arrive, the canvas fit, and the orbs draw a few frames.
    await sleep(2_500)
    for (const step of shot.steps) {
      await page.evaluate(step)
      await sleep(1_500)
    }
    const { data } = await page.send('Page.captureScreenshot', { format: 'webp', quality: 90 })
    writeFileSync(join(OUT_DIR, `${shot.name}.webp`), Buffer.from(data, 'base64'))
    console.log(`docs/screenshots/${shot.name}.webp`)
  }
  page.close()
} finally {
  demo.kill()
  // Chrome keeps writing to its profile while it shuts down, so wait before deleting it.
  const chromeExited = new Promise((resolve) => chrome.once('exit', resolve))
  chrome.kill()
  await chromeExited
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
}
