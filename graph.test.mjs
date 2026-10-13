import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { applyLines, createGraph, day, ensureNode, forget, joinSpans, replay, setLive, shellActivity, snapshot, timeline, waitingSessions } from './graph.mjs'
import { createLibrary, snippetAround } from './library.mjs'
import { createRepoResolver, pathsInToolInput } from './repos.mjs'
import { isTrustedRequest } from './server.mjs'

const line = (record) => `${JSON.stringify(record)}\n`
const at = (second) => `2026-10-12T12:00:${String(second).padStart(2, '0')}Z`
const resolveRepo = (path) => path.match(/^\/code\/([^/]+)/)?.[1] ?? null
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input })

function sessionWithSubagent() {
  const graph = createGraph({ resolveRepo, plansDir: '/home/.claude/plans' })
  ensureNode(graph, 'session-1', { kind: 'session', label: 'session-1', sessionId: 'session-1' })
  ensureNode(graph, 'agent-a', { kind: 'subagent', label: 'Translate', spawnToolUseId: 'spawn-1', sessionId: 'session-1' })
  applyLines(
    graph,
    'session-1',
    line({ type: 'ai-title', aiTitle: 'Checkout redesign' }) +
      line({
        type: 'assistant',
        timestamp: at(1),
        cwd: '/code/storefront-api',
        message: { stop_reason: 'tool_use', content: [toolUse('spawn-1', 'Agent', { description: 'Translate', prompt: 'SECRET' })] },
      }) +
      line({
        type: 'assistant',
        timestamp: at(2),
        cwd: '/code/storefront-api',
        message: { stop_reason: 'tool_use', content: [toolUse('w', 'Write', { file_path: '/home/.claude/plans/checkout.md', content: 'SECRET' })] },
      }) +
      line({
        type: 'assistant',
        timestamp: at(2),
        cwd: '/code/storefront-api',
        message: { stop_reason: 'tool_use', content: [toolUse('r', 'Read', { file_path: '/home/.claude/plans/other.md' })] },
      }) +
      'not json\n' +
      line({ type: 'user', timestamp: at(5), origin: { kind: 'peer', from: 'agent-a', name: 'general-purpose', body: 'SECRET' } }) +
      line({ type: 'assistant', timestamp: at(6), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'SECRET' }] } }),
  )
  // The subagent runs from the session's folder but edits another repo.
  applyLines(
    graph,
    'agent-a',
    line({
      type: 'assistant',
      timestamp: at(3),
      cwd: '/code/storefront-api',
      message: { stop_reason: 'tool_use', content: [toolUse('e', 'Edit', { file_path: '/code/storefront-web/src/en-GB.json', new_string: 'SECRET' })] },
    }),
  )
  return graph
}

test('places agents in the repo they work in, links spawns, messages and plans, keeps no content', () => {
  const graph = sessionWithSubagent()
  const view = snapshot(graph, 0)
  const session = view.nodes.find((node) => node.id === 'session-1')
  const agent = view.nodes.find((node) => node.id === 'agent-a')

  assert.equal(session.label, 'Checkout redesign')
  assert.equal(session.room, 'storefront-api')
  assert.deepEqual(session.plans, ['checkout.md'])
  assert.deepEqual(session.waiting, { reason: 'reply', since: Date.parse(at(6)) })
  assert.equal(agent.room, 'storefront-web')
  assert.equal(agent.parentId, 'session-1')
  assert.equal(agent.activity, 'composing')
  assert.deepEqual(view.messages, [{ from: 'agent-a', to: 'session-1', count: 1, lastAt: Date.parse(at(5)), firstAt: Date.parse(at(5)) }])
  assert.deepEqual(
    timeline(graph, 'agent-a').map((event) => [event.text, event.repo]),
    [['Edited en-GB.json', 'storefront-web']],
  )
  assert.ok(!JSON.stringify(view).includes('SECRET'))
  assert.ok(!JSON.stringify(timeline(graph, 'session-1')).includes('SECRET'))
})

test('a session waiting on you outlives the normal window; finished agents do not', () => {
  const graph = sessionWithSubagent()
  const afterWindow = Date.parse(at(59))
  const view = snapshot(graph, afterWindow, 0)
  assert.deepEqual(view.nodes.map((node) => node.id), ['session-1'])
  assert.equal(snapshot(graph, afterWindow, afterWindow).nodes.length, 0)
})

test('compacting an idle session keeps it waiting on you and not busy', () => {
  const graph = createGraph()
  ensureNode(graph, 's', { kind: 'session', label: 's', sessionId: 's' })
  applyLines(
    graph,
    's',
    line({ type: 'assistant', timestamp: at(1), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '…' }] } }) +
      line({ type: 'system', subtype: 'turn_duration', timestamp: at(2) }) +
      line({ type: 'system', subtype: 'compact_boundary', timestamp: at(50) }) +
      line({ type: 'user', isCompactSummary: true, timestamp: at(50), message: { content: 'summary' } }) +
      line({ type: 'attachment', timestamp: at(50), attachment: { type: 'file' } }),
  )
  const node = graph.nodes.get('s')
  assert.deepEqual(node.waiting, { reason: 'reply', since: Date.parse(at(1)) })
  assert.equal(node.lastAt, Date.parse(at(1)))
})

test('a pending question waits until the user answers', () => {
  const graph = createGraph()
  ensureNode(graph, 's', { kind: 'session', label: 's', sessionId: 's' })
  const question = toolUse('q', 'AskUserQuestion', {})
  applyLines(graph, 's', line({ type: 'assistant', timestamp: at(1), message: { stop_reason: 'tool_use', content: [question] } }))
  assert.equal(graph.nodes.get('s').waiting.reason, 'question')
  applyLines(graph, 's', line({ type: 'user', timestamp: at(9), isMeta: true }))
  assert.equal(graph.nodes.get('s').waiting.reason, 'question')
  applyLines(graph, 's', line({ type: 'user', timestamp: at(10), message: { content: [{ type: 'tool_result' }] } }))
  assert.equal(graph.nodes.get('s').waiting, null)
})

test('finds paths in tool inputs and maps worktrees to their repo', () => {
  assert.deepEqual(pathsInToolInput({ file_path: 'src/a.ts' }, '/code/storefront-api', '/home'), ['/code/storefront-api/src/a.ts'])
  assert.deepEqual(pathsInToolInput({ command: 'cd ~/code/storefront-web && ls /code/design-system' }, null, '/home'), ['/home/code/storefront-web', '/code/design-system'])

  const root = mkdtempSync(join(tmpdir(), 'agent-orrery-'))
  mkdirSync(join(root, 'storefront-web', '.git'), { recursive: true })
  mkdirSync(join(root, 'storefront-web', '.claude', 'worktrees', 'feat-x', 'src'), { recursive: true })
  // A real worktree has a .git file at its root; its rooms carry its branch, which the page folds away.
  writeFileSync(join(root, 'storefront-web', '.claude', 'worktrees', 'feat-x', '.git'), 'gitdir: …')
  const resolve = createRepoResolver(root)
  assert.equal(resolve(join(root, 'storefront-web', '.claude', 'worktrees', 'feat-x', 'src', 'a.ts')), 'storefront-web ⎇ feat-x')
  assert.equal(resolve(join(root, 'elsewhere', 'b.ts')), null)
})

