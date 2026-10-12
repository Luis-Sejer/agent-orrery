// Turns text into SVG path data from a TrueType WOFF file, so the logo files need no fonts.
// Handles what the two brand fonts use: WOFF 1, cmap formats 4 and 12, simple and composite glyphs.
// Kerning comes from the browser (see brand.mjs), since reading GPOS is a project of its own.

import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

function tables(buffer) {
  const count = buffer.readUInt16BE(12)
  const out = {}
  for (let index = 0; index < count; index++) {
    const at = 44 + index * 20
    const tag = buffer.toString('latin1', at, at + 4)
    const offset = buffer.readUInt32BE(at + 4)
    const compressed = buffer.readUInt32BE(at + 8)
    const length = buffer.readUInt32BE(at + 12)
    const data = buffer.subarray(offset, offset + compressed)
    out[tag] = compressed < length ? inflateSync(data) : data
  }
  return out
}

function readCmap(cmap) {
  const map = new Map()
  const count = cmap.readUInt16BE(2)
  for (let index = 0; index < count; index++) {
    const offset = cmap.readUInt32BE(4 + index * 8 + 4)
    const format = cmap.readUInt16BE(offset)
    if (format === 4) {
      const segments = cmap.readUInt16BE(offset + 6) / 2
      const ends = offset + 14
      const starts = ends + segments * 2 + 2
      const deltas = starts + segments * 2
      const ranges = deltas + segments * 2
      for (let segment = 0; segment < segments; segment++) {
        const end = cmap.readUInt16BE(ends + segment * 2)
        const start = cmap.readUInt16BE(starts + segment * 2)
        const delta = cmap.readInt16BE(deltas + segment * 2)
        const rangeAt = ranges + segment * 2
        const range = cmap.readUInt16BE(rangeAt)
        for (let code = start; code <= end && code !== 0xffff; code++) {
          const glyph = range === 0 ? code + delta : cmap.readUInt16BE(rangeAt + range + (code - start) * 2)
          if (glyph) map.set(code, glyph & 0xffff)
        }
      }
    } else if (format === 12) {
      const groups = cmap.readUInt32BE(offset + 12)
      for (let group = 0; group < groups; group++) {
        const at = offset + 16 + group * 12
        const start = cmap.readUInt32BE(at)
        const end = cmap.readUInt32BE(at + 4)
        const first = cmap.readUInt32BE(at + 8)
        for (let code = start; code <= end; code++) map.set(code, first + code - start)
      }
    }
  }
  return map
}

export function loadFont(path) {
  const t = tables(readFileSync(path))
  const unitsPerEm = t.head.readUInt16BE(18)
  const longLoca = t.head.readInt16BE(50) === 1
  const glyphCount = t.maxp.readUInt16BE(4)
  const metricCount = t.hhea.readUInt16BE(34)
  const loca = (glyph) => (longLoca ? t.loca.readUInt32BE(glyph * 4) : t.loca.readUInt16BE(glyph * 2) * 2)
  const advance = (glyph) => t.hmtx.readUInt16BE(Math.min(glyph, metricCount - 1) * 4)
  const cmap = readCmap(t.cmap)
  const capHeight = t['OS/2'] && t['OS/2'].length > 90 ? t['OS/2'].readInt16BE(88) : unitsPerEm * 0.7

  // Returns contours as lists of { x, y, on } in font units.
  function contours(glyph) {
    const start = loca(glyph)
    if (glyph >= glyphCount || loca(glyph + 1) === start) return []
    const g = t.glyf.subarray(start)
    const count = g.readInt16BE(0)
    if (count < 0) return composite(g)
    const ends = Array.from({ length: count }, (_, index) => g.readUInt16BE(10 + index * 2))
    const points = ends[count - 1] + 1
    let at = 10 + count * 2
    at += 2 + g.readUInt16BE(at)
    const flags = []
    while (flags.length < points) {
      const flag = g[at++]
      flags.push(flag)
      if (flag & 8) for (let repeat = g[at++]; repeat > 0; repeat--) flags.push(flag)
    }
    const coordinates = (short, same) => {
      let value = 0
      return flags.map((flag) => {
        if (flag & short) value += flag & same ? g[at++] : -g[at++]
        else if (!(flag & same)) { value += g.readInt16BE(at); at += 2 }
        return value
      })
    }
    const xs = coordinates(2, 16)
    const ys = coordinates(4, 32)
    const out = []
    let first = 0
    for (const end of ends) {
      out.push(xs.slice(first, end + 1).map((x, index) => ({ x, y: ys[first + index], on: Boolean(flags[first + index] & 1) })))
      first = end + 1
    }
    return out
  }

  function composite(g) {
    const out = []
    let at = 10
    let flags
    do {
      flags = g.readUInt16BE(at)
      const glyph = g.readUInt16BE(at + 2)
      at += 4
      let dx, dy
      if (flags & 1) { dx = g.readInt16BE(at); dy = g.readInt16BE(at + 2); at += 4 }
      else { dx = g.readInt8(at); dy = g.readInt8(at + 1); at += 2 }
      let [a, b, c, d] = [1, 0, 0, 1]
      const f2dot14 = () => { const value = g.readInt16BE(at) / 16384; at += 2; return value }
      if (flags & 8) a = d = f2dot14()
      else if (flags & 0x40) { a = f2dot14(); d = f2dot14() }
      else if (flags & 0x80) { a = f2dot14(); b = f2dot14(); c = f2dot14(); d = f2dot14() }
      for (const contour of contours(glyph)) {
        out.push(contour.map(({ x, y, on }) => ({ x: a * x + c * y + dx, y: b * x + d * y + dy, on })))
      }
    } while (flags & 0x20)
    return out
  }

  // SVG path data for one glyph, drawn at (originX, baseline) with `size` px per em.
  function glyphPath(char, originX, baseline, size) {
    const glyph = cmap.get(char.codePointAt(0)) ?? 0
    const scale = size / unitsPerEm
    const px = (point) => `${round(originX + point.x * scale)} ${round(baseline - point.y * scale)}`
    let d = ''
    for (const contour of contours(glyph)) {
      if (!contour.length) continue
      // Start on an on-curve point; between two off-curve points the on-curve one is implied.
      let startIndex = contour.findIndex((point) => point.on)
      const startPoint = startIndex >= 0 ? contour[startIndex] : mid(contour[0], contour[1])
      if (startIndex < 0) startIndex = 0
      d += `M${px(startPoint)}`
      let control = null
      for (let step = 1; step <= contour.length; step++) {
        const point = contour[(startIndex + step) % contour.length]
        if (point.on) {
          d += control ? `Q${px(control)} ${px(point)}` : `L${px(point)}`
          control = null
        } else {
          if (control) d += `Q${px(control)} ${px(mid(control, point))}`
          control = point
        }
      }
      if (control) d += `Q${px(control)} ${px(startPoint)}`
      d += 'Z'
    }
    return d
  }

  return { unitsPerEm, capHeight, advance: (char) => advance(cmap.get(char.codePointAt(0)) ?? 0), glyphPath }
}

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true })
const round = (value) => Math.round(value * 100) / 100
