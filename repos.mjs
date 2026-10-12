// Works out which git repository a path belongs to, so an agent can be shown where it
// actually works rather than where its session started.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const WORKTREE_MARKER = '/.claude/worktrees/'
const PATH_FIELDS = ['file_path', 'path', 'notebook_path']
const TRAILING_PUNCTUATION = /[.,:;!?]+$/
const ABSOLUTE_PATH_IN_COMMAND = /(?:^|[\s'"=(])((?:~|\/)[^\s'"`;|&<>()]+)/g

export function createRepoResolver(home = homedir()) {
  const cache = new Map()
  return function resolveRepo(path) {
    // A worktree belongs to the repository it was made from.
    const worktreeAt = path.indexOf(WORKTREE_MARKER)
    let directory = worktreeAt === -1 ? path : path.slice(0, worktreeAt)
    const visited = []
    let repo = null
    while (directory.length > 1 && directory !== home) {
      if (cache.has(directory)) {
        repo = cache.get(directory)
        break
      }
      visited.push(directory)
      if (existsSync(join(directory, '.git'))) {
        repo = basename(directory)
        break
      }
      directory = dirname(directory)
    }
    for (const seen of visited) cache.set(seen, repo)
    return repo
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