test('the library only reads files it listed itself', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'agent-orrery-claude-'))
  mkdirSync(join(claudeDir, 'plans'))
  mkdirSync(join(claudeDir, 'projects', 'p', 'memory'), { recursive: true })
  writeFileSync(join(claudeDir, 'plans', 'checkout.md'), '# Checkout plan\n')
  writeFileSync(join(claudeDir, 'projects', 'p', 'memory', 'note.md'), '---\nname: a-note\ndescription: "why \\"this\\""\n---\nbody')
  writeFileSync(join(claudeDir, 'secret.md'), 'SECRET')
  const library = createLibrary({ claudeDir })

  assert.equal((await library.listPlans())[0].title, 'Checkout plan')
  assert.equal((await library.readPlan('checkout.md')).title, 'Checkout plan')
  assert.equal(await library.readPlan('../secret.md'), null)
  assert.equal((await library.listMemory())[0].notes[0].title, 'A note')
  assert.equal((await library.listMemory())[0].notes[0].description, 'why "this"')
  assert.equal(await library.readMemory('..', 'secret.md'), null)
  assert.equal(await library.readMemory('p', '../../secret.md'), null)

  const found = await library.search('checkout')
  assert.deepEqual(found.plans.map((plan) => plan.name), ['checkout.md'])
  assert.deepEqual((await library.search('body')).notes.map((note) => note.name), ['note.md'])
  assert.deepEqual(await library.search('s'), { plans: [], notes: [] })
  assert.deepEqual((await library.search('secret')).plans, [])
})

test('a snippet shows the text around the match', () => {
  const text = `${'a '.repeat(60)}the needle is here ${'b '.repeat(80)}`
  const snippet = snippetAround(text, 'needle')
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…') && snippet.includes('the needle is here'))
  assert.equal(snippetAround('# Plan\n\n## Steps\n\n1. Use **the** `needle`', 'needle'), 'Plan Steps Use the needle')
})

test('rejects rebinding hosts and cross-site requests', () => {
  assert.ok(isTrustedRequest({ host: '127.0.0.1:4777' }))
  assert.ok(isTrustedRequest({ host: 'localhost:4777', 'sec-fetch-site': 'same-origin' }))
  assert.ok(!isTrustedRequest({ host: 'evil.example:4777' }))
  assert.ok(!isTrustedRequest({ host: '127.0.0.1:4777', origin: 'https://evil.example' }))
  assert.ok(!isTrustedRequest({ host: '127.0.0.1:4777', 'sec-fetch-site': 'cross-site' }))
  assert.ok(!isTrustedRequest({ host: '127.0.0.1:4777', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }))
  assert.ok(!isTrustedRequest({ host: '127.0.0.1:4777', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }))
  const linkFromElsewhere = { host: '127.0.0.1:4777', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
  assert.ok(isTrustedRequest(linkFromElsewhere))
})

test('lists sessions waiting on you, oldest first, without subagents', () => {
  const graph = sessionWithSubagent()
  ensureNode(graph, 'session-2', { kind: 'session', label: 'Older', sessionId: 'session-2' })
  applyLines(graph, 'session-2', line({ type: 'assistant', timestamp: at(0), message: { stop_reason: 'end_turn', content: [] } }))
  const waiting = waitingSessions(snapshot(graph, 0))
  assert.deepEqual(waiting.map((entry) => entry.id), ['session-2', 'session-1'])
  assert.deepEqual(Object.keys(waiting[1]), ['id', 'label', 'room', 'branch', 'reason', 'since'])
  assert.equal(waiting[1].label, 'Checkout redesign')
  assert.ok(!JSON.stringify(waiting).includes('SECRET'))
})

test('classifies shell commands by what they do, without keeping them', () => {
  assert.equal(shellActivity('cat src/a.ts'), 'searching')
  assert.equal(shellActivity('cd ~/code/api && grep -rn todo src | head'), 'searching')
  assert.equal(shellActivity('git log --oneline -5 2>/dev/null'), 'searching')
  assert.equal(shellActivity("sed -i '' 's/a/b/' file.ts"), 'composing')
  assert.equal(shellActivity('cat > notes.md <<EOF'), 'composing')
  assert.equal(shellActivity('cd api && git commit -m "x"'), 'composing')
  assert.equal(shellActivity('pnpm test 2>&1 | tail -5'), 'working')
  assert.equal(shellActivity('docker compose up -d --build'), 'working')
  assert.equal(shellActivity(undefined), 'working')
})

const assistant = (second, message) => line({ type: 'assistant', timestamp: at(second), message })
const usage = (input, output) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } })

test('counts the usage of one API message once, per model, and keeps no content', () => {
  const graph = createGraph()
  ensureNode(graph, 's', { kind: 'session', label: 's', sessionId: 's' })
  const split = { id: 'msg_1', model: 'claude-opus-5-5', usage: usage(5, 7), content: [{ type: 'text', text: 'SECRET' }] }
  applyLines(graph, 's', assistant(1, split) + assistant(2, { ...split, content: [toolUse('t', 'Read', {})] }))
  applyLines(graph, 's', assistant(3, { id: 'msg_2', model: 'claude-sonnet-5-5', usage: usage(1, 2), content: [] }))
  const view = snapshot(graph, 0).nodes[0]
  assert.deepEqual(view.usage['claude-opus-5-5'], { input: 5, output: 7, cacheRead: 100, cacheWrite5m: 10, cacheWrite1h: 20 })
  assert.equal(view.usage['claude-sonnet-5-5'].output, 2)
  assert.ok(!JSON.stringify(view).includes('SECRET'))
})

