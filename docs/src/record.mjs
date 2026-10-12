// Records the real app running on the demo data, for the animated hero and the launch video.
// Starts its own demo (made-up sessions only), drives headless Chrome through a short story,
// and saves the screencast frames with their timestamps to build/rec/. render.sh turns them into media.
// With --dark it records the hero loop in the dark theme instead, into build/rec-dark/.
//
//   pnpm build && node docs/src/record.mjs [--dark]

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { launch, sleep, waitFor } from './chrome.mjs'

const PORT = '4785'
const URL_ = `http://127.0.0.1:${PORT}/`
const VIEWPORT = { width: 1440, height: 900, dpr: 2 }
const DARK = process.argv.includes('--dark')
const OUT = fileURLToPath(new URL(DARK ? './build/rec-dark/' : './build/rec/', import.meta.url))
const HERO_SECONDS = 13.4
const DEMO = fileURLToPath(new URL('../../scripts/demo.mjs', import.meta.url))
// The demo's flaky-test session starts waiting on you 30 s after the demo starts. Starting the
// recording 13 s in puts that moment near the end, after the switch to the dark theme.
const START_AFTER_DEMO_MS = 13_000

// Watches the page for the moments the launch video's sound follows: a session joining Your turn
// (the tab title's count goes up) and a message starting to travel along a line.
const WATCH = `(() => {
  window.recEvents = []
  const now = () => Date.now() / 1000
  const waiting = () => Number(document.title.match(/\\((\\d+)\\)/)?.[1] ?? 0)
  let count = waiting()
  new MutationObserver(() => {
    if (waiting() > count) recEvents.push({ type: 'waiting', time: now() })
    count = waiting()
  }).observe(document.querySelector('title'), { childList: true, characterData: true, subtree: true })
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node.nodeType === 1 && (node.matches('.message-pulse') || node.querySelector('.message-pulse'))) recEvents.push({ type: 'message', time: now() })
    }
  }).observe(document.body, { childList: true, subtree: true })
  return true
})()`

const CURSOR = `(() => {
  const cursor = document.createElement('div')
  cursor.id = 'rec-cursor'
  cursor.innerHTML = '<svg width="26" height="34" viewBox="0 0 26 34"><path d="M3 2 L3 26 L9 20.5 L13 30 L17 28.3 L13.2 19 L21.5 19 Z" fill="#162925" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>'
  Object.assign(cursor.style, { position: 'fixed', left: '0', top: '0', zIndex: 2147483647, pointerEvents: 'none',
    transform: 'translate(1180px, 760px)', transition: 'transform 0.8s cubic-bezier(0.45, 0, 0.2, 1)', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.25))' })
  document.body.appendChild(cursor)
  return true
})()`

const demo = spawn(process.execPath, [DEMO], { stdio: 'ignore', env: { ...process.env, AGENT_ORRERY_PORT: PORT } })
const demoStarted = Date.now()
const chrome = await launch({ debugPort: 9353 })

try {
  await waitFor(async () => (await fetch(URL_)).ok, 'the demo server')
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  // Start in the light theme explicitly, so one click on the theme button turns it dark.
  if (DARK) await chrome.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await chrome.open('about:blank', VIEWPORT)
  await chrome.open(URL_, VIEWPORT)
  await chrome.evaluate(`localStorage.setItem('agent-orrery:theme', '${DARK ? 'dark' : 'light'}'), true`)
  await chrome.open(URL_, VIEWPORT)
  await waitFor(async () => (await chrome.evaluate("document.querySelectorAll('.card').length")) > 5, 'the graph')
  await chrome.evaluate(CURSOR)
  await chrome.evaluate(WATCH)
  await sleep(Math.max(0, START_AFTER_DEMO_MS - (Date.now() - demoStarted)))

  const frames = []
  const events = []
  const mark = (type) => events.push({ type, time: Date.now() / 1000 })
  chrome.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    frames.push({ data, time: metadata.timestamp })
    chrome.send('Page.screencastFrameAck', { sessionId })
  })
  await chrome.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 2880, maxHeight: 1800, everyNthFrame: 1 })
  const began = Date.now()
  const at = async (seconds) => sleep(Math.max(0, began + seconds * 1000 - Date.now()))

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
  const key = (key, code, keyCode, modifiers = 0) =>
    Promise.all(['keyDown', 'keyUp'].map((type) => chrome.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, modifiers })))

  // The story. Times are seconds into the recording.
  await at(1.6)
  const session = await centre('.react-flow__node', 'Checkout redesign')
  await moveTo(session)
  await at(2.6)
  mark('select')
  await click(session) // Focus: its subagents and messages light up, the drawer opens.

  await at(6.4)
  const close = await centre('.drawer .close')
  await moveTo(close)
  await at(7.3)
  mark('click')
  await click(close)

  await at(7.9)
  await moveTo(await centre('.search-button'))
  await at(8.8)
  mark('key')
  await key('k', 'KeyK', 75, 4) // ⌘K
  await at(9.3)
  for (const letter of 'checkout') {
    mark('type')
    await chrome.send('Input.insertText', { text: letter })
    await sleep(110)
  }
  await at(12.2)
  // The first Escape clears the query, the second closes the palette.
  mark('escape')
  await key('Escape', 'Escape', 27)
  await at(12.4)
  mark('escape')
  await key('Escape', 'Escape', 27)
  await at(12.5)
  await moveTo({ x: 1180, y: 760 })

  // The hero loop ends here, back on the overview. The video carries on into the dark theme,
  // where the flaky-test session finishes and slides into Your turn.
  await at(HERO_SECONDS)
  if (!DARK) await darkAndWait()

  async function darkAndWait() {
    const theme = await centre('.toolbar .icon-button[aria-label^="Theme"]')
    await moveTo(theme)
    await at(14.3)
    mark('click')
    await click(theme)
    await sleep(150)
    // Dark, or the click missed: then press the button directly so the story still holds.
    if ((await chrome.evaluate('document.documentElement.dataset.theme')) !== 'dark') {
      console.warn('theme click missed; pressing the button directly')
      await chrome.evaluate(`document.querySelector('.toolbar .icon-button[aria-label^="Theme"]').click(), true`)
    }
    await at(15.2)
    await moveTo({ x: 1180, y: 760 })
    await at(21)
  }

  await chrome.send('Page.stopScreencast')
  const first = frames[0].time
  const list = frames.map((frame, index) => {
    const name = `${String(index).padStart(5, '0')}.jpg`
    writeFileSync(`${OUT}${name}`, Buffer.from(frame.data, 'base64'))
    return { name, time: frame.time - first }
  })
  writeFileSync(`${OUT}frames.json`, JSON.stringify(list))
  const timeline = [...events, ...(await chrome.evaluate('recEvents'))]
    .map(({ type, time }) => ({ type, time: Math.round((time - first) * 1000) / 1000 }))
    .sort((a, b) => a.time - b.time)
  writeFileSync(`${OUT}events.json`, JSON.stringify(timeline, null, 1))
  console.log(`recorded ${list.length} frames over ${list.at(-1).time.toFixed(1)} s into ${OUT}`)
} finally {
  await chrome.close()
  demo.kill()
}
