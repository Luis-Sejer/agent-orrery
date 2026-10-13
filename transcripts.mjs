// Where Claude Code writes a session's agents: subagents beside it, and the agents of each workflow
// it ran, one folder per run.
//
//   <session>/subagents/agent-<id>.jsonl
//   <session>/subagents/workflows/<run>/agent-<id>.jsonl
//
// Each has a .meta.json beside it. Only names from these listings are ever opened.

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const AGENT_FILE = /^agent-([\w-]{1,100})\.jsonl$/
const WORKFLOWS = 'workflows'

export async function listDir(path) {
  return readdir(path).catch(() => [])
}

// Every agent transcript of a session: [{ path, metaPath, agentId }].
export async function agentTranscripts(sessionDir) {
  const subagents = join(sessionDir, 'subagents')
  const folders = [subagents, ...(await listDir(join(subagents, WORKFLOWS))).map((run) => join(subagents, WORKFLOWS, run))]
  const found = []
  for (const folder of folders) {
    for (const name of await listDir(folder)) {
      const agentId = name.match(AGENT_FILE)?.[1]
      if (agentId) found.push({ path: join(folder, name), metaPath: join(folder, `agent-${agentId}.meta.json`), agentId })
    }
  }
  return found
}
