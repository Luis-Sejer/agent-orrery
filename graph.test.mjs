import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { applyLines, createGraph, ensureNode, shellActivity, snapshot, timeline } from './graph.mjs'
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
  assert.deepEqual(view.messages, [{ from: 'agent-a', to: 'session-1', count: 1, lastAt: Date.parse(at(5)) }])
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
