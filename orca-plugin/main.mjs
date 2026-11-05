// Gives each Orca workspace you visit Agent Orrery in a browser split on the right. Orca's browser
// tabs belong to one worktree, so there is no single tab that stays across workspaces; this opens
// one per workspace instead, once, and never again in a workspace where you closed it.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

const ORRERY = 'http://127.0.0.1:4777'
const APP_CLI = '/Applications/Orca.app/Contents/Resources/bin/orca'
const CLI = existsSync(APP_CLI) ? APP_CLI : 'orca'

function orca(args) {
  return new Promise((resolve, reject) => {
    execFile(CLI, [...args, '--json'], { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${args.slice(0, 2).join(' ')}: ${(stdout || stderr).slice(0, 400)}`))
      try { resolve(JSON.parse(stdout).result) } catch (parseError) { reject(parseError) }
    })
  })
}

// Workspaces given a tab since the worker started, by path. Closing the tab in one of them is
// respected; a restart of Orca checks again.
const opened = new Set()
// Checks run one at a time, so two quick events can't both open a tab.
let queue = Promise.resolve()

const shortBranch = (branch) => (branch ?? '').replace(/^refs\/heads\//, '')

// The focused context has no path: find it through one of its terminals, or else through a workspace
// whose name and branch match it alone (names like "main" repeat across repositories).
async function focusedPath(host, context) {
  const ids = new Set(context.terminals.map((terminal) => terminal.id))
  if (ids.size > 0) {
    const { terminals } = await orca(['terminal', 'list'])
    const own = terminals.find((t) => [t.handle, t.handle?.replace(/^term_/, ''), t.ptyId, t.tabId, t.leafId].some((id) => ids.has(id)))
    if (own) return own.worktreePath
  }
  const { workspaces } = await host.host.call('workspace.list')
  const matches = workspaces.filter((w) => !w.hostId || w.hostId === 'local')
    .filter((w) => w.name === context.displayName && shortBranch(w.branch) === shortBranch(context.branch))
  return matches.length === 1 ? matches[0].path : null
}

async function ensureOrrery(host, context, log) {
  const path = await focusedPath(host, context)
  if (!path || opened.has(path)) return
  const worktree = `path:${path}`
  const { tabs } = await orca(['tab', 'list', '--worktree', worktree])
  opened.add(path)
  if (JSON.stringify(tabs).includes('127.0.0.1:4777')) return
  await orca(['tab', 'create', '--url', ORRERY, '--split', 'right', '--worktree', worktree])
  log(`opened in ${path}`)
}

export default function activate(host) {
  const log = (message) => console.log(`[agent-orrery] ${message}`)
  // Fires on focus changes and terminal changes alike; the set makes the repeats cheap.
  host.events.on('workspace.changed', ({ context }) => {
    if (!context) return
    queue = queue.then(() => ensureOrrery(host, context, log)).catch((error) => log(`could not open: ${error.message}`))
  })
}