test('a tool call stays pending until its result arrives', () => {
  const graph = createGraph()
  ensureNode(graph, 's', { kind: 'session', label: 's', sessionId: 's' })
  const result = (second, id) => line({ type: 'user', timestamp: at(second), message: { content: [{ type: 'tool_result', tool_use_id: id }] } })
  applyLines(graph, 's', assistant(1, { content: [toolUse('a', 'Bash', { command: 'SECRET' })] }) + assistant(2, { content: [toolUse('b', 'Read', {})] }))
  assert.deepEqual(snapshot(graph, 0).nodes[0].pendingTool, { name: 'Bash', since: Date.parse(at(1)) })
  applyLines(graph, 's', result(3, 'a'))
  assert.deepEqual(snapshot(graph, 0).nodes[0].pendingTool, { name: 'Read', since: Date.parse(at(2)) })
  applyLines(graph, 's', result(4, 'b'))
  assert.equal(snapshot(graph, 0).nodes[0].pendingTool, null)
  assert.ok(!JSON.stringify(snapshot(graph, 0)).includes('SECRET'))
})

test('a new prompt or a spawn does not leave a tool pending', () => {
  const graph = createGraph()
  ensureNode(graph, 's', { kind: 'session', label: 's', sessionId: 's' })
  applyLines(graph, 's', assistant(1, { content: [toolUse('a', 'Bash', {}), toolUse('spawn', 'Agent', {})] }))
  assert.equal(snapshot(graph, 0).nodes[0].pendingTool.name, 'Bash')
  applyLines(graph, 's', line({ type: 'user', timestamp: at(5), origin: { kind: 'human' }, message: { content: 'go' } }))
  assert.equal(snapshot(graph, 0).nodes[0].pendingTool, null)
})

test('replay shows the graph as it was, with the live visibility rules', () => {
  const graph = createGraph()
  ensureNode(graph, 's', { kind: 'session', label: 's', sessionId: 's' })
  ensureNode(graph, 'late', { kind: 'session', label: 'late', sessionId: 'late' })
  applyLines(graph, 's', assistant(10, { content: [toolUse('a', 'Read', {})] }) + assistant(20, { content: [toolUse('b', 'Edit', {})] }) + assistant(30, { stop_reason: 'end_turn', content: [] }))
  applyLines(graph, 'late', assistant(40, { content: [toolUse('c', 'Bash', {})] }))
  const second = (n) => Date.parse(at(n))
  const windowMs = 15_000

  assert.deepEqual(replay(graph, second(5), windowMs).nodes, [])
  const early = replay(graph, second(22), windowMs).nodes
  assert.deepEqual(early.map((node) => [node.id, node.activity, node.lastTool, node.waiting, node.lastAt]), [['s', 'composing', 'Edit', null, second(20)]])
  const done = replay(graph, second(35), windowMs, windowMs).nodes[0]
  assert.deepEqual(done.waiting, { reason: 'reply', since: second(30) })
  assert.deepEqual(replay(graph, second(46), windowMs).nodes.map((node) => node.id), ['late'])
})

test('history records state changes only, and edges remember when they began', () => {
  const graph = createGraph()
  ensureNode(graph, 's', { kind: 'session', label: 's', sessionId: 's' })
  applyLines(graph, 's', assistant(1, { content: [toolUse('a', 'Read', {})] }) + assistant(2, { content: [toolUse('b', 'Read', {})] }) + assistant(3, { content: [toolUse('c', 'Edit', {})] }))
  const history = graph.nodes.get('s').history
  assert.equal(history.length, 2)
  assert.equal(history[0][4], Date.parse(at(2)))
  assert.equal(graph.nodes.get('s').firstAt, Date.parse(at(1)))
})

test('tags usage with fast mode and long prompts, which change the price', () => {
  const graph = createGraph()
  ensureNode(graph, 's', { kind: 'session', sessionId: 's' })
  const record = (id, usage) => JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:00Z', message: { id, model: 'claude-haiku-5-5', usage, content: [] } })
  applyLines(graph, 's', [
    record('m1', { input_tokens: 10, output_tokens: 1, speed: 'fast' }),
    record('m2', { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100_000 }),
    record('m3', { input_tokens: 10, output_tokens: 1 }),
  ].join('\n'))
  const { usage } = snapshot(graph, 0).nodes[0]
  assert.deepEqual(Object.keys(usage).sort(), ['claude-haiku-5-5', 'claude-haiku-5-5 fast', 'claude-haiku-5-5 long'])
})

test('a subagent that hands back its report is finished, until someone messages it again', () => {
  const graph = createGraph()
  ensureNode(graph, 'sub', { kind: 'subagent', sessionId: 's' })
  const at = (second) => `2026-01-01T00:00:${String(second).padStart(2, '0')}Z`
  const toolUse = (second, name) => ({ type: 'assistant', timestamp: at(second), message: { content: [{ type: 'tool_use', id: `t${second}`, name, input: {} }] } })
  const toolResult = (second) => ({ type: 'user', timestamp: at(second), message: { content: [{ type: 'tool_result', tool_use_id: `t${second - 1}`, content: 'SECRET' }] } })
  const lines = (...records) => records.map((record) => JSON.stringify(record)).join('\n')
  applyLines(graph, 'sub', lines(toolUse(1, 'Read'), toolResult(2), toolUse(3, 'SubagentHandback'), toolResult(4), { type: 'attachment', timestamp: at(5) }))
  const handedBack = snapshot(graph, 0).nodes[0]
  assert.equal(handedBack.waiting?.reason, 'reply')
  assert.equal(handedBack.pendingTool, null)
  assert.ok(!JSON.stringify(snapshot(graph, 0)).includes('SECRET'))

  applyLines(graph, 'sub', lines({ type: 'user', timestamp: at(6), message: { content: 'One more thing' } }))
  assert.equal(snapshot(graph, 0).nodes[0].waiting, null)
})

