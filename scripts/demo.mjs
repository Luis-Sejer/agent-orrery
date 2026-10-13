// Generates a made-up Claude Code home folder and serves agent-orrery on it, so you can try
// the dashboard (and take screenshots) without showing anyone your real sessions.
// The data goes through the real transcript parser, and a ticker keeps the agents busy.
//
//   pnpm demo              # http://127.0.0.1:4780
//   pnpm demo --monorepo   # one made-up monorepo with eight packages instead
//   AGENT_ORRERY_PORT=4790 pnpm demo

import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = process.env.AGENT_ORRERY_PORT ?? '4780'
// One folder per port, so two demos (say, screenshots and a recording) can run at once.
const ROOT = join(tmpdir(), `agent-orrery-demo-${PORT}`)
const CLAUDE_DIR = join(ROOT, 'claude')
const CODE_DIR = join(ROOT, 'code')
const TICK_MS = 2_500
const MINUTE = 60_000
const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url))

const REPOS = ['storefront-web', 'storefront-api', 'mobile-app', 'design-system', 'infra']
const MONOREPO = process.argv.includes('--monorepo')
// The monorepo: one repository whose packages each have a package.json, so each becomes an area.
const ATLAS = 'atlas'
const ATLAS_PACKAGES = ['apps/web', 'apps/admin', 'apps/mobile', 'services/api', 'services/billing', 'services/search', 'packages/ui', 'packages/config']

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

const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'
const between = (low, high) => Math.round(low + Math.random() * (high - low))

// What Claude Code records for one API message: its id, model and token counts.
function messageMeta(model) {
  const write5m = between(1_000, 4_000)
  const write1h = between(1_000, 4_000)
  return {
    id: nextId('msg_'),
    model,
    usage: {
      input_tokens: between(3, 40),
      output_tokens: between(200, 1_500),
      cache_read_input_tokens: between(20_000, 120_000),
      cache_creation_input_tokens: write5m + write1h,
      cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h },
      speed: 'standard',
    },
  }
}

