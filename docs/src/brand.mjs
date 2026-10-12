// Writes the logo files in docs/assets/brand: the mark and the wordmark, light and dark,
// as SVG with the type converted to outlines, plus PNGs at 2x.
//
//   node docs/src/brand.mjs

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { launch } from './chrome.mjs'
import { loadFont } from './outline.mjs'

const DOCS = fileURLToPath(new URL('../', import.meta.url))
const OUT = `${DOCS}assets/brand/`
const NODE_FONTS = fileURLToPath(new URL('../../node_modules/@fontsource/', import.meta.url))

const serif = loadFont(`${NODE_FONTS}instrument-serif/files/instrument-serif-latin-400-normal.woff`)
const italic = loadFont(`${NODE_FONTS}inter/files/inter-latin-400-italic.woff`)

const THEMES = {
  light: { orbit: '#34955f', core: '#162925', moon: '#34955f', name: '#162925', by: '#5b6763' },
  dark: { orbit: '#4caf78', core: '#e4ebe8', moon: '#4caf78', name: '#e4ebe8', by: '#9aaaa5' },
}

// Proportions follow the app's header: name 22px, mark 26px, byline 12px, gaps 9px and 7px.
const NAME = 64
const MARK = (NAME * 26) / 22
const BY = (NAME * 12) / 22
const GAP_MARK = (NAME * 9) / 22
const GAP_BY = (NAME * 7) / 22
const PAD = NAME * 0.25
const NAME_TRACKING = '-0.02em'

// The mark on a 32-unit grid: two dashed orbits, a core, and a moon cut out of the outer orbit.
function mark(theme, id, transform = '') {
  const colours = THEMES[theme]
  return `<g${transform ? ` transform="${transform}"` : ''}>
  <mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="32"><rect width="32" height="32" fill="#fff"/><circle cx="26.25" cy="5.75" r="3.6" fill="#000"/></mask>
  <g fill="none" stroke="${colours.orbit}" stroke-width="1.5" stroke-linecap="round" mask="url(#${id})">
    <circle cx="16" cy="16" r="14.5" pathLength="40" stroke-dasharray="0.67 1.33" transform="rotate(-84 16 16)"/>
    <circle cx="16" cy="16" r="10" pathLength="28" stroke-dasharray="0.67 1.33" stroke-opacity="0.6" transform="rotate(-80 16 16)"/>
  </g>
  <circle cx="16" cy="16" r="5.25" fill="${colours.core}"/>
  <circle cx="26.25" cy="5.75" r="2.4" fill="${colours.moon}"/>
</g>`
}

// Glyph origins as the browser lays them out, so kerning and tracking match the site.
async function measure(chrome) {
  const page = `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:S;src:url(${DOCS}fonts/instrument-serif-400.woff2)}
@font-face{font-family:I;font-style:italic;src:url(${DOCS}fonts/inter-400-italic.woff2)}
body{margin:0;white-space:pre}
#name{font:400 ${NAME}px S;letter-spacing:${NAME_TRACKING}}#by{font:italic 400 ${BY}px I}
</style><span id="name">Agent Orrery</span><br><span id="by">by sejer</span>`
  const file = `${DOCS}src/build/measure.html`
  writeFileSync(file, page)
  await chrome.open(`file://${file}`, { width: 1200, height: 400 })
  return chrome.evaluate(`(() => {
    const read = (id) => {
      const span = document.getElementById(id)
      const text = span.firstChild
      const left = span.getBoundingClientRect().left
      const range = document.createRange()
      const xs = [...text.data].map((_, index) => { range.setStart(text, index); range.setEnd(text, index + 1); return range.getBoundingClientRect().left - left })
      range.selectNodeContents(span)
      return { text: text.data, xs, width: range.getBoundingClientRect().width }
    }
    return { name: read('name'), by: read('by') }
  })()`)
}

const textPath = (font, run, x, baseline, size) => [...run.text].map((char, index) => font.glyphPath(char, x + run.xs[index], baseline, size)).join('')

function logo(theme, runs) {
  const colours = THEMES[theme]
  // Drop the trailing negative tracking so the byline gap is the same as in the app.
  const nameWidth = runs.name.width
  const width = PAD + MARK + GAP_MARK + nameWidth + GAP_BY + runs.by.width + PAD
  const height = MARK + PAD * 2
  const capHeight = (serif.capHeight / serif.unitsPerEm) * NAME
  const baseline = PAD + MARK / 2 + capHeight / 2
  const nameX = PAD + MARK + GAP_MARK
  const byX = nameX + nameWidth + GAP_BY
  const scale = MARK / 32
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r(width)} ${r(height)}" width="${r(width)}" height="${r(height)}">
<title>Agent Orrery by sejer</title>
${mark(theme, `cut-${theme}`, `translate(${r(PAD)} ${r(PAD)}) scale(${r(scale)})`)}
<path fill="${colours.name}" d="${textPath(serif, runs.name, nameX, baseline, NAME)}"/>
<path fill="${colours.by}" d="${textPath(italic, runs.by, byX, baseline, BY)}"/>
</svg>
`
}

const markFile = (theme) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="256" height="256">
<title>Agent Orrery</title>
${mark(theme, `cut-${theme}`)}
</svg>
`

const r = (value) => Math.round(value * 100) / 100

const chrome = await launch({ debugPort: 9351 })
try {
  const runs = await measure(chrome)
  const files = {}
  for (const theme of Object.keys(THEMES)) {
    files[`logo-${theme}`] = logo(theme, runs)
    files[theme === 'light' ? 'mark' : 'mark-dark'] = markFile(theme)
  }
  for (const [name, svg] of Object.entries(files)) {
    writeFileSync(`${OUT}${name}.svg`, svg)
    const [, width, height] = svg.match(/width="([\d.]+)" height="([\d.]+)"/).map(Number)
    await chrome.open(`file://${OUT}${name}.svg`, { width: Math.ceil(width), height: Math.ceil(height), dpr: 2, transparent: true })
    await chrome.shoot(`${OUT}${name}@2x.png`)
    console.log(`docs/assets/brand/${name}.svg and ${name}@2x.png`)
  }
} finally {
  await chrome.close()
}
