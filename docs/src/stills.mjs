// Renders the still artwork from the HTML sources in this folder: the app icon and the social images.
//
//   node docs/src/stills.mjs

import { fileURLToPath } from 'node:url'

import { launch } from './chrome.mjs'

const SRC = fileURLToPath(new URL('./', import.meta.url))
const ASSETS = fileURLToPath(new URL('../assets/', import.meta.url))

const STILLS = [
  { page: 'icon.html', out: 'icon.png', width: 1024, height: 1024, transparent: true },
  { page: 'banner.html', out: 'social/banner.png', width: 1280, height: 640 },
  { page: 'banner.html', out: 'social/og.png', width: 1200, height: 630 },
]

const chrome = await launch({ debugPort: 9352 })
try {
  for (const still of STILLS) {
    await chrome.open(`file://${SRC}${still.page}`, still)
    await chrome.shoot(`${ASSETS}${still.out}`)
    console.log(`docs/assets/${still.out}`)
  }
} finally {
  await chrome.close()
}
