import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { applyLines, createGraph, ensureNode, replay, shellActivity, snapshot, timeline, waitingSessions } from './graph.mjs'
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
  const resolve = createRepoResolver(root)
  assert.equal(resolve(join(root, 'storefront-web', '.claude', 'worktrees', 'feat-x', 'src', 'a.ts')), 'storefront-web')
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
