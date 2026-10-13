// Works out which git repository a path belongs to, so an agent can be shown where it
// actually works rather than where its session started. In a monorepo it also names the area:
// the package or app the path sits in ("shop › apps/web").

import { closeSync, constants, existsSync, fstatSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const WORKTREE_MARKER = '/.claude/worktrees/'
// Longer than any real path; checking a longer one would only cost time.
const MAX_PATH = 4096
const MAX_CACHED = 50_000
// Repository names never contain it, so a room key splits back into repository and area.
export const AREA_SEPARATOR = ' › '
// Between a repository and one of its worktrees' branches. The page folds worktrees into their
// repository unless you ask for them as rooms of their own.
export const WORKTREE_SEPARATOR = ' ⎇ '
// A folder holding one of these, below the repository root, is a package or app of its own.
const MANIFESTS = ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'project.json']
// An optional file at the repository root that names the areas instead: {"areas": ["apps/*", "infra"]}.
const AREAS_FILE = '.orrery.json'
// Any of these at a root makes it one project, whatever its subfolders hold.
const ROOT_MANIFESTS = [...MANIFESTS, 'Package.swift', 'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'setup.py', 'requirements.txt', 'mix.exs', 'deno.json']
// Without a manifest or workspace at its root, a repository is a monorepo once it holds this many packages.
const MIN_PACKAGES = 2
// Files at a root that declare a workspace of several packages.
const WORKSPACE_FILES = ['go.work', 'nx.json', 'turbo.json', 'lerna.json', 'rush.json']
// Folders of installed dependencies: whatever is inside belongs to the repository that holds them,
// even a dependency that came with its own .git.
const DEPENDENCIES = new Set(['node_modules', 'bower_components', 'vendor', 'Pods', '.venv', 'venv', 'site-packages'])
// Folders of dependencies and build output: never packages of the repository itself.
const NOT_AREAS = new Set([
  'node_modules', 'bower_components', 'vendor', 'Pods', '.venv', 'venv', 'site-packages', '__pycache__',
  'target', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.turbo', '.cache', '.gradle', '.git',
])
const PATH_FIELDS = ['file_path', 'path', 'notebook_path']
const TRAILING_PUNCTUATION = /[.,:;!?]+$/
const ABSOLUTE_PATH_IN_COMMAND = /(?:^|[\s'"=(])((?:~|\/)[^\s'"`;|&<>()]+)/g

// The area patterns from a repository's .orrery.json, or null to use manifests.
// Repositories are whatever a transcript names, so a config file in one may be hostile: a FIFO that
// never answers, a symlink to /dev/zero, or a huge file. Only a small, regular file is read, opened
// without blocking.
const MAX_CONFIG_BYTES = 256 * 1024

function readText(path) {
  let fd = null
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const info = fstatSync(fd)
    return info.isFile() && info.size <= MAX_CONFIG_BYTES ? readFileSync(fd, 'utf8') : ''
  } catch {
    return ''
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

const isDirectory = (path) => statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false

function readAreaPatterns(checkout) {
  try {
    const areas = JSON.parse(readText(join(checkout, AREAS_FILE))).areas
    return Array.isArray(areas) ? areas.filter((area) => typeof area === 'string').map((area) => area.split('/').filter(Boolean)) : null
  } catch {
    return null
  }
}

// Folders below the root, one or two levels down, that hold a manifest.
function countPackages(root) {
  const folders = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !NOT_AREAS.has(entry.name))
        .map((entry) => join(dir, entry.name))
    } catch {
      return []
    }
  }
  const hasManifest = (dir) => MANIFESTS.some((name) => existsSync(join(dir, name)))
  let count = 0
  for (const child of folders(root)) count += hasManifest(child) ? 1 : folders(child).filter(hasManifest).length
  return count
}

// A monorepo says so at its root: a workspace of packages, or no project of its own and several
// packages side by side. A single project whose dependencies or tools have manifests is not one.
function isMonorepo(root) {
  if (WORKSPACE_FILES.some((name) => existsSync(join(root, name)))) return true
  // pnpm-workspace.yaml also holds plain settings; only a packages list makes a workspace.
  if (/^packages:/m.test(readText(join(root, 'pnpm-workspace.yaml')))) return true
  if (/^\[workspace\]/m.test(readText(join(root, 'Cargo.toml')))) return true
  try {
    if (JSON.parse(readText(join(root, 'package.json'))).workspaces) return true
  } catch {
    // No package.json, or not JSON: the manifest check below decides.
  }
  if (ROOT_MANIFESTS.some((name) => existsSync(join(root, name)))) return false
  return countPackages(root) >= MIN_PACKAGES
}

// The first pattern that matches the start of a path names its area; "*" stands for one folder.
function matchArea(patterns, segments) {
  for (const pattern of patterns) {
    if (pattern.length <= segments.length && pattern.every((part, index) => part === '*' || part === segments[index])) {
      return segments.slice(0, pattern.length).join('/')
    }
  }
  return null
}

export function createRepoResolver(home = homedir()) {
  const repos = new Map()
  const areas = new Map()
  const patterns = new Map()
  const monorepos = new Map()
  // Every path an agent names lands in these caches, so they start over once they grow large;
  // that also picks up edited .orrery.json and workspace files.
  const forgetIfLarge = () => {
    if (repos.size + areas.size < MAX_CACHED) return
    for (const cache of [repos, areas, patterns, monorepos]) cache.clear()
  }

  // The repository a directory is in, as its name and root folder.
  function repoOf(start) {
    const visited = []
    let repo = null
    let directory = start
    while (directory.length > 1 && directory !== home) {
      if (repos.has(directory)) {
        repo = repos.get(directory)
        break
      }
      visited.push(directory)
      if (existsSync(join(directory, '.git'))) {
        repo = { name: basename(directory), root: directory }
        break
      }
      directory = dirname(directory)
    }
    for (const seen of visited) repos.set(seen, repo)
    return repo
  }

  // The area a path is in within a checkout (the repository, or one of its worktrees), or null at its root.
  function areaOf(path, checkout) {
    if (!patterns.has(checkout)) patterns.set(checkout, readAreaPatterns(checkout))
    const named = patterns.get(checkout)
    const segments = relative(checkout, path).split('/')
    // A named area must be a folder that exists, so text after a path in a command can't become a room.
    if (named) {
      const area = matchArea(named, segments)
      return area && isDirectory(join(checkout, area)) ? area : null
    }
    if (!monorepos.has(checkout)) monorepos.set(checkout, isMonorepo(checkout))
    if (!monorepos.get(checkout)) return null
    // Look only above any dependency or build folder, and let the outermost manifest below the root
    // win, so fixtures and nested packages stay inside the package that holds them.
    const cut = segments.findIndex((segment) => NOT_AREAS.has(segment))
    const start = cut === -1 ? path : join(checkout, ...segments.slice(0, cut))
    let area = null
    for (let directory = start; directory.startsWith(checkout + '/'); directory = dirname(directory)) {
      if (!areas.has(directory)) areas.set(directory, MANIFESTS.some((name) => existsSync(join(directory, name))))
      if (areas.get(directory)) area = relative(checkout, directory)
    }
    return area
  }

  return function resolveRepo(file) {
    forgetIfLarge()
    const dependencyAt = file.split('/').findIndex((segment) => DEPENDENCIES.has(segment))
    const path = dependencyAt === -1 ? file : file.split('/').slice(0, dependencyAt).join('/')
    const worktreeAt = path.indexOf(WORKTREE_MARKER)
    const repo = repoOf(worktreeAt === -1 ? path : path.slice(0, worktreeAt))
    if (!repo) return null
    if (worktreeAt === -1) {
      const area = areaOf(path, repo.root)
      return area ? `${repo.name}${AREA_SEPARATOR}${area}` : repo.name
    }
    // A worktree belongs to the repository it was made from. Its root is the folder holding its .git
    // file, however many folders its branch name spans ("feat/font-registry"); areas are measured from
    // there, and the branch rides along so the page can give the worktree a room of its own.
    const worktrees = path.slice(0, worktreeAt + WORKTREE_MARKER.length)
    const checkout = repoOf(path)
    if (!checkout?.root.startsWith(worktrees)) return repo.name
    const name = `${repo.name}${WORKTREE_SEPARATOR}${checkout.root.slice(worktrees.length)}`
    const area = areaOf(path, checkout.root)
    return area ? `${name}${AREA_SEPARATOR}${area}` : name
  }
}

function expandHome(path, home) {
  return path.startsWith('~/') ? join(home, path.slice(2)) : path
}

// Paths a tool call names: its path fields, plus absolute paths written in a shell command.
export function pathsInToolInput(input, cwd, home = homedir()) {
  const paths = []
  for (const field of PATH_FIELDS) {
    const value = input?.[field]
    if (typeof value !== 'string' || !value) continue
    const expanded = expandHome(value, home)
    paths.push(isAbsolute(expanded) || !cwd ? expanded : resolve(cwd, expanded))
  }
  if (typeof input?.command === 'string') {
    for (const match of input.command.matchAll(ABSOLUTE_PATH_IN_COMMAND)) {
      // A path at the end of a sentence in a command (an echo, a heredoc) keeps its full stop.
      paths.push(expandHome(match[1].replace(TRAILING_PUNCTUATION, ''), home))
    }
  }
  return paths.filter((path) => isAbsolute(path) && path.length <= MAX_PATH)
}
