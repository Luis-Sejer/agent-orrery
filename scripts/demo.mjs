// Generates a made-up Claude Code home folder and serves agent-graph on it, so you can try
// the dashboard (and take screenshots) without showing anyone your real sessions.
// The data goes through the real transcript parser, and a ticker keeps the agents busy.
//
//   pnpm demo            # http://127.0.0.1:4780
//   AGENT_GRAPH_PORT=4790 pnpm demo

import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = process.env.AGENT_GRAPH_PORT ?? '4780'
const ROOT = join(tmpdir(), 'agent-graph-demo')
const CLAUDE_DIR = join(ROOT, 'claude')
const CODE_DIR = join(ROOT, 'code')
const TICK_MS = 2_500
const MINUTE = 60_000
const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url))

const REPOS = ['storefront-web', 'storefront-api', 'mobile-app', 'design-system', 'infra']

let idCounter = 0
const nextId = (prefix) => `${prefix}${(++idCounter).toString(16).padStart(15, '0')}`
const sessionId = (n) => `5e55a000-0000-4000-8000-00000000000${n}`
const repoPath = (repo, ...rest) => join(CODE_DIR, repo, ...rest)
const ago = (minutes) => new Date(Date.now() - minutes * MINUTE).toISOString()

// One step an agent can take, as the tool call Claude Code would record.
const STEPS = {
  read: (repo, file) => ['Read', { file_path: repoPath(repo, file) }],
  edit: (repo, file) => ['Edit', { file_path: repoPath(repo, file), old_string: '…', new_string: '…' }],
  write: (repo, file) => ['Write', { file_path: repoPath(repo, file), content: '…' }],
  grep: (repo) => ['Grep', { pattern: '…', path: repoPath(repo, 'src') }],
  bash: (repo) => ['Bash', { command: `cd ${repoPath(repo)} && npm test` }],
}

class Transcript {
  constructor(path, { cwd, branch, session }) {
    this.path = path
    this.base = { cwd, gitBranch: branch, sessionId: session }
    writeFileSync(path, '')
  }

  add(record) {
    appendFileSync(this.path, `${JSON.stringify({ ...this.base, ...record })}\n`)
  }

  title(text) {
    this.add({ type: 'ai-title', aiTitle: text })
  }

  prompt(minutesAgo) {
    this.add({ type: 'user', timestamp: ago(minutesAgo), origin: { kind: 'human' }, message: { content: '…' } })
  }

  tool(minutesAgo, [name, input], id = nextId('toolu_')) {
    this.add({ type: 'assistant', timestamp: ago(minutesAgo), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } })
    this.add({ type: 'user', timestamp: ago(minutesAgo), message: { content: [{ type: 'tool_result', tool_use_id: id }] } })
    return id
  }

  // A question stays open: no tool result follows it.
  question(minutesAgo) {
    this.add({ type: 'assistant', timestamp: ago(minutesAgo), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: nextId('toolu_'), name: 'AskUserQuestion', input: {} }] } })
  }

  endTurn(minutesAgo) {
    this.add({ type: 'assistant', timestamp: ago(minutesAgo), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '…' }] } })
  }

  messageFrom(minutesAgo, from, name) {
    this.add({ type: 'user', timestamp: ago(minutesAgo), origin: { kind: 'peer', from, name, body: '…' }, message: { content: '…' } })
  }
}

const running = []

function createSession({ n, title, repo, branch }) {
  const id = sessionId(n)
  const projectDir = join(CLAUDE_DIR, 'projects', repoPath(repo).replaceAll('/', '-'))
  mkdirSync(join(projectDir, id, 'subagents'), { recursive: true })
  const transcript = new Transcript(join(projectDir, `${id}.jsonl`), { cwd: repoPath(repo), branch, session: id })
  transcript.title(title)

  function subagent({ minutesAgo, description, agentType, model = 'sonnet' }) {
    const toolUseId = transcript.tool(minutesAgo, ['Agent', { description, subagent_type: agentType, prompt: '…' }])
    const agentId = nextId('a')
    const base = join(projectDir, id, 'subagents', `agent-${agentId}`)
    writeFileSync(`${base}.meta.json`, JSON.stringify({ agentType, description, toolUseId, model }))
    const agent = new Transcript(`${base}.jsonl`, { cwd: repoPath(repo), branch, session: id })
    agent.id = agentId
    return agent
  }

  return { id, projectDir, transcript, subagent }
}

function writeRepos() {
  for (const repo of REPOS) mkdirSync(repoPath(repo, '.git'), { recursive: true })
}

