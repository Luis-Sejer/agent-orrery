import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { isTrustedWrite, withState } from './server.mjs'
import { cleanDismissals, cleanSettings, createStore, settingDefaults } from './store.mjs'

const NOW = Date.parse('2026-10-13T12:00:00Z')
const DAY = 24 * 3_600_000

test('defaults come from the environment, only with known values', () => {
  const defaults = settingDefaults({ AGENT_ORRERY_ARRANGEMENT: 'galaxy', AGENT_ORRERY_THEME: '"><script>', AGENT_ORRERY_HIDE_FINISHED: 'on', AGENT_ORRERY_VIEW: '' })
  assert.deepEqual(defaults, { arrangement: 'galaxy', 'hide-finished': 'on', 'window-hours': '6', 'waiting-hours': '24' })
  // The hour windows always have one, from the environment when it's a whole number in range.
  assert.deepEqual(settingDefaults({ AGENT_ORRERY_WINDOW_HOURS: '12', AGENT_ORRERY_WAITING_HOURS: '9000' }), { 'window-hours': '12', 'waiting-hours': '24' })
})

test('the hour windows are kept only as whole numbers in their range, and the store reads them as numbers', () => {
  assert.deepEqual(cleanSettings({ 'window-hours': '12', 'waiting-hours': '169' }), { 'window-hours': '12' })
  assert.deepEqual(cleanSettings({ 'window-hours': '0' }), {})
  assert.deepEqual(cleanSettings({ 'window-hours': '1.5' }), {})
  assert.deepEqual(cleanSettings({ 'window-hours': 12 }), {})
  const store = createStore({ dir: null, defaults: settingDefaults({}) })
  assert.equal(store.number('window-hours'), 6)
  store.changeSettings({ 'window-hours': '48' })
  assert.equal(store.number('window-hours'), 48)
})

test('only known settings with known values are kept', () => {
  assert.deepEqual(cleanSettings({ theme: 'tycho', view: 'nowhere', __proto__: { theme: 'x' }, constructor: 'on', extra: 'on' }), { theme: 'tycho' })
  assert.deepEqual(cleanSettings('theme=dark'), {})
  assert.deepEqual(cleanSettings(['dark']), {})
})

test('dismissals keep sane ids and times, and forget week-old ones', () => {
  const kept = cleanDismissals({ a: NOW, b: 'soon', c: NOW - 8 * DAY, [`x${'y'.repeat(300)}`]: NOW, d: Infinity }, NOW)
  assert.deepEqual(kept, { a: NOW })
})

test('the store saves changes to its file and starts from it next time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orrery-store-'))
  const store = createStore({ dir, defaults: { theme: 'dark' } })
  await store.changeSettings({ arrangement: 'galaxy', theme: 'nonsense' })
  await store.changeDismissals({ add: { s1: Date.now() } })
  await store.changeDismissals({ add: { s2: Date.now() } })
  const saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.deepEqual(saved.settings, { arrangement: 'galaxy' })
  assert.deepEqual(Object.keys(saved.dismissals).sort(), ['s1', 's2'])

  const again = createStore({ dir, defaults: { theme: 'dark' } })
  assert.deepEqual(again.get().settings, { arrangement: 'galaxy' })
  assert.deepEqual(again.get().defaults, { theme: 'dark' })
  await again.changeDismissals({ clear: true })
  assert.deepEqual(again.get().dismissals, {})
})

test('a damaged state file starts afresh instead of failing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orrery-store-'))
  writeFileSync(join(dir, 'state.json'), '{not json')
  assert.deepEqual(createStore({ dir }).get(), { defaults: {}, settings: {}, dismissals: {} })
})