test('in a monorepo, a path belongs to the outermost package below the root', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-orrery-mono-'))
  const make = (...parts) => mkdirSync(join(root, ...parts), { recursive: true })
  const touch = (...parts) => writeFileSync(join(root, ...parts), '{}')
  make('atlas', '.git')
  make('atlas', '.github', 'workflows')
  for (const app of ['atlas-web', 'atlas-api', 'types']) make('atlas', app, 'src'), touch('atlas', app, 'package.json')
  make('atlas', 'atlas-web', 'node_modules', 'react')
  touch('atlas', 'atlas-web', 'node_modules', 'react', 'package.json')
  // A worktree whose branch name has a slash: its root, with the .git file, is two folders down.
  make('atlas', '.claude', 'worktrees', 'feat', 'search', 'atlas-api', 'src')
  touch('atlas', '.claude', 'worktrees', 'feat', 'search', '.git')
  touch('atlas', '.claude', 'worktrees', 'feat', 'search', 'atlas-api', 'package.json')
  make('atlas', '.claude', 'worktrees', 'feat', 'search', 'atlas-web')
  touch('atlas', '.claude', 'worktrees', 'feat', 'search', 'atlas-web', 'package.json')
  make('shop', '.git')
  make('shop', 'apps', 'web', 'src')
  writeFileSync(join(root, 'shop', '.orrery.json'), JSON.stringify({ areas: ['apps/*'] }))
  const resolve = createRepoResolver(root)
  assert.equal(resolve(join(root, 'atlas', 'atlas-web', 'src', 'App.tsx')), 'atlas › atlas-web')
  assert.equal(resolve(join(root, 'atlas', 'atlas-web', 'node_modules', 'react', 'index.js')), 'atlas › atlas-web')
  assert.equal(resolve(join(root, 'atlas', 'types', 'src', 'index.ts')), 'atlas › types')
  assert.equal(resolve(join(root, 'atlas', '.github', 'workflows', 'ci.yml')), 'atlas')
  assert.equal(resolve(join(root, 'atlas', '.claude', 'worktrees', 'feat', 'search', 'atlas-api', 'src', 'a.ts')), 'atlas ⎇ feat/search › atlas-api')
  assert.equal(resolve(join(root, 'atlas', '.claude', 'worktrees', 'feat', 'search', 'README.md')), 'atlas ⎇ feat/search')
  // A single package is never split, however many manifests its dependencies, tools or settings have.
  make('gateway', '.git')
  touch('gateway', 'package.json')
  writeFileSync(join(root, 'gateway', 'pnpm-workspace.yaml'), 'minimumReleaseAge: 10080\n')
  make('gateway', 'node_modules', 'mysql2', 'lib')
  touch('gateway', 'node_modules', 'mysql2', 'package.json')
  make('gateway', 'tools', 'codegen')
  touch('gateway', 'tools', 'codegen', 'package.json')
  assert.equal(resolve(join(root, 'gateway', 'node_modules', 'mysql2', 'lib', 'pool.js')), 'gateway')
  assert.equal(resolve(join(root, 'gateway', 'tools', 'codegen', 'index.ts')), 'gateway')
  assert.equal(resolve(join(root, 'gateway', 'app', 'Services', 'User.ts')), 'gateway')
  // A workspace declared in package.json is a monorepo, and its node_modules still aren't packages.
  make('studio', '.git')
  writeFileSync(join(root, 'studio', 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }))
  make('studio', 'node_modules', 'react')
  touch('studio', 'node_modules', 'react', 'package.json')
  make('studio', 'packages', 'editor', 'src')
  touch('studio', 'packages', 'editor', 'package.json')
  assert.equal(resolve(join(root, 'studio', 'packages', 'editor', 'src', 'a.ts')), 'studio › packages/editor')
  assert.equal(resolve(join(root, 'studio', 'node_modules', 'react', 'index.js')), 'studio')
  // A dependency that came with its own .git still belongs to the repository that installed it.
  make('gateway', 'node_modules', '@acme', 'types', '.git')
  assert.equal(resolve(join(root, 'gateway', 'node_modules', '@acme', 'types', 'index.d.ts')), 'gateway')
  // A project of another language with one small JavaScript folder is not a monorepo.
  make('mac-app', '.git')
  touch('mac-app', 'Package.swift')
  make('mac-app', 'docs', 'src')
  touch('mac-app', 'docs', 'src', 'package.json')
  assert.equal(resolve(join(root, 'mac-app', 'docs', 'src', 'build.mjs')), 'mac-app')
  // Without a manifest at the root, one package folder is not enough to make a monorepo.
  make('engine', '.git')
  make('engine', 'ui', 'src')
  touch('engine', 'ui', 'package.json')
  assert.equal(resolve(join(root, 'engine', 'ui', 'src', 'App.tsx')), 'engine')
  // .orrery.json names the areas instead of manifests.
  assert.equal(resolve(join(root, 'shop', 'apps', 'web', 'src', 'page.tsx')), 'shop › apps/web')
  assert.equal(resolve(join(root, 'shop', 'README.md')), 'shop')
})

test('a monorepo splits into rooms only while two areas are busy, and a session started at its root joins its area', () => {
  const areaOf = (path) => path.match(/^\/code\/atlas\/([^/]+)\//)?.[1]
  const resolveRepo = (path) => (path.startsWith('/code/atlas') ? (areaOf(path) ? `atlas › ${areaOf(path)}` : 'atlas') : null)
  const build = (backend) => {
    const graph = createGraph({ resolveRepo })
    ensureNode(graph, 'lead', { kind: 'session', label: 'lead', sessionId: 'lead' })
    applyLines(graph, 'lead', line({ type: 'assistant', timestamp: at(1), cwd: '/code/atlas', message: { content: [toolUse('r1', 'Read', { file_path: '/code/atlas/atlas-web/src/App.tsx' })] } }))
    if (backend) {
      ensureNode(graph, 'helper', { kind: 'subagent', label: 'helper', sessionId: 'lead' })
      applyLines(graph, 'helper', line({ type: 'assistant', timestamp: at(2), cwd: '/code/atlas', message: { content: [toolUse('r2', 'Edit', { file_path: '/code/atlas/atlas-api/src/api.ts' })] } }))
    }
    return Object.fromEntries(snapshot(graph, 0).nodes.map((node) => [node.id, node.room]))
  }
  assert.deepEqual(build(false), { lead: 'atlas' })
  assert.deepEqual(build(true), { lead: 'atlas › atlas-web', helper: 'atlas › atlas-api' })
})

test('a session waiting on its own running subagents is not in the waiting list', () => {
  const now = Date.parse(at(30))
  const node = (fields) => ({ branch: null, room: 'app', waiting: null, pendingTool: null, lastAt: now - 60_000, ...fields })
  const lead = node({ id: 'lead', kind: 'session', label: 'Lead', waiting: { reason: 'reply', since: now - 60_000 } })
  const helper = node({ id: 'helper', kind: 'subagent', label: 'Helper', sessionId: 'lead' })
  assert.deepEqual(waitingSessions({ nodes: [lead, helper] }, now), [])
  const done = { ...helper, waiting: { reason: 'reply', since: now } }
  assert.deepEqual(waitingSessions({ nodes: [lead, done] }, now).map((entry) => entry.id), ['lead'])
})

test('an .orrery.json pattern never turns command text into a room', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-orrery-named-'))
  mkdirSync(join(root, 'shop', '.git'), { recursive: true })
  mkdirSync(join(root, 'shop', 'apps', 'web'), { recursive: true })
  writeFileSync(join(root, 'shop', '.orrery.json'), JSON.stringify({ areas: ['apps/*', '*'] }))
  const graph = createGraph({ resolveRepo: createRepoResolver(root) })
  ensureNode(graph, 's', { kind: 'session', label: 's', sessionId: 's' })
  const shop = join(root, 'shop')
  const command = `curl -o ${shop}/apps/SECRET_TOKEN/x https://example.com && echo ${shop}/SECRET_ROOT`
  applyLines(graph, 's', line({ type: 'assistant', timestamp: at(1), message: { content: [toolUse('b', 'Bash', { command })] } }))
  applyLines(graph, 's', line({ type: 'assistant', timestamp: at(2), message: { content: [toolUse('r', 'Read', { file_path: join(shop, 'apps', 'web', 'a.ts') })] } }))
  const everything = JSON.stringify([snapshot(graph, 0), timeline(graph, 's'), waitingSessions(snapshot(graph, 0))])
  assert.ok(!everything.includes('SECRET'), everything)
})

