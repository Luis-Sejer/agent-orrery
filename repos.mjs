// Works out which git repository a path belongs to, so an agent can be shown where it
// actually works rather than where its session started. In a monorepo it also names the area:
// the package or app the path sits in ("shop › apps/web").

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const WORKTREE_MARKER = '/.claude/worktrees/'
// Repository names never contain it, so a room key splits back into repository and area.
export const AREA_SEPARATOR = ' › '
// Between a repository and one of its worktrees' branches. The page folds worktrees into their
// repository unless you ask for them as rooms of their own.
export const WORKTREE_SEPARATOR = ' ⎇ '
// A folder holding one of these, below the repository root, is a package or app of its own.
const MANIFESTS = ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'project.json']
// An optional file at the repository root that names the areas instead: {"areas": ["apps/*", "infra"]}.
const AREAS_FILE = '.orrery.json'
const PATH_FIELDS = ['file_path', 'path', 'notebook_path']
const TRAILING_PUNCTUATION = /[.,:;!?]+$/
const ABSOLUTE_PATH_IN_COMMAND = /(?:^|[\s'"=(])((?:~|\/)[^\s'"`;|&<>()]+)/g

// The area patterns from a repository's .orrery.json, or null to use manifests.
function readAreaPatterns(checkout) {
  try {
    const areas = JSON.parse(readFileSync(join(checkout, AREAS_FILE), 'utf8')).areas
    return Array.isArray(areas) ? areas.filter((area) => typeof area === 'string').map((area) => area.split('/').filter(Boolean)) : null
  } catch {
    return null
  }
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
    if (named) return matchArea(named, relative(checkout, path).split('/'))
    // The outermost manifest below the root wins, so node_modules, fixtures and nested packages
    // stay inside the package that holds them.
    let area = null
    for (let directory = path; directory.startsWith(checkout + '/'); directory = dirname(directory)) {
      if (!areas.has(directory)) areas.set(directory, MANIFESTS.some((name) => existsSync(join(directory, name))))
      if (areas.get(directory)) area = relative(checkout, directory)
    }
    return area
  }

  return function resolveRepo(path) {
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
  return paths.filter((path) => isAbsolute(path))
}
