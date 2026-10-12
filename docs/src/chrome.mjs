// A headless Chrome driven over the DevTools protocol, shared by the render scripts.
// Uses its own throwaway profile, so it never touches your browser.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).find((path) => existsSync(path))

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function waitFor(check, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return
    await sleep(200)
  }
  throw new Error(`Timed out waiting for ${what}`)
}

export async function launch({ debugPort = 9350 } = {}) {
  if (!CHROME) throw new Error('Google Chrome not found; set CHROME_PATH')
  const profile = mkdtempSync(join(tmpdir(), 'agent-orrery-brand-'))
  const chrome = spawn(
    CHROME,
    ['--headless=new', '--hide-scrollbars', '--font-render-hinting=none', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'],
    { stdio: 'ignore' },
  )
  await waitFor(async () => (await fetch(`http://127.0.0.1:${debugPort}/json`)).ok, 'Chrome')
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()
  const socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve) => socket.addEventListener('open', resolve))

  let id = 0
  const pending = new Map()
  const listeners = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id) {
      const done = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) done?.reject(new Error(`${message.error.message}`))
      else done?.resolve(message.result)
    } else listeners.get(message.method)?.(message.params)
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    return result.value
  }
  const on = (method, handler) => listeners.set(method, handler)

  async function open(url, { width, height, dpr = 1, transparent = false }) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile: false })
    await send('Emulation.setDefaultBackgroundColorOverride', transparent ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {})
    await send('Page.enable')
    const loaded = new Promise((resolve) => on('Page.loadEventFired', resolve))
    await send('Page.navigate', { url })
    await loaded
    await evaluate('document.fonts.ready.then(() => true)')
  }

  async function shoot(path, { format = 'png', quality, clip } = {}) {
    const params = { format, captureBeyondViewport: false }
    if (quality) params.quality = quality
    if (clip) params.clip = { ...clip, scale: 1 }
    const { data } = await send('Page.captureScreenshot', params)
    writeFileSync(path, Buffer.from(data, 'base64'))
  }

  async function close() {
    socket.close()
    const exited = new Promise((resolve) => chrome.once('exit', resolve))
    chrome.kill()
    await exited
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
  }

  return { send, evaluate, on, open, shoot, close }
}

// Headless Chrome draws no mouse pointer, so the recordings add this one. It glides to each point
// while the real mouse event lands at once.
export const addCursor = (chrome, { x, y }) => chrome.evaluate(`(() => {
  const cursor = document.createElement('div')
  cursor.id = 'rec-cursor'
  cursor.innerHTML = '<svg width="26" height="34" viewBox="0 0 26 34"><path d="M3 2 L3 26 L9 20.5 L13 30 L17 28.3 L13.2 19 L21.5 19 Z" fill="#162925" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>'
  Object.assign(cursor.style, { position: 'fixed', left: '0', top: '0', zIndex: 2147483647, pointerEvents: 'none',
    transform: 'translate(${x}px, ${y}px)', transition: 'transform 0.8s cubic-bezier(0.45, 0, 0.2, 1)', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.25))' })
  document.body.appendChild(cursor)
  return true
})()`)

// Points at things on the page: the centre of the first element that matches and contains the text.
export function pointer(chrome) {
  const centre = (selector, match = '') => chrome.evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.textContent.includes(${JSON.stringify(match)}))
    const box = el.getBoundingClientRect()
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
  })()`)
  const moveTo = async ({ x, y }) => {
    await chrome.evaluate(`document.getElementById('rec-cursor').style.transform = 'translate(${x - 3}px, ${y - 2}px)'`)
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  }
  const click = async ({ x, y }) => {
    await chrome.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await chrome.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }
  return { centre, moveTo, click }
}

// Starts a screencast. Frames arrive when the page changes, so each keeps its timestamp; stop()
// saves them to the folder as numbered JPEGs with frames.json, the times in seconds from the first,
// which render.sh's encode() plays back. It returns the first frame's timestamp.
export async function screencast(chrome) {
  const frames = []
  chrome.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    frames.push({ data, time: metadata.timestamp })
    chrome.send('Page.screencastFrameAck', { sessionId })
  })
  await chrome.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 2880, maxHeight: 1800, everyNthFrame: 1 })
  return async (out) => {
    await chrome.send('Page.stopScreencast')
    const first = frames[0].time
    const list = frames.map((frame, index) => {
      const name = `${String(index).padStart(5, '0')}.jpg`
      writeFileSync(`${out}${name}`, Buffer.from(frame.data, 'base64'))
      return { name, time: frame.time - first }
    })
    writeFileSync(`${out}frames.json`, JSON.stringify(list))
    console.log(`recorded ${list.length} frames over ${list.at(-1).time.toFixed(1)} s into ${out}`)
    return first
  }
}