test('a hostile config file in a repository can neither hang nor flood the server', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-orrery-hostile-'))
  for (const repo of ['fifo', 'zero']) mkdirSync(join(root, repo, '.git'), { recursive: true })
  execFileSync('mkfifo', [join(root, 'fifo', '.orrery.json')])
  symlinkSync('/dev/zero', join(root, 'zero', 'package.json'))
  symlinkSync('/dev/zero', join(root, 'zero', 'pnpm-workspace.yaml'))
  const resolve = createRepoResolver(root)
  const started = Date.now()
  assert.equal(resolve(join(root, 'fifo', 'a.ts')), 'fifo')
  assert.equal(resolve(join(root, 'zero', 'a.ts')), 'zero')
  assert.ok(Date.now() - started < 1000)
})

test('paths longer than any real one are ignored', () => {
  const long = `/code/${'a/'.repeat(3000)}x.ts`
  assert.deepEqual(pathsInToolInput({ command: `ls ${long} /code/app/b.ts` }, null, '/home'), ['/code/app/b.ts'])
})

test('a model named __proto__ is just another key', () => {
  const graph = createGraph()
  ensureNode(graph, 's', { kind: 'session', label: 's', sessionId: 's' })
  applyLines(graph, 's', line({ type: 'assistant', timestamp: at(1), message: { id: 'm', model: '__proto__', usage: { input_tokens: 5, output_tokens: 1 }, content: [] } }))
  assert.equal({}.input, undefined)
  assert.equal(snapshot(graph, 0).nodes[0].usage.__proto__.input, 5)
})

test('usage takes the final output count from the last record of a message, and skips API errors', () => {
  const graph = createGraph()
  ensureNode(graph, 's', { kind: 'session', label: 's', sessionId: 's' })
  const record = (second, message) => line({ type: 'assistant', timestamp: at(second), message })
  const usage = (output) => ({ input_tokens: 10, output_tokens: output, cache_read_input_tokens: 100 })
  applyLines(graph, 's', record(1, { id: 'm1', model: 'claude-opus-5-5', usage: usage(3), content: [{ type: 'thinking' }] }) + record(2, { id: 'm1', model: 'claude-opus-5-5', usage: usage(6431), content: [] }))
  applyLines(graph, 's', record(3, { id: 'e1', model: '<synthetic>', stop_reason: 'stop_sequence', usage: usage(0), content: [] }).replace('"type":"assistant"', '"type":"assistant","isApiErrorMessage":true'))
  const node = snapshot(graph, 0).nodes[0]
  assert.deepEqual(Object.keys(node.usage), ['claude-opus-5-5'])
  assert.deepEqual(node.usage['claude-opus-5-5'], { input: 10, output: 6431, cacheRead: 100, cacheWrite5m: 0, cacheWrite1h: 0 })
  assert.equal(node.waiting?.reason, 'reply')
})

test('a hand-back wakes its session without a second line, and a stop leaves the session waiting', () => {
  const graph = createGraph()
  ensureNode(graph, 'lead', { kind: 'session', label: 'lead', sessionId: 'lead' })
  ensureNode(graph, 'sub', { kind: 'subagent', label: 'sub', sessionId: 'lead' })
  applyLines(graph, 'lead', line({ type: 'assistant', timestamp: at(1), message: { stop_reason: 'end_turn', content: [] } }))
  applyLines(graph, 'lead', line({ type: 'user', isMeta: true, timestamp: at(2), origin: { kind: 'peer', from: 'sub', name: 'sub', handback: true }, message: { content: 'SECRET' } }))
  let lead = snapshot(graph, 0).nodes.find((node) => node.id === 'lead')
  assert.equal(lead.waiting, null)
  assert.equal(lead.lastAt, Date.parse(at(2)))
  assert.equal(snapshot(graph, 0).messages.length, 0)
  applyLines(graph, 'lead', line({ type: 'user', isMeta: true, timestamp: at(3), origin: { kind: 'peer', from: 'sub', name: 'sub' }, message: { content: 'SECRET' } }))
  assert.equal(snapshot(graph, 0).messages.length, 1)
  applyLines(graph, 'lead', line({ type: 'user', timestamp: at(4), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }))
  lead = snapshot(graph, 0).nodes.find((node) => node.id === 'lead')
  assert.equal(lead.waiting?.reason, 'reply')
  assert.ok(!JSON.stringify([snapshot(graph, 0), timeline(graph, 'lead')]).includes('SECRET'))
})

test('replay shows nothing before the kept history, and a long silence as idle', () => {
  const graph = createGraph()
  ensureNode(graph, 's', { kind: 'session', label: 's', sessionId: 's' })
  const read = (second, id) => line({ type: 'assistant', timestamp: new Date(Date.parse(at(0)) + second * 1000).toISOString(), message: { content: [toolUse(id, 'Read', { file_path: '/x' })] } })
  applyLines(graph, 's', read(0, 'a') + read(3600, 'b'))
  const halfway = Date.parse(at(0)) + 1800 * 1000
  assert.equal(replay(graph, halfway, 6 * 3600_000).nodes[0].lastAt, Date.parse(at(0)))
  graph.nodes.get('s').history.shift()
  const early = replay(graph, Date.parse(at(0)) + 1000, 6 * 3600_000).nodes[0]
  assert.equal(early.activity, null)
  assert.equal(early.waiting, null)
})

test('areas are counted across a repository and its worktrees, as the page folds them', () => {
  const resolveRepo = (path) => (path.includes('/feat') ? 'shop ⎇ feat/x › apps/api' : 'shop › apps/web')
  const graph = createGraph({ resolveRepo })
  for (const [id, file] of [['a', '/code/shop/apps/web/a.ts'], ['b', '/code/shop/.claude/worktrees/feat/x/apps/api/b.ts']]) {
    ensureNode(graph, id, { kind: 'subagent', label: id, sessionId: id })
    applyLines(graph, id, line({ type: 'assistant', timestamp: at(1), message: { content: [toolUse(`r${id}`, 'Read', { file_path: file })] } }))
  }
  assert.deepEqual(snapshot(graph, 0).nodes.map((node) => node.room).sort(), ['shop × apps/web', 'shop ⎇ feat/x › apps/api'].map((key) => key.replace(' × ', ' › ')).sort())
})

