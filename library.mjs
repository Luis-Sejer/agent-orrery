// Read-only access to the plans and memory notes Claude Code keeps under ~/.claude.
// A file is only ever read by a name taken from our own directory listing, never from the
// request, so a crafted name can't reach anything outside these folders.

import { open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

const MARKDOWN_FILE = /^[\w.-]+\.md$/
const CWD_IN_TRANSCRIPT = /"cwd":"([^"]+)"/
const TRANSCRIPT_HEAD_BYTES = 64 * 1024
const MEMORY_INDEX = 'MEMORY.md'

async function listMarkdown(directory) {
  const names = await readdir(directory).catch(() => [])
  const files = []
  for (const name of names.filter((entry) => MARKDOWN_FILE.test(entry))) {
    const info = await stat(join(directory, name)).catch(() => null)
    if (info?.isFile()) files.push({ name, modifiedAt: info.mtimeMs })
  }
  return files.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

function titleOf(content, fallback) {
  const heading = content.match(/^#\s+(.+)$/m)
  return heading ? heading[1].trim() : fallback
}

function frontmatterField(content, field) {
  const block = content.match(/^---\n([\s\S]*?)\n---/)
  const line = block?.[1].match(new RegExp(`^${field}:\\s*(.+)$`, 'm'))
  if (!line) return null
  const value = line[1].trim()
  // YAML strings are often quoted; show the text, not the quoting.
  const quoted = value.match(/^"(.*)"$/) ?? value.match(/^'(.*)'$/)
  return quoted ? quoted[1].replace(/\\"/g, '"') : value
}

// Memory names are slugs (feedback_no_gui_apps); show them as words.
function humanise(slug) {
  const words = slug.replace(/\.md$/, '').replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function createLibrary({ claudeDir }) {
  const plansDir = join(claudeDir, 'plans')
  const projectsDir = join(claudeDir, 'projects')
  const repoLabels = new Map()

  // A memory folder is named after a mangled path; the cwd in one of its transcripts names it properly.
  async function projectLabel(project) {
    if (repoLabels.has(project)) return repoLabels.get(project)
    let label = project
    const names = await readdir(join(projectsDir, project)).catch(() => [])
    const transcript = names.find((name) => name.endsWith('.jsonl'))
    if (transcript) {
      const handle = await open(join(projectsDir, project, transcript), 'r').catch(() => null)
      if (handle) {
        const buffer = Buffer.alloc(TRANSCRIPT_HEAD_BYTES)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        await handle.close()
        const cwd = buffer.subarray(0, bytesRead).toString('utf8').match(CWD_IN_TRANSCRIPT)?.[1]
        if (cwd) label = basename(cwd)
      }
    }
    repoLabels.set(project, label)
    return label
  }

  async function listPlans() {
    const files = await listMarkdown(plansDir)
    return Promise.all(
      files.map(async (file) => {
        const content = await readFile(join(plansDir, file.name), 'utf8').catch(() => '')
        return { ...file, title: titleOf(content, file.name.replace(/\.md$/, '')) }
      }),
    )
  }

  async function readPlan(name) {
    const listed = (await listMarkdown(plansDir)).some((file) => file.name === name)
    if (!listed) return null
    const content = await readFile(join(plansDir, name), 'utf8')
    return { name, title: titleOf(content, name), content }
  }

  async function listMemory() {
    const projects = await readdir(projectsDir).catch(() => [])
    const result = []
    for (const project of projects) {
      const files = await listMarkdown(join(projectsDir, project, 'memory'))
      if (files.length === 0) continue
      const notes = await Promise.all(
        files.map(async (file) => {
          const content = await readFile(join(projectsDir, project, 'memory', file.name), 'utf8').catch(() => '')
          const title = file.name === MEMORY_INDEX ? 'Index' : humanise(frontmatterField(content, 'name') ?? file.name)
          return { ...file, title, description: frontmatterField(content, 'description') }
        }),
      )
      notes.sort((a, b) => (a.name === MEMORY_INDEX ? -1 : b.name === MEMORY_INDEX ? 1 : b.modifiedAt - a.modifiedAt))
      result.push({ project, label: await projectLabel(project), notes })
    }
    return result.sort((a, b) => b.notes.length - a.notes.length)
  }

  async function readMemory(project, name) {
    const projects = await readdir(projectsDir).catch(() => [])
    if (!projects.includes(project)) return null
    const directory = join(projectsDir, project, 'memory')
    const listed = (await listMarkdown(directory)).some((file) => file.name === name)
    if (!listed) return null
    const content = await readFile(join(directory, name), 'utf8')
    return { project, name, content }
  }

  return { plansDir, listPlans, readPlan, listMemory, readMemory }
}