class Transcript {
  constructor(path, { cwd, branch, session, model = SONNET, alsoUses = null }) {
    this.path = path
    this.model = model
    this.alsoUses = alsoUses
    this.calls = 0
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

  // A session that hands some work to a cheaper model shows more than one model.
  nextModel() {
    this.calls += 1
    return this.alsoUses && this.calls % 3 === 0 ? this.alsoUses : this.model
  }

  tool(minutesAgo, [name, input], id = nextId('toolu_')) {
    this.openTool(minutesAgo, [name, input], id)
    this.add({ type: 'user', timestamp: ago(minutesAgo), message: { content: [{ type: 'tool_result', tool_use_id: id }] } })
    return id
  }

  // A call with no result yet, like a permission prompt or a long test run.
  openTool(minutesAgo, [name, input], id = nextId('toolu_')) {
    this.add({ type: 'assistant', timestamp: ago(minutesAgo), message: { ...messageMeta(this.nextModel()), stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } })
    return id
  }

  // A question stays open: no tool result follows it.
  question(minutesAgo) {
    this.add({ type: 'assistant', timestamp: ago(minutesAgo), message: { ...messageMeta(this.model), stop_reason: 'tool_use', content: [{ type: 'tool_use', id: nextId('toolu_'), name: 'AskUserQuestion', input: {} }] } })
  }

  endTurn(minutesAgo) {
    this.add({ type: 'assistant', timestamp: ago(minutesAgo), message: { ...messageMeta(this.model), stop_reason: 'end_turn', content: [{ type: 'text', text: '…' }] } })
  }

  messageFrom(minutesAgo, from, name) {
    // Claude Code writes messages from other agents as meta records.
    this.add({ type: 'user', isMeta: true, timestamp: ago(minutesAgo), origin: { kind: 'peer', from, name, body: '…' }, message: { content: '…' } })
  }
}

const running = []

function createSession({ n, title, repo, branch, alsoUses = null }) {
  const id = sessionId(n)
  const projectDir = join(CLAUDE_DIR, 'projects', repoPath(repo).replaceAll('/', '-'))
  mkdirSync(join(projectDir, id, 'subagents'), { recursive: true })
  const transcript = new Transcript(join(projectDir, `${id}.jsonl`), { cwd: repoPath(repo), branch, session: id, model: OPUS, alsoUses })
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
  mkdirSync(repoPath(ATLAS, '.git'), { recursive: true })
  for (const pkg of ATLAS_PACKAGES) {
    mkdirSync(repoPath(ATLAS, pkg, 'src'), { recursive: true })
    writeFileSync(repoPath(ATLAS, pkg, 'package.json'), '{}')
  }
}

// The monorepo demo: every session starts at the repository's root and works in its packages.
function writeMonorepo() {
  const at = (pkg, file) => `${pkg}/src/${file}`

  // 1. Search, across three packages, with helpers.
  const search = createSession({ n: 1, title: 'Unified search', repo: ATLAS, branch: 'feat/unified-search', alsoUses: SONNET })
  search.transcript.prompt(70)
  search.transcript.tool(66, STEPS.read(ATLAS, at('services/search', 'index.ts')))
  search.transcript.tool(60, STEPS.edit(ATLAS, at('services/search', 'ranking.ts')))
  const indexer = search.subagent({ minutesAgo: 55, description: 'Index the product catalogue', agentType: 'general-purpose' })
  indexer.tool(50, STEPS.write(ATLAS, at('services/search', 'indexer.ts')))
  const bar = search.subagent({ minutesAgo: 45, description: 'Build the search bar', agentType: 'general-purpose' })
  bar.tool(40, STEPS.edit(ATLAS, at('apps/web', 'SearchBar.tsx')))
  search.transcript.tool(2, STEPS.grep(ATLAS))
  running.push(
    { transcript: search.transcript, repo: ATLAS, files: [at('services/search', 'ranking.ts'), at('services/search', 'query.ts')] },
    { transcript: indexer, repo: ATLAS, files: [at('services/search', 'indexer.ts')], lead: search.id },
    { transcript: bar, repo: ATLAS, files: [at('apps/web', 'SearchBar.tsx'), at('apps/web', 'results.tsx')], lead: search.id },
  )

  // 2. Asked you a question.
  const invoices = createSession({ n: 2, title: 'Invoice PDFs', repo: ATLAS, branch: 'feat/invoice-pdf' })
  invoices.transcript.prompt(30)
  invoices.transcript.tool(25, STEPS.read(ATLAS, at('services/billing', 'invoice.ts')))
  invoices.transcript.question(8)

  // 3. Running, with a helper in the shared UI package.
  const roles = createSession({ n: 3, title: 'Admin roles page', repo: ATLAS, branch: 'feat/admin-roles' })
  roles.transcript.prompt(35)
  roles.transcript.tool(30, STEPS.edit(ATLAS, at('apps/admin', 'Roles.tsx')))
  const table = roles.subagent({ minutesAgo: 20, description: 'Sortable table component', agentType: 'general-purpose' })
  table.tool(15, STEPS.edit(ATLAS, at('packages/ui', 'Table.tsx')))
  roles.transcript.tool(1, STEPS.bash(ATLAS))
  running.push(
    { transcript: roles.transcript, repo: ATLAS, files: [at('apps/admin', 'Roles.tsx')] },
    { transcript: table, repo: ATLAS, files: [at('packages/ui', 'Table.tsx'), at('packages/ui', 'Table.test.tsx')], lead: roles.id },
  )

  // 4. Finished, waiting on you.
  const push = createSession({ n: 4, title: 'Mobile push notifications', repo: ATLAS, branch: 'feat/push' })
  push.transcript.prompt(50)
  push.transcript.tool(45, STEPS.write(ATLAS, at('apps/mobile', 'push.ts')))
  push.transcript.endTurn(20)

  // 5. Running in the API.
  const limits = createSession({ n: 5, title: 'API rate limits', repo: ATLAS, branch: 'feat/rate-limits' })
  limits.transcript.prompt(25)
  limits.transcript.tool(3, STEPS.read(ATLAS, at('services/api', 'limits.ts')))
  running.push({ transcript: limits.transcript, repo: ATLAS, files: [at('services/api', 'limits.ts'), at('services/api', 'routes.ts')] })

  // 6. Finished a while ago.
  const tokens = createSession({ n: 6, title: 'Design tokens v2', repo: ATLAS, branch: 'feat/tokens-v2' })
  tokens.transcript.prompt(160)
  tokens.transcript.tool(150, STEPS.edit(ATLAS, at('packages/ui', 'tokens.ts')))
  tokens.transcript.tool(140, STEPS.bash(ATLAS))

  // 7. Joins and leaves Your turn now and then.
  const lint = createSession({ n: 7, title: 'Lint config bump', repo: ATLAS, branch: 'chore/lint' })
  lint.transcript.prompt(12)
  lint.transcript.tool(1, STEPS.edit(ATLAS, at('packages/config', 'eslint.js')))
  running.push({ transcript: lint.transcript, repo: ATLAS, files: [at('packages/config', 'eslint.js')], waitsOnYou: true })

  return [search, invoices, roles]
}

function writeSessions() {
  // 1. A big session in the web app, mid-flight, with helpers in three repos.
  const checkout = createSession({ n: 1, title: 'Checkout redesign', repo: 'storefront-web', branch: 'feat/checkout-redesign', alsoUses: SONNET })
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
    { transcript: flaky.transcript, repo: 'mobile-app', files: ['test/login.test.ts', 'src/auth/session.ts'], waitsOnYou: true },
    { transcript: logs, repo: 'mobile-app', files: ['ci/logs/run-4812.txt'] },
  )