test('a message to another agent reads as sent, without its text', () => {
  const graph = createGraph()
  ensureNode(graph, 's', { kind: 'session', label: 's', sessionId: 's' })
  applyLines(graph, 's', line({ type: 'assistant', timestamp: at(1), message: { content: [toolUse('m', 'SendMessage', { to: 'peer', message: 'SECRET' })] } }))
  assert.deepEqual(timeline(graph, 's').map((event) => event.text), ['Sent a message'])
})

test('a session waiting on a shell it runs in the background is not waiting on you, until the shell reports back', () => {
  const graph = createGraph()
  ensureNode(graph, 'lead', { kind: 'session', label: 'Lead', sessionId: 'lead' })
  applyLines(
    graph,
    'lead',
    line({ type: 'assistant', timestamp: at(1), message: { content: [toolUse('bg1', 'Bash', { command: 'SECRET', run_in_background: true })] } }) +
      line({ type: 'user', timestamp: at(1), message: { content: [{ type: 'tool_result', tool_use_id: 'bg1', content: 'SECRET' }] } }) +
      line({ type: 'assistant', timestamp: at(2), message: { stop_reason: 'end_turn', content: [] } }),
  )
  const now = Date.parse(at(30))
  assert.deepEqual(snapshot(graph, 0).nodes[0].background, [{ name: 'Bash', since: Date.parse(at(1)) }])
  assert.deepEqual(waitingSessions(snapshot(graph, 0), now), [])
  applyLines(graph, 'lead', line({ type: 'user', timestamp: at(20), origin: { kind: 'task-notification' }, message: { content: '<task-notification><tool-use-id>bg1</tool-use-id><status>completed</status>SECRET</task-notification>' } }))
  applyLines(graph, 'lead', line({ type: 'assistant', timestamp: at(21), message: { stop_reason: 'end_turn', content: [] } }))
  assert.deepEqual(snapshot(graph, 0).nodes[0].background, [])
  assert.deepEqual(waitingSessions(snapshot(graph, 0), now).map((entry) => entry.id), ['lead'])
  assert.ok(!JSON.stringify([snapshot(graph, 0), timeline(graph, 'lead')]).includes('SECRET'))
})

test('a session silent right after a tool result is probably asking you a question, held back until you answer', () => {
  const graph = createGraph()
  ensureNode(graph, 's', { kind: 'session', label: 'Layout', sessionId: 's' })
  applyLines(graph, 's', line({ type: 'assistant', timestamp: at(1), message: { content: [toolUse('a1', 'Agent', { description: 'x', run_in_background: true })] } }) + line({ type: 'user', timestamp: at(2), message: { content: [{ type: 'tool_result', tool_use_id: 'a1' }] } }))
  const seen = (seconds) => waitingSessions(snapshot(graph, 0), Date.parse(at(2)) + seconds * 1000)
  assert.deepEqual(seen(60), [])
  assert.deepEqual(seen(7 * 60).map(({ id, reason }) => [id, reason]), [['s', 'question']])
  applyLines(graph, 's', line({ type: 'assistant', timestamp: at(3), message: { content: [{ type: 'thinking' }] } }))
  assert.deepEqual(seen(7 * 60), [])
})

test('forgets nodes older than the cutoff and their messages, and keeps the rest', () => {
  const graph = createGraph()
  for (const [id, second] of [['old', 1], ['new', 50]]) {
    ensureNode(graph, id, { kind: 'session', label: id, sessionId: id })
    applyLines(graph, id, line({ type: 'assistant', timestamp: at(second), message: { content: [] } }))
  }
  applyLines(graph, 'new', line({ type: 'assistant', timestamp: at(51), message: { content: [toolUse('m', 'SendMessage', { to: 'old', message: 'x' })] } }))
  assert.deepEqual([...forget(graph, Date.parse(at(10)))], ['old'])
  assert.deepEqual([...graph.nodes.keys()], ['new'])
  assert.equal(graph.messages.size, 0)
})

test('a task notification after the turn ended leaves the session waiting on its agents, not asking a question', () => {
  const graph = createGraph()
  ensureNode(graph, 'lead', { kind: 'session', label: 'Lead', sessionId: 'lead' })
  ensureNode(graph, 'helper', { kind: 'subagent', label: 'Helper', sessionId: 'lead' })
  applyLines(graph, 'lead', line({ type: 'assistant', timestamp: at(1), message: { stop_reason: 'end_turn', content: [] } }) + line({ type: 'user', timestamp: at(1), origin: { kind: 'task-notification' }, message: { content: '<task-notification><tool-use-id>other</tool-use-id></task-notification>' } }))
  applyLines(graph, 'helper', line({ type: 'assistant', timestamp: at(50), message: { content: [toolUse('r', 'Read', { file_path: '/x' })] } }))
  const lead = snapshot(graph, 0).nodes.find((node) => node.id === 'lead')
  assert.equal(lead.waiting?.reason, 'reply')
  assert.equal(lead.owesReply, false)
  assert.deepEqual(waitingSessions(snapshot(graph, 0), Date.parse(at(55))), [])
})

test('background shells count only for the current turn, and close by task id or TaskStop too', () => {
  const graph = createGraph()
  ensureNode(graph, 's', { kind: 'session', label: 's', sessionId: 's' })
  const start = (second, id, task) =>
    line({ type: 'assistant', timestamp: at(second), message: { content: [toolUse(id, 'Bash', { command: 'x', run_in_background: true })] } }) +
    line({ type: 'user', timestamp: at(second), toolUseResult: { backgroundTaskId: task }, message: { content: [{ type: 'tool_result', tool_use_id: id }] } })
  applyLines(graph, 's', start(1, 'old', 'b-old'))
  applyLines(graph, 's', line({ type: 'user', timestamp: at(2), message: { content: 'next thing' } }))
  applyLines(graph, 's', start(3, 'one', 'b-one') + start(4, 'two', 'b-two') + start(5, 'three', 'b-three'))
  applyLines(graph, 's', line({ type: 'user', timestamp: at(6), origin: { kind: 'task-notification' }, message: { content: '<task-notification><task-id>b-one</task-id><status>completed</status></task-notification>' } }))
  applyLines(graph, 's', line({ type: 'assistant', timestamp: at(7), message: { content: [toolUse('stop', 'TaskStop', { task_id: 'b-two' })] } }))
  assert.deepEqual(snapshot(graph, 0).nodes[0].background, [{ name: 'Bash', since: Date.parse(at(5)) }])
})

