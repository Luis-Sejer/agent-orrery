import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createArtifactIndex } from './artifacts.mjs'

const line = (record) => `${JSON.stringify(record)}\n`
const at = (minute) => `2026-10-13T10:${String(minute).padStart(2, '0')}:00Z`
const publish = (id, minute, input) => line({ type: 'assistant', timestamp: at(minute), cwd: '/code/shop', message: { content: [{ type: 'tool_use', id, name: 'Artifact', input }] } })
const reply = (id, minute, text) => line({ type: 'user', timestamp: at(minute), message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } })

test('finds artifacts in every transcript, with their session, and reads only what is new after that', async () => {
  const projects = mkdtempSync(join(tmpdir(), 'orrery-artifacts-'))
  const project = join(projects, '-code-shop')
  mkdirSync(join(project, 's1', 'subagents'), { recursive: true })
  const session = join(project, 's1.jsonl')
  writeFileSync(session, line({ type: 'ai-title', aiTitle: 'Launch week' }) + publish('a', 1, { title: 'Launch plan' }) + reply('a', 2, 'Published https://claude.ai/artifact/LaunchPlan1'))
  writeFileSync(join(project, 's1', 'subagents', 'agent-x1.jsonl'), publish('b', 3, { file_path: '/code/shop/deck.html' }) + reply('b', 4, 'At https://claude.ai/code/artifact/deck-0001 ok'))
  const index = createArtifactIndex({ projectsDir: projects, resolveRepo: (path) => (path.startsWith('/code/shop') ? 'shop' : null) })

  const first = await index.list()
  assert.deepEqual(
    first.map(({ title, sessionId, agentId, session: name, repo }) => ({ title, sessionId, agentId, session: name, repo })),
    [
      { title: 'deck', sessionId: 's1', agentId: 'x1', session: 'Launch week', repo: 'shop' },
      { title: 'Launch plan', sessionId: 's1', agentId: null, session: 'Launch week', repo: 'shop' },
    ],
  )

  // Later: the plan is republished from its data file and the deck deleted, in the session's transcript.
  appendFileSync(session, publish('c', 5, { url: 'https://claude.ai/artifact/LaunchPlan1', file_path: '/tmp/data.json' }) + reply('c', 6, 'Updated') + publish('d', 7, { action: 'delete', url: 'https://claude.ai/code/artifact/deck-0001' }))
  const later = await index.list()
  assert.deepEqual(later.map(({ title, at: when }) => [title, when]), [['Launch plan', Date.parse(at(5))]])
  assert.deepEqual((await index.search('launch')).map(({ title }) => title), ['Launch plan'])
  assert.deepEqual(await index.search('x'), [])
})

test("a workflow's agents are found in their run folders, beside the session's own subagents", async () => {
  const { agentTranscripts } = await import('./transcripts.mjs')
  const session = mkdtempSync(join(tmpdir(), 'orrery-session-'))
  mkdirSync(join(session, 'subagents', 'workflows', 'wf_run-1'), { recursive: true })
  for (const path of ['subagents/agent-a1.jsonl', 'subagents/agent-a1.meta.json', 'subagents/workflows/wf_run-1/agent-w1.jsonl', 'subagents/workflows/wf_run-1/agent-w2.jsonl', 'subagents/workflows/wf_run-1/notes.txt']) {
    writeFileSync(join(session, path), '')
  }
  const found = (await agentTranscripts(session)).map(({ agentId, path, metaPath }) => [agentId, path.slice(session.length + 1), metaPath.slice(session.length + 1)])
  assert.deepEqual(found.sort(), [
    ['a1', 'subagents/agent-a1.jsonl', 'subagents/agent-a1.meta.json'],
    ['w1', 'subagents/workflows/wf_run-1/agent-w1.jsonl', 'subagents/workflows/wf_run-1/agent-w1.meta.json'],
    ['w2', 'subagents/workflows/wf_run-1/agent-w2.jsonl', 'subagents/workflows/wf_run-1/agent-w2.meta.json'],
  ])
})
