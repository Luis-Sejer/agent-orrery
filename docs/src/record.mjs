// Records the real app running on the demo data, on the Orrery, for the launch video.
// Starts its own demo (made-up sessions only), drives headless Chrome through a short story,
// and saves the screencast frames with their timestamps to build/rec/, plus build/rec/events.json,
// the moments audio.mjs puts sounds on. render.sh turns them into media.
//
//   pnpm build && node docs/src/record.mjs

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { addCursor, launch, pointer, screencast, sleep, waitFor } from './chrome.mjs'

const PORT = '4787'
const URL_ = `http://127.0.0.1:${PORT}/`
const VIEWPORT = { width: 1440, height: 900, dpr: 2 }
const OUT = fileURLToPath(new URL('./build/rec/', import.meta.url))
const DEMO = fileURLToPath(new URL('../../scripts/demo.mjs', import.meta.url))
// The demo's flaky-test session starts waiting on you 30 s after the demo starts. Starting the
// recording 12.8 s in puts that moment near the end, after the switch to T.Y.C.H.O.
const START_AFTER_DEMO_MS = 12_800
const SECONDS = 20.6
// The cursor rests just off screen, so the opening and the closing hold have none.
const OFF_SCREEN = { x: 1500, y: 960 }
const SESSION = 'Checkout redesign'

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
const chrome = await launch({ debugPort: 9356 })

try {
  await waitFor(async () => (await fetch(URL_)).ok, 'the demo server')
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  // Start light, by status, with the side panel shown, whatever the defaults become.
  await chrome.open(URL_, VIEWPORT)
  await chrome.evaluate(`fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: 'light', view: 'orrery', arrangement: 'status', clean: 'off' }) }).then((response) => response.ok)`)
  await chrome.open(URL_, VIEWPORT)
  await waitFor(async () => (await chrome.evaluate("document.querySelectorAll('.orbit-card').length")) > 5, 'the orrery')
  await addCursor(chrome, OFF_SCREEN)
  await chrome.evaluate(WATCH)
  await sleep(Math.max(1_000, START_AFTER_DEMO_MS - (Date.now() - demoStarted)))

  const events = []
  const mark = (type) => events.push({ type, time: Date.now() / 1000 })
  const stopRecording = await screencast(chrome)
  const began = Date.now()
  const at = async (seconds) => sleep(Math.max(0, began + seconds * 1000 - Date.now()))

  const { centre, moveTo, click } = pointer(chrome)
  const escape = () => Promise.all(['keyDown', 'keyUp'].map((type) => chrome.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })))
  // The session's orb, which the label hangs under. It moves until the cursor is on it.
  const orb = () => chrome.evaluate(`(() => {
    const box = [...document.querySelectorAll('.orbit-card')].find((node) => node.textContent.includes(${JSON.stringify(SESSION)})).querySelector('.orb').getBoundingClientRect()
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
  })()`)
  // A choice in the settings menu, such as "By repository" or "T.Y.C.H.O.".
  const choice = (label) => centre('#settings button', label)
  const choose = async (label, type, seconds) => {
    await moveTo(await choice(label))
    await at(seconds)
    mark(type)
    await click(await choice(label))
    await sleep(150)
  }
  const openSettings = async (seconds) => {
    await moveTo(await centre('.settings-button'))
    await at(seconds)
    mark('click')
    await click(await centre('.settings-button'))
    await sleep(150)
  }
  const closeSettings = async () => {
    mark('escape')
    await escape()
    // Closing returns focus to the settings button; its focus ring isn't part of the story.
    await chrome.evaluate('document.activeElement?.blur(), true')
    await moveTo(OFF_SCREEN)
  }

  // The story. Times are seconds into the recording.
  // 1. The Orrery turning, three sessions waiting on you. Then one session in focus: its lines
  //    light up and the drawer shows what it cost.
  await at(2.0)
  await moveTo(await orb()) // Pointing steadies the rings.
  await at(2.8)
  await moveTo(await orb())
  await at(3.3)
  mark('select')
  await click(await orb())

  await at(6.6)
  await moveTo(await centre('.drawer .close'))
  await at(7.4)
  mark('click')
  await click(await centre('.drawer .close'))

  // 2. One ring per repository, with the menu closed so the whole orrery shows.
  await at(7.7)
  await openSettings(8.5)
  await choose('By repository', 'arrange', 9.4)
  await at(10.0)
  await closeSettings()

  // 3. Back to the rings by status, then T.Y.C.H.O.
  await at(11.9)
  await openSettings(12.7)
  await choose('By status', 'arrange', 13.6)
  await choose('T.Y.C.H.O.', 'theme', 14.6)
  // T.Y.C.H.O., or a click missed: then press the button directly so the story still holds.
  if (!(await chrome.evaluate('document.documentElement.hasAttribute("data-hud")'))) {
    console.warn('theme click missed; pressing the button directly')
    await chrome.evaluate(`[...document.querySelectorAll('#settings button')].find((button) => button.textContent === 'T.Y.C.H.O.').click(), true`)
  }
  await at(15.3)
  await closeSettings()

  // 4. The flaky-test session finishes and joins Your turn; the core's count goes up.
  await at(SECONDS)
  const first = await stopRecording(OUT)
  const timeline = [...events, ...(await chrome.evaluate('recEvents'))]
    .map(({ type, time }) => ({ type, time: Math.round((time - first) * 1000) / 1000 }))
    .sort((a, b) => a.time - b.time)
  writeFileSync(`${OUT}events.json`, JSON.stringify(timeline, null, 1))
} finally {
  await chrome.close()
  demo.kill()
}