function writeSessions() {
  // 1. A big session in the web app, mid-flight, with helpers in three repos.
  const checkout = createSession({ n: 1, title: 'Checkout redesign', repo: 'storefront-web', branch: 'feat/checkout-redesign' })
  checkout.transcript.prompt(95)
  checkout.transcript.tool(93, ['Write', { file_path: join(CLAUDE_DIR, 'plans', 'checkout-redesign.md'), content: '…' }])
  const exploreNames = ['Map the cart state', 'Find price formatting', 'List the checkout routes', 'Audit form validation']
  exploreNames.forEach((description, index) => {
    const agent = checkout.subagent({ minutesAgo: 90 - index, description, agentType: 'Explore', model: 'haiku' })
    agent.tool(88 - index, STEPS.grep('storefront-web'))
    agent.tool(86 - index, STEPS.read('storefront-web', 'src/checkout/Cart.tsx'))
    agent.endTurn(85 - index)
    checkout.transcript.messageFrom(85 - index, agent.id, 'Explore')
  })
  const accessibility = checkout.subagent({ minutesAgo: 40, description: 'Review accessibility of the form', agentType: 'general-purpose' })
  accessibility.tool(38, STEPS.read('design-system', 'src/components/Field.tsx'))
  accessibility.tool(30, STEPS.edit('design-system', 'src/components/Field.tsx'))
  accessibility.endTurn(26)
  const contract = checkout.subagent({ minutesAgo: 22, description: 'Write the order API contract', agentType: 'general-purpose' })
  contract.tool(20, STEPS.read('storefront-api', 'src/orders/routes.ts'))
  contract.tool(2, STEPS.write('storefront-api', 'src/orders/schema.ts'))
  contract.tool(1, [`SendMessage`, { to: checkout.id, message: '…' }])
  checkout.transcript.messageFrom(1, contract.id, 'general-purpose')
  const translate = checkout.subagent({ minutesAgo: 12, description: 'Translate the checkout copy', agentType: 'translator' })
  translate.tool(1, STEPS.read('storefront-web', 'src/locales/de.json'))
  checkout.transcript.tool(0.5, STEPS.edit('storefront-web', 'src/checkout/Summary.tsx'))
  running.push(
    { transcript: checkout.transcript, repo: 'storefront-web', files: ['src/checkout/Summary.tsx', 'src/checkout/Payment.tsx'] },
    { transcript: contract, repo: 'storefront-api', files: ['src/orders/schema.ts', 'src/orders/routes.ts'], lead: checkout.id },
    { transcript: translate, repo: 'storefront-web', files: ['src/locales/de.json', 'src/locales/fr.json', 'src/locales/es.json'] },
  )

  // 2. Waiting on you: it asked a question.
  const limiter = createSession({ n: 2, title: 'Rate limiter for the public API', repo: 'storefront-api', branch: 'feat/rate-limiter' })
  limiter.transcript.prompt(70)
  const benchmark = limiter.subagent({ minutesAgo: 66, description: 'Benchmark the token bucket', agentType: 'general-purpose' })
  benchmark.tool(64, STEPS.bash('storefront-api'))
  benchmark.endTurn(50)
  const runbook = limiter.subagent({ minutesAgo: 48, description: 'Draft the incident runbook', agentType: 'general-purpose' })
  runbook.tool(40, STEPS.write('infra', 'runbooks/rate-limits.md'))
  runbook.endTurn(35)
  limiter.transcript.tool(20, ['Write', { file_path: join(CLAUDE_DIR, 'plans', 'rate-limiter.md'), content: '…' }])
  limiter.transcript.tool(8, [`SendMessage`, { to: checkout.id, message: '…' }])
  checkout.transcript.messageFrom(8, limiter.id, 'Rate limiter for the public API')
  limiter.transcript.question(6)

  // 3. Waiting on you: it finished.
  const deps = createSession({ n: 3, title: 'October dependency updates', repo: 'design-system', branch: 'chore/deps-october' })
  deps.transcript.prompt(45)
  const changelogs = deps.subagent({ minutesAgo: 44, description: 'Check changelogs for breaking changes', agentType: 'Explore', model: 'haiku' })
  changelogs.tool(43, STEPS.read('design-system', 'package.json'))
  changelogs.endTurn(30)
  deps.transcript.tool(25, STEPS.bash('design-system'))
  deps.transcript.endTurn(18)

  // 4. Busy on a flaky test.
  const flaky = createSession({ n: 4, title: 'Fix the flaky login test', repo: 'mobile-app', branch: 'fix/flaky-login' })
  flaky.transcript.prompt(15)
  const logs = flaky.subagent({ minutesAgo: 13, description: 'Read the failing CI runs', agentType: 'Explore', model: 'haiku' })
  logs.tool(1, STEPS.grep('mobile-app'))
  flaky.transcript.tool(0.3, STEPS.bash('mobile-app'))
  running.push(
    { transcript: flaky.transcript, repo: 'mobile-app', files: ['test/login.test.ts', 'src/auth/session.ts'] },
    { transcript: logs, repo: 'mobile-app', files: ['ci/logs/run-4812.txt'] },
  )

  // 5. Finished a while ago, still waiting on you.
  const drift = createSession({ n: 5, title: 'Terraform drift check', repo: 'infra', branch: 'chore/drift' })
  drift.transcript.prompt(160)
  drift.transcript.tool(150, STEPS.bash('infra'))
  drift.transcript.endTurn(140)

  return [checkout, limiter, deps]
}

