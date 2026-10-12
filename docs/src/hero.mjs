// Records the animated hero: the Orrery turning on the demo data, with sessions waiting on you
// (the red core and its count). The cursor comes in, opens one session so its drawer opens and its
// lines light up, closes it again and leaves, so the end is close to the start; render.sh crossfades
// the last moment into the first to make the loop seamless.
// Saves the screencast frames to build/hero/, or build/hero-dark/ with --dark.
//
//   pnpm build && node docs/src/hero.mjs [--dark]

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { addCursor, launch, pointer, screencast, sleep, waitFor } from './chrome.mjs'

const PORT = '4786'
const URL_ = `http://127.0.0.1:${PORT}/`
const VIEWPORT = { width: 1440, height: 900, dpr: 2 }
const DARK = process.argv.includes('--dark')
const OUT = fileURLToPath(new URL(DARK ? './build/hero-dark/' : './build/hero/', import.meta.url))
const DEMO = fileURLToPath(new URL('../../scripts/demo.mjs', import.meta.url))
// The demo's flaky-test session starts waiting on you 30 s after the demo starts, which would change
// the count mid-loop. Starting 6 s in ends the recording well before that.
const START_AFTER_DEMO_MS = 6_000
const SECONDS = 12.6
// The cursor rests just off screen, so the first and last frames have none.
const OFF_SCREEN = { x: 1500, y: 960 }
const SESSION = 'Checkout redesign'

const demo = spawn(process.execPath, [DEMO], { stdio: 'ignore', env: { ...process.env, AGENT_ORRERY_PORT: PORT } })
const demoStarted = Date.now()
const chrome = await launch({ debugPort: 9355 })

try {
  await waitFor(async () => (await fetch(URL_)).ok, 'the demo server')
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  await chrome.open(URL_, VIEWPORT)
  await chrome.evaluate(`localStorage.setItem('agent-orrery:theme', '${DARK ? 'dark' : 'light'}'), localStorage.setItem('agent-orrery:view', 'orrery'), localStorage.setItem('agent-orrery:arrangement', 'status'), localStorage.setItem('agent-orrery:clean', 'off'), true`)
  await chrome.open(URL_, VIEWPORT)
  await waitFor(async () => (await chrome.evaluate("document.querySelectorAll('.orbit-card').length")) > 5, 'the orrery')
  await sleep(1_000)
  // The fit leaves the orbs small at this width; one step in keeps every ring in frame, as in the screenshots.
  await chrome.evaluate(`document.querySelector('.react-flow__controls-zoomin').click(), true`)
  await addCursor(chrome, OFF_SCREEN)
  await sleep(Math.max(1_000, START_AFTER_DEMO_MS - (Date.now() - demoStarted)))

  const stopRecording = await screencast(chrome)
  const began = Date.now()
  const at = async (seconds) => sleep(Math.max(0, began + seconds * 1000 - Date.now()))
  const { centre, moveTo, click } = pointer(chrome)
  // The session's orb, which the label hangs under.
  const orb = () => chrome.evaluate(`(() => {
    const box = [...document.querySelectorAll('.orbit-card')].find((node) => node.textContent.includes(${JSON.stringify(SESSION)})).querySelector('.orb').getBoundingClientRect()
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
  })()`)

  // The story. Times are seconds into the recording.
  await at(3.0)
  await moveTo(await orb()) // Pointing steadies the rings.
  await at(4.0)
  await moveTo(await orb())
  await at(4.5)
  await click(await orb()) // Its subagents and messages light up, the drawer opens.

  await at(8.4)
  await moveTo(await centre('.drawer .close'))
  await at(9.3)
  await click(await centre('.drawer .close'))
  await at(9.7)
  await moveTo(OFF_SCREEN)

  await at(SECONDS)
  await stopRecording(OUT)
} finally {
  await chrome.close()
  demo.kill()
}
