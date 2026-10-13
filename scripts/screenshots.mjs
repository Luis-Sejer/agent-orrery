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
// The monorepo demo (`pnpm demo --monorepo`) runs beside it for the monorepo shot.
const MONOREPO_PORT = '4793'
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

const clickNode = (label) => `[...document.querySelectorAll('.react-flow__node')].find((n) => n.textContent.includes('${label}')).click()`
const OPEN_SETTINGS = `document.querySelector('.settings-button').click()`
const CLOSE_SETTINGS = `document.getElementById('settings').hidePopover()`
const toggleSetting = (label) => `[...document.querySelectorAll('#settings label')].find((row) => row.textContent.startsWith('${label}')).querySelector('input').click()`
// React keeps its own copy of an input's value, so set it through the native setter and announce it.
const setInput = (selector, value) =>
  `(() => { const input = document.querySelector('${selector}'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${value}); input.dispatchEvent(new Event('input', { bubbles: true })) })()`

const OPEN_SEARCH = `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))`
const TYPE_SEARCH = (text) => setInput('.palette input', `'${text}'`)
// The orrery fits its widest ring, which leaves the orbs small at 1440 wide; one step in still keeps every ring in frame.
const ZOOM_IN = `document.querySelector('.react-flow__controls-zoomin').click()`
const SCRUB_BACK = (minutes) => setInput('.replay-bar input[type=range]', `Date.now() - ${minutes} * 60_000`)

// Each shot sets its view, theme, arrangement and clean view in localStorage first, so it never
// depends on the defaults; a shot lists only what differs from these.
const DEFAULTS = { view: 'orrery', theme: 'light', arrangement: 'status', clean: 'off' }
const SHOTS = [
  { name: 'orrery', steps: [ZOOM_IN] },
  { name: 'orrery-dark', theme: 'dark', steps: [ZOOM_IN] },
  { name: 'tycho', theme: 'tycho', steps: [ZOOM_IN] },
  { name: 'orrery-repo', arrangement: 'room', steps: [ZOOM_IN] },
  { name: 'galaxy', theme: 'tycho', arrangement: 'galaxy', steps: [] },
  { name: 'settings', steps: [ZOOM_IN, OPEN_SETTINGS] },
  { name: 'agents', view: 'graph', steps: [] },
  { name: 'dark', view: 'graph', theme: 'dark', steps: [] },
  { name: 'search', view: 'graph', steps: [OPEN_SEARCH, TYPE_SEARCH('checkout')] },
  { name: 'focus', view: 'graph', steps: [clickNode('Checkout redesign')] },
  { name: 'replay', steps: [OPEN_SETTINGS, toggleSetting('Replay'), CLOSE_SETTINGS, SCRUB_BACK(90), ZOOM_IN] },
  { name: 'plans', view: 'plans', steps: [] },
  { name: 'memory', view: 'memory', steps: [`[...document.querySelectorAll('.library-list button')][2].click()`] },
  { name: 'monorepo', monorepo: true, steps: [ZOOM_IN] },
].map((shot) => ({ ...DEFAULTS, ...shot }))
// What has to be on screen before a view is ready to shoot.
const READY = {
  orrery: "document.querySelectorAll('.orbit-card').length > 5",
  graph: "document.querySelectorAll('.card').length > 5",
  plans: "document.querySelectorAll('.library-list li').length > 0",
  memory: "document.querySelectorAll('.library-list button').length > 2",
}

const chromePath = CHROME_CANDIDATES.find((path) => existsSync(path))
if (!chromePath) throw new Error('Google Chrome not found; set CHROME_PATH')

// Name shots to retake just those (`pnpm screenshots monorepo`); with none, it takes them all.
const only = process.argv.slice(2)
const shots = only.length > 0 ? SHOTS.filter((shot) => only.includes(shot.name)) : SHOTS
const urlOf = (shot) => `http://127.0.0.1:${shot.monorepo ? MONOREPO_PORT : DEMO_PORT}/`

const demo = spawn(process.execPath, [DEMO], { stdio: 'ignore', env: { ...process.env, AGENT_ORRERY_PORT: DEMO_PORT } })
const monorepo = spawn(process.execPath, [DEMO, '--monorepo'], { stdio: 'ignore', env: { ...process.env, AGENT_ORRERY_PORT: MONOREPO_PORT } })
const profile = mkdtempSync(join(tmpdir(), 'agent-orrery-chrome-'))
const chrome = spawn(chromePath, ['--headless=new', '--hide-scrollbars', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })

try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${DEMO_PORT}/`)).ok, 'the demo server')
  await waitFor(async () => (await fetch(`http://127.0.0.1:${MONOREPO_PORT}/`)).ok, 'the monorepo demo')
  await waitFor(async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).ok, 'Chrome')
  const page = await connect()
  await page.send('Emulation.setDeviceMetricsOverride', VIEWPORT)
  mkdirSync(OUT_DIR, { recursive: true })

  let origin = null
  for (const shot of shots) {
    // localStorage belongs to the page's origin, so load each demo once before writing to it.
    if (urlOf(shot) !== origin) {
      origin = urlOf(shot)
      await page.send('Page.navigate', { url: origin })
      await waitFor(() => page.evaluate("document.readyState === 'complete'"), 'the page')
    }
    for (const key of Object.keys(DEFAULTS)) await page.evaluate(`localStorage.setItem('agent-orrery:${key}', '${shot[key]}')`)
    await page.evaluate('window.previousShot = true')
    await page.send('Page.navigate', { url: origin })
    // The flag goes with the old page, so this can't pass on the shot before.
    await waitFor(() => page.evaluate(`!window.previousShot && ${READY[shot.view]}`), `the ${shot.view} view`)
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
  monorepo.kill()
  // Chrome keeps writing to its profile while it shuts down, so wait before deleting it.
  const chromeExited = new Promise((resolve) => chrome.once('exit', resolve))
  chrome.kill()
  await chromeExited
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
}