const PLANS = {
  'checkout-redesign.md': `# Checkout redesign

## Goal

Cut checkout from four steps to two without losing the order summary.

## Steps

1. Map the cart state and every route that touches checkout.
2. Merge shipping and payment into one step, with the summary pinned beside it.
3. Write the order API contract, so the web app and the API agree before either changes.
4. Translate the new copy into German, French and Spanish.
5. Review the form for keyboard use and screen readers.

## Open questions

- Do saved cards stay on the payment step or move to the summary?
- Should guest checkout ask for an account at the end?
`,
  'rate-limiter.md': `# Rate limiter for the public API

A token bucket per API key, stored in Redis, with a burst of 50 and a refill of 10 per second.

| Plan | Burst | Refill |
|---|---|---|
| Free | 20 | 2/s |
| Team | 50 | 10/s |
| Enterprise | 200 | 50/s |

Requests over the limit get \`429\` with a \`Retry-After\` header.
`,
}

const MEMORY = {
  'MEMORY.md': `- [Run tests with the watch flag off](feedback_tests.md) — CI fails on watch mode
- [Prices are integers in cents](project_prices.md) — never floats
- [Design tokens live in design-system](reference_tokens.md) — import, don't copy
`,
  'feedback_tests.md': `---
name: Run tests with the watch flag off
description: CI fails when a test script starts in watch mode, so always pass --run.
type: feedback
---

Pass \`--run\` to the test command. **Why:** watch mode never exits on CI.
`,
  'project_prices.md': `---
name: Prices are integers in cents
description: Every price in the API and the web app is an integer number of cents.
type: project
---

Format prices only at the edge, with the shared \`formatPrice\` helper.
`,
  'reference_tokens.md': `---
name: Design tokens live in design-system
description: Colours, spacing and type come from the design-system package; never copy values.
type: reference
---

Import from \`@storefront/design-system/tokens\`.
`,
}

function writeLibrary(sessions) {
  const plansDir = join(CLAUDE_DIR, 'plans')
  mkdirSync(plansDir, { recursive: true })
  for (const [name, content] of Object.entries(PLANS)) writeFileSync(join(plansDir, name), content)
  const memoryDir = join(sessions[0].projectDir, 'memory')
  mkdirSync(memoryDir, { recursive: true })
  for (const [name, content] of Object.entries(MEMORY)) writeFileSync(join(memoryDir, name), content)
}

const TICK_STEPS = ['read', 'edit', 'grep', 'bash', 'write']

// Keeps the running agents busy so the orbs change and messages travel.
function tick() {
  const agent = running[Math.floor(Math.random() * running.length)]
  const file = agent.files[Math.floor(Math.random() * agent.files.length)]
  if (agent.lead && Math.random() < 0.3) {
    agent.transcript.tool(0, ['SendMessage', { to: agent.lead, message: '…' }])
    return
  }
  const step = TICK_STEPS[Math.floor(Math.random() * TICK_STEPS.length)]
  agent.transcript.tool(0, STEPS[step](agent.repo, file))
}

rmSync(ROOT, { recursive: true, force: true })
writeRepos()
const sessions = writeSessions()
writeLibrary(sessions)

const server = spawn(process.execPath, [SERVER], {
  stdio: 'inherit',
  env: { ...process.env, AGENT_GRAPH_PORT: PORT, AGENT_GRAPH_CLAUDE_DIR: CLAUDE_DIR },
})
const ticker = setInterval(tick, TICK_MS)
const stop = () => {
  clearInterval(ticker)
  server.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
server.on('exit', (code) => {
  clearInterval(ticker)
  process.exit(code ?? 0)
})
