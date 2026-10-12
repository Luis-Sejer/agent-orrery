// Renders the launch video's opening and closing cards as frames, with the orrery turning.
//
//   node docs/src/cards.mjs

import { mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { launch } from './chrome.mjs'

const SRC = fileURLToPath(new URL('./', import.meta.url))
const FPS = 30
const CARDS = [
  { name: 'title', query: '', seconds: Number(process.env.TITLE_SECONDS ?? 2.6), from: 4 },
  { name: 'end', query: 'card=end&', seconds: Number(process.env.END_SECONDS ?? 3.6), from: 12 },
]

const chrome = await launch({ debugPort: 9354 })
try {
  for (const card of CARDS) {
    const dir = `${SRC}build/cards/${card.name}/`
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const frames = Math.round(card.seconds * FPS)
    for (let frame = 0; frame < frames; frame++) {
      const t = (card.from + frame / FPS).toFixed(4)
      await chrome.open(`file://${SRC}banner.html?${card.query}t=${t}`, { width: 1440, height: 900 })
      await chrome.shoot(`${dir}${String(frame).padStart(4, '0')}.png`)
    }
    console.log(`rendered ${frames} frames of the ${card.name} card`)
  }
} finally {
  await chrome.close()
}
