// Records the real app running on the demo data, on the Agents grid, for the launch video.
// Starts its own demo (made-up sessions only), drives headless Chrome through a short story,
// and saves the screencast frames with their timestamps to build/rec/. render.sh turns them into media.
// The animated hero on the site is recorded by hero.mjs, on the Orrery.
//
//   pnpm build && node docs/src/record.mjs

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { addCursor, launch, pointer, screencast, sleep, waitFor } from './chrome.mjs'

const PORT = '4785'
const URL_ = `http://127.0.0.1:${PORT}/`
const VIEWPORT = { width: 1440, height: 900, dpr: 2 }
const OUT = fileURLToPath(new URL('./build/rec/', import.meta.url))
const OVERVIEW_AGAIN_SECONDS = 13.4
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

const demo = spawn(process.execPath, [DEMO], { stdio: 'ignore', env: { ...process.env, AGENT_ORRERY_PORT: PORT } })
const demoStarted = Date.now()
const chrome = await launch({ debugPort: 9353 })

try {
  await waitFor(async () => (await fetch(URL_)).ok, 'the demo server')
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  // Start in the light theme explicitly, so one click on the theme button turns it dark.
  await chrome.open('about:blank', VIEWPORT)
  await chrome.open(URL_, VIEWPORT)
  // The page now opens on the Orrery; the video was made on the Agents grid, so pin it there.
  await chrome.evaluate(`localStorage.setItem('agent-orrery:theme', 'light'), localStorage.setItem('agent-orrery:view', 'graph'), true`)
  await chrome.open(URL_, VIEWPORT)
  await waitFor(async () => (await chrome.evaluate("document.querySelectorAll('.card').length")) > 5, 'the graph')
  await addCursor(chrome, { x: 1180, y: 760 })
  await chrome.evaluate(WATCH)
  await sleep(Math.max(0, START_AFTER_DEMO_MS - (Date.now() - demoStarted)))

  const events = []
  const mark = (type) => events.push({ type, time: Date.now() / 1000 })
  const stopRecording = await screencast(chrome)
  const began = Date.now()
  const at = async (seconds) => sleep(Math.max(0, began + seconds * 1000 - Date.now()))

  const { centre, moveTo, click } = pointer(chrome)
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

  // Back on the overview. The video carries on into the dark theme, where the flaky-test
  // session finishes and slides into Your turn.
  await at(OVERVIEW_AGAIN_SECONDS)
  await darkAndWait()

  // The theme lives in the settings menu: open it, choose Dark, close it.
  async function darkAndWait() {
    const DARK_BUTTON = `[...document.querySelectorAll('#settings button')].find((button) => button.textContent === 'Dark')`
    const settings = await centre('.settings-button')
    await moveTo(settings)
    await at(14.2)
    mark('click')
    await click(settings)
    await sleep(150)
    const dark = await chrome.evaluate(`(() => { const box = ${DARK_BUTTON}.getBoundingClientRect(); return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) } })()`)
    await moveTo(dark)
    await at(15.0)
    mark('click')
    await click(dark)
    await sleep(150)
    // Dark, or a click missed: then press the button directly so the story still holds.
    if ((await chrome.evaluate('document.documentElement.dataset.theme')) !== 'dark') {
      console.warn('theme click missed; pressing the button directly')
      await chrome.evaluate(`${DARK_BUTTON}.click(), true`)
    }
    await at(15.5)
    await key('Escape', 'Escape', 27)
    await moveTo({ x: 1180, y: 760 })
    await at(21)
  }

  const first = await stopRecording(OUT)
  const timeline = [...events, ...(await chrome.evaluate('recEvents'))]
    .map(({ type, time }) => ({ type, time: Math.round((time - first) * 1000) / 1000 }))
    .sort((a, b) => a.time - b.time)
  writeFileSync(`${OUT}events.json`, JSON.stringify(timeline, null, 1))
} finally {
  await chrome.close()
  demo.kill()
}
