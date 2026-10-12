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