const MINUTE = 60_000
const edit = (second, file) => line({ type: 'assistant', timestamp: at(second), message: { stop_reason: 'tool_use', content: [toolUse(`e${second}${file}`, 'Edit', { file_path: file, new_string: 'SECRET' })] } })

test('two sessions editing one file collide; a parent and its subagent, or agents taking turns, do not', () => {
  const graph = createGraph({ resolveRepo })
  ensureNode(graph, 's1', { kind: 'session', label: 'one', sessionId: 's1' })
  ensureNode(graph, 's2', { kind: 'session', label: 'two', sessionId: 's2' })
  ensureNode(graph, 'a1', { kind: 'subagent', label: 'child', sessionId: 's1', spawnToolUseId: 'spawn' })
  ensureNode(graph, 'a2', { kind: 'subagent', label: 'sibling', sessionId: 's1', spawnToolUseId: 'spawn-2' })
  applyLines(graph, 's1', edit(1, '/code/shop/cart.ts') + edit(2, '/code/shop/other.ts'))
  applyLines(graph, 's2', edit(30, '/code/shop/cart.ts') + edit(31, '/code/shop/other.ts'))
  applyLines(graph, 'a1', edit(10, '/code/shop/cart.ts'))
  // a2 edits after a1 has finished with the file: one session's agents taking turns.
  applyLines(graph, 'a2', edit(20, '/code/shop/cart.ts'))
  const now = Date.parse(at(40))
  const { collisions } = snapshot(graph, 0, 0, now)
  const pairs = collisions.map(({ a, b, files }) => `${a}>${b}:${files.join(',')}`).sort()
  assert.deepEqual(pairs, ['a1>s2:cart.ts', 'a2>s2:cart.ts', 's1>s2:cart.ts,other.ts'])
  assert.equal(collisions.find(({ a }) => a === 's1').repo, 'shop')
  // Ten minutes on, it's history.
  assert.deepEqual(snapshot(graph, 0, 0, now + 10 * MINUTE).collisions, [])
  // A replay has no collisions.
  assert.deepEqual(snapshot(graph, 0).collisions, [])
})

test('agents of one session collide while their edits of a file overlap', () => {
  const graph = createGraph({ resolveRepo })
  ensureNode(graph, 's1', { kind: 'session', label: 'one', sessionId: 's1' })
  ensureNode(graph, 'a1', { kind: 'subagent', label: 'one', sessionId: 's1', spawnToolUseId: 'x' })
  ensureNode(graph, 'a2', { kind: 'subagent', label: 'two', sessionId: 's1', spawnToolUseId: 'y' })
  applyLines(graph, 'a1', edit(1, '/code/shop/cart.ts') + edit(9, '/code/shop/cart.ts'))
  applyLines(graph, 'a2', edit(5, '/code/shop/cart.ts'))
  assert.deepEqual(snapshot(graph, 0, 0, Date.parse(at(10))).collisions.map(({ a, b }) => `${a}>${b}`), ['a1>a2'])
})

test('a wait counts as time on you once you answer it: a prompt, or the answer to a held-back question', () => {
  const graph = createGraph({ resolveRepo })
  ensureNode(graph, 's1', { kind: 'session', label: 'one', sessionId: 's1' })
  applyLines(
    graph,
    's1',
    line({ type: 'assistant', timestamp: at(1), message: { stop_reason: 'end_turn', content: [] } }) +
      // News from a background task isn't you.
      line({ type: 'user', timestamp: at(5), origin: { kind: 'task-notification' }, message: { content: 'done' } }) +
      line({ type: 'user', timestamp: at(10), message: { content: 'SECRET' } }) +
      line({ type: 'assistant', timestamp: at(20), message: { stop_reason: 'tool_use', content: [toolUse('q', 'AskUserQuestion', { questions: [] })] } }) +
      line({ type: 'user', timestamp: at(45), message: { content: [{ type: 'tool_result', tool_use_id: 'q', content: 'SECRET' }] } }),
  )
  const [node] = snapshot(graph, 0).nodes
  assert.deepEqual(node.youWaits, [
    [Date.parse(at(1)), Date.parse(at(10))],
    [Date.parse(at(20)), Date.parse(at(45))],
  ])
  // A replay knows only the waits that had ended by then.
  assert.equal(replay(graph, Date.parse(at(30)), 3_600_000).nodes[0].youWaits.length, 1)
})

test('Claude Code\'s own status decides: a prompt waits on you, busy does not, and a closed session is over', () => {
  const graph = createGraph({ resolveRepo })
  for (const id of ['s1', 's2', 's3', 's4']) ensureNode(graph, id, { kind: 'session', label: id, sessionId: id })
  ensureNode(graph, 'a3', { kind: 'subagent', label: 'child', sessionId: 's3', spawnToolUseId: 'x' })
  const ended = line({ type: 'assistant', timestamp: at(1), message: { stop_reason: 'end_turn', content: [] } })
  for (const id of ['s1', 's2', 's3', 's4']) applyLines(graph, id, ended)
  applyLines(graph, 'a3', edit(2, '/code/shop/a.ts'))
  const now = Date.parse(at(50))
  // Before any status is known, the transcripts decide.
  assert.equal(snapshot(graph, 0, 0, now).nodes[0].live, null)
  setLive(
    graph,
    [
      { sessionId: 's1', status: 'waiting', waitingFor: 'permission prompt', since: now - 1000 },
      // Busy after its turn ended: background agents still run.
      { sessionId: 's2', status: 'busy', since: now - 1000 },
      { sessionId: 's3', status: 'idle', since: now - 1000 },
      { sessionId: 's4', status: 'waiting', waitingFor: 'something new', since: now - 1000 },
      { sessionId: 'x', status: 'nonsense' },
    ],
    now,
  )
  const live = Object.fromEntries(snapshot(graph, 0, 0, now).nodes.map((node) => [node.id, node.live]))
  assert.deepEqual(live.s1, { status: 'waiting', since: now - 1000, reason: 'permission' })
  assert.deepEqual(live.s4.reason, 'dialog')
  assert.equal(live.a3, null)
  const waiting = waitingSessions(snapshot(graph, 0, 0, now), now)
  assert.deepEqual(waiting.map(({ id, reason }) => `${id}:${reason}`), ['s3:reply', 's1:permission', 's4:dialog'])

  // s1's prompt is answered and s3 is closed: the prompt was time on you, and s3's subagent ends with it.
  setLive(graph, [{ sessionId: 's1', status: 'busy', since: now + 5000 }], now + 6000)
  const after = Object.fromEntries(snapshot(graph, 0, 0, now + 6000).nodes.map((node) => [node.id, node]))
  assert.deepEqual(after.s1.youWaits.at(-1), [now - 1000, now + 5000])
  assert.deepEqual(after.s3.live, { status: 'closed' })
  assert.deepEqual(after.a3.live, { status: 'closed' })
  assert.deepEqual(waitingSessions(snapshot(graph, 0, 0, now + 6000), now + 6000).map(({ id }) => id), [])
})