  // 5. Finished a while ago, still waiting on you.
  const drift = createSession({ n: 5, title: 'Terraform drift check', repo: 'infra', branch: 'chore/drift' })
  drift.transcript.prompt(165)
  drift.transcript.tool(150, STEPS.bash('infra'))
  drift.transcript.endTurn(140)

  // 6. Quiet: a shell call left open for eight minutes, as when Claude waits for your approval.
  const migration = createSession({ n: 6, title: 'Backfill order totals', repo: 'storefront-api', branch: 'fix/order-totals' })
  migration.transcript.prompt(30)
  migration.transcript.tool(24, STEPS.read('storefront-api', 'src/orders/totals.ts'))
  migration.transcript.tool(16, STEPS.edit('storefront-api', 'src/orders/totals.ts'))
  migration.transcript.openTool(8, STEPS.bash('storefront-api'))

  // 7. Earlier today: asked a question, was answered, finished, then went on with a follow-up.
  const onboarding = createSession({ n: 7, title: 'Onboarding emails', repo: 'mobile-app', branch: 'feat/onboarding-emails' })
  onboarding.transcript.prompt(178)
  onboarding.transcript.tool(175, STEPS.read('mobile-app', 'src/emails/welcome.ts'))
  onboarding.transcript.question(172)
  onboarding.transcript.prompt(165)
  onboarding.transcript.tool(160, STEPS.edit('mobile-app', 'src/emails/welcome.ts'))
  onboarding.transcript.endTurn(150)
  onboarding.transcript.prompt(120)
  onboarding.transcript.tool(112, STEPS.write('mobile-app', 'src/emails/reminder.ts'))
  onboarding.transcript.tool(100, STEPS.bash('mobile-app'))

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
const WAIT_EVERY_TICKS = 12
let ticks = 0
let flakyWaiting = false

// Every so often the flaky-test session finishes and waits on you, then you "reply" and it
// carries on, so the demo shows a session joining and leaving Your turn.
function toggleFlakyWait() {
  const flaky = running.find((agent) => agent.waitsOnYou)
  if (flakyWaiting) flaky.transcript.prompt(0)
  else flaky.transcript.endTurn(0)
  flakyWaiting = !flakyWaiting
}

// Keeps the running agents busy so the orbs change and messages travel.
function tick() {
  ticks += 1
  if (ticks % WAIT_EVERY_TICKS === 0) {
    toggleFlakyWait()
    return
  }
  const busy = running.filter((agent) => !(flakyWaiting && agent.waitsOnYou))
  const agent = busy[Math.floor(Math.random() * busy.length)]
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
const sessions = MONOREPO ? writeMonorepo() : writeSessions()
writeLibrary(sessions)

const server = spawn(process.execPath, [SERVER], {
  stdio: 'inherit',
  env: { ...process.env, AGENT_ORRERY_PORT: PORT, AGENT_ORRERY_CLAUDE_DIR: CLAUDE_DIR },
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