test('writes come only from our own page, as JSON', () => {
  const ours = { host: '127.0.0.1:4777', origin: 'http://127.0.0.1:4777', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
  assert.equal(isTrustedWrite(ours), true)
  assert.equal(isTrustedWrite({ ...ours, 'content-type': 'application/json; charset=utf-8' }), true)
  // No origin: not a browser's fetch from the page (curl, or a page with no origin).
  assert.equal(isTrustedWrite({ ...ours, origin: undefined }), false)
  assert.equal(isTrustedWrite({ ...ours, origin: 'https://evil.example' }), false)
  // A form on another site can only send form or text bodies.
  assert.equal(isTrustedWrite({ ...ours, 'content-type': 'text/plain' }), false)
  assert.equal(isTrustedWrite({ ...ours, 'sec-fetch-site': 'cross-site' }), false)
  // DNS rebinding: our address under another name.
  assert.equal(isTrustedWrite({ ...ours, host: 'evil.example:4777' }), false)
})

test('the page gets its state in a meta tag, escaped', () => {
  const html = withState('<html><head><title>x</title></head></html>', { defaults: {}, settings: { theme: 'dark' }, dismissals: { '"><script>': 1 } })
  assert.match(html, /<head><meta name="agent-orrery-state" content="\{&quot;defaults&quot;:\{\},&quot;settings&quot;:\{&quot;theme&quot;:&quot;dark&quot;\}/)
  assert.doesNotMatch(html, /<script>/)
})

test("the plan's usage comes from the status line bridge's file, and only its windows", async () => {
  const { parseUsage } = await import('./server.mjs')
  const at = 1_791_898_557.5
  const usage = parseUsage(JSON.stringify({ at, five_hour: { used_percentage: 65.4, resets_at: 1_791_900_000 }, seven_day: { used_percentage: 140, resets_at: '2026-10-18T09:00:00Z' }, spend: 12 }))
  assert.deepEqual(usage, {
    at: at * 1000,
    fiveHour: { percent: 65.4, resetsAt: 1_791_900_000_000 },
    sevenDay: { percent: 100, resetsAt: Date.parse('2026-10-18T09:00:00Z') },
  })
  assert.equal(parseUsage(JSON.stringify({ at, five_hour: null })), null)
  assert.equal(parseUsage('{broken'), null)
  assert.equal(parseUsage(''), null)
})

test('the session forecast follows the pace of the last hour, and says when the limit comes first', async () => {
  const { forecast } = await import('./server.mjs')
  const MINUTE = 60_000
  const now = Date.parse('2026-10-13T15:00:00Z')
  const resetsAt = now + 2 * 60 * MINUTE
  // 2 % every 5 minutes, at 60 % now: 24 % an hour, so 100 % in 100 minutes, before the reset.
  const samples = [0, 5, 10, 15, 20].map((back, index) => ({ at: now - back * MINUTE, percent: 60 - index * 2, resetsAt })).reverse()
  const ahead = forecast(samples, { percent: 60, resetsAt }, now)
  assert.equal(Math.round(ahead.perHour), 24)
  assert.equal(ahead.atReset, 100)
  assert.equal(ahead.limitAt, now + 100 * MINUTE)
  // Slower: the limit is after the reset, so there is none, just where it will be.
  const slow = samples.map((sample, index) => ({ ...sample, percent: 52 + index }))
  const calm = forecast(slow, { percent: 56, resetsAt }, now)
  assert.equal(calm.limitAt, null)
  assert.equal(Math.round(calm.atReset), 80)
  // Too little to go on, or readings from the last window: no forecast.
  assert.equal(forecast(samples.slice(-2), { percent: 60, resetsAt }, now), null)
  assert.equal(forecast(samples, { percent: 60, resetsAt: resetsAt + 5 * 60 * MINUTE }, now), null)
})

test('dismissals can be removed one at a time', () => {
  const store = createStore({})
  const now = Date.now()
  store.changeDismissals({ add: { s1: now, s2: now } }, now)
  store.changeDismissals({ remove: ['s1'] }, now)
  assert.deepEqual(Object.keys(store.get().dismissals), ['s2'])
})