test('a session never seen running counts as closed only once it has been silent a while with nothing open', () => {
  const graph = createGraph({ resolveRepo })
  ensureNode(graph, 's1', { kind: 'session', label: 'one', sessionId: 's1' })
  applyLines(graph, 's1', line({ type: 'assistant', timestamp: at(1), message: { stop_reason: 'tool_use', content: [toolUse('b', 'Bash', { command: 'pnpm test' })] } }))
  setLive(graph, [], Date.parse(at(1)))
  const start = Date.parse(at(1))
  // A headless run may write no status file, so a long call keeps it running.
  assert.equal(snapshot(graph, 0, 0, start + 10 * MINUTE).nodes[0].live, null)
  applyLines(graph, 's1', line({ type: 'user', timestamp: at(2), message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: '' }] } }))
  assert.equal(snapshot(graph, 0, 0, start + 60_000).nodes[0].live, null)
  assert.deepEqual(snapshot(graph, 0, 0, start + 3 * MINUTE).nodes[0].live, { status: 'closed' })
})

test('the day view joins a session\'s work into stretches and keeps its subagents\' apart', () => {
  assert.deepEqual(joinSpans([[5, 8], [1, 3], [3, 4], [20, 30]]), [[1, 4], [5, 8], [20, 30]])
  assert.deepEqual(joinSpans([[1, 4], [5, 8]], 1), [[1, 8]])
  const graph = createGraph({ resolveRepo })
  ensureNode(graph, 's1', { kind: 'session', label: 'one', sessionId: 's1' })
  ensureNode(graph, 'a1', { kind: 'subagent', label: 'child', sessionId: 's1', spawnToolUseId: 'x' })
  applyLines(
    graph,
    's1',
    line({ type: 'user', timestamp: at(0), message: { content: 'go' } }) +
      line({ type: 'assistant', timestamp: at(4), message: { stop_reason: 'end_turn', content: [] } }),
  )
  applyLines(graph, 'a1', edit(2, '/code/shop/a.ts') + edit(3, '/code/shop/a.ts'))
  const [row] = day(graph, 0)
  assert.equal(row.id, 's1')
  assert.deepEqual(row.runs, [[Date.parse(at(0)), Date.parse(at(0))]])
  assert.deepEqual(row.agentRuns, [[Date.parse(at(2)), Date.parse(at(3))]])
})

test('a forked subagent does not take over the parent message it starts with, so its parent stays its parent', () => {
  const graph = createGraph({ resolveRepo })
  ensureNode(graph, 's1', { kind: 'session', label: 'one', sessionId: 's1' })
  ensureNode(graph, 'f1', { kind: 'subagent', label: 'fork one', sessionId: 's1', spawnToolUseId: 'spawn-1' })
  ensureNode(graph, 'f2', { kind: 'subagent', label: 'fork two', sessionId: 's1', spawnToolUseId: 'spawn-2' })
  const spawning = {
    type: 'assistant',
    timestamp: at(1),
    message: { id: 'm1', usage: { input_tokens: 100, output_tokens: 10 }, stop_reason: 'tool_use', content: [toolUse('spawn-1', 'Agent', { description: 'one' }), toolUse('spawn-2', 'Agent', { description: 'two' })] },
  }
  applyLines(graph, 's1', line(spawning))
  // Each fork's transcript repeats the message that started it.
  for (const id of ['f1', 'f2']) applyLines(graph, id, line({ ...spawning, isSidechain: true }) + edit(5, '/code/shop/a.ts'))
  const nodes = Object.fromEntries(snapshot(graph, 0).nodes.map((node) => [node.id, node]))
  assert.equal(nodes.f1.parentId, 's1')
  assert.equal(nodes.f2.parentId, 's1')
  assert.deepEqual(Object.keys(nodes.f1.usage), [])
})

test('a published artifact keeps its title and claude.ai address, and nothing else from the reply', () => {
  const graph = createGraph({ resolveRepo })
  ensureNode(graph, 's1', { kind: 'session', label: 'one', sessionId: 's1' })
  const publish = (id, second, input) => line({ type: 'assistant', timestamp: at(second), message: { stop_reason: 'tool_use', content: [toolUse(id, 'Artifact', input)] } })
  const reply = (id, second, text, isError = false) => line({ type: 'user', timestamp: at(second), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: [{ type: 'text', text }] }] } })
  applyLines(
    graph,
    's1',
    publish('p1', 1, { file_path: '/code/shop/Launch plan.html', description: 'SECRET' }) +
      reply('p1', 2, 'Published at https://claude.ai/code/artifact/0123456789-abcd. SECRET watch line https://claude.ai/artifact/typeTypeType') +
      // A republish names its data file, which mustn't rename the page.
      publish('p2', 3, { url: 'https://claude.ai/code/artifact/0123456789-abcd', file_path: '/tmp/data.json' }) +
      reply('p2', 4, 'Updated.') +
      publish('p3', 5, { action: 'publish', type_url: 'https://claude.ai/artifact/typeTypeType', title: 'Board deck' }) +
      reply('p3', 6, 'Created a new Artifact at https://claude.ai/artifact/DeckDeckDeck from the Artifact type https://claude.ai/artifact/typeTypeType') +
      publish('p4', 7, { file_path: '/code/shop/broken.html' }) +
      reply('p4', 8, 'Refused', true) +
      publish('p5', 9, { action: 'read', url: 'https://claude.ai/artifact/SomeoneElses' }) +
      reply('p5', 10, 'https://claude.ai/artifact/SomeoneElses'),
  )
  const [node] = snapshot(graph, 0).nodes
  assert.deepEqual(node.artifacts, [
    { title: 'Board deck', url: 'https://claude.ai/artifact/DeckDeckDeck', at: Date.parse(at(5)) },
    { title: 'Launch plan', url: 'https://claude.ai/code/artifact/0123456789-abcd', at: Date.parse(at(3)) },
  ])
  assert.ok(!JSON.stringify(snapshot(graph, 0)).includes('SECRET'))
  assert.deepEqual(timeline(graph, 's1').map(({ text }) => text).slice(0, 3), ['Published Launch plan', 'Published data', 'Published Board deck'])
  // Deleting one takes it off the list.
  applyLines(graph, 's1', publish('d1', 11, { action: 'delete', url: 'https://claude.ai/artifact/DeckDeckDeck' }))
  assert.deepEqual(snapshot(graph, 0).nodes[0].artifacts.map(({ title }) => title), ['Launch plan'])
})
