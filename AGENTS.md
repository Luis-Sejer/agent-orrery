# Working on Agent Orrery

Read this before changing code. To install it rather than change it, follow `INSTALL.md`.

## What it is

A read-only, local dashboard of Claude Code sessions. It has two halves:

- **Server** (`server.mjs`, `graph.mjs`, `repos.mjs`, `library.mjs`): plain Node, no runtime dependencies. It follows the transcripts in `~/.claude/projects/` with file events (plus a check every 5 seconds, because events through Docker's file sharing can go missing) and pushes a graph to the page over server-sent events. It also serves plans (`~/.claude/plans`) and memory notes (`~/.claude/projects/*/memory`) read-only.
- **Page** (`web/`): React, React Flow and `thinking-orbs`, built by Vite into `web/dist`. The server serves only files listed from `web/dist` at start-up.

## Commands

```bash
pnpm install       # pnpm only; never npm or yarn
pnpm test          # server tests (node --test) and page tests (Vitest)
pnpm typecheck     # page types
pnpm build         # page into web/dist
pnpm start         # server on http://127.0.0.1:4777
pnpm dev           # Vite with hot reload, proxying to a running `pnpm start`
pnpm demo          # build, then serve made-up sessions on http://127.0.0.1:4780
pnpm screenshots   # retake the README screenshots from the demo (needs Chrome)
docker compose up -d --build   # the always-on install; rebuild after every change
```

The server lists `web/dist` once at start-up. Restart it after `pnpm build`, or the page asks for files it doesn't know.

## Rules that keep it safe

Transcripts hold people's code, prompts and secrets, and local dashboards are a common way to leak them. Don't weaken these rules, and add a test when you touch one.

1. **The graph carries metadata only.** Titles, repo names, branch, agent type, tool names, file basenames and times. Never message text, commands, tool inputs or outputs. `graph.test.mjs` checks that a planted `SECRET` never reaches the snapshot or timeline.
2. **Loopback only.** Bind `127.0.0.1` outside Docker; compose publishes on `127.0.0.1` only.
3. **`isTrustedRequest` guards every request.** Host must be loopback (stops DNS rebinding), Origin must be ours, and `Sec-Fetch-Site` must be same-origin. The one exception is a top-level page load, which another site can't read. Only `GET` is accepted.
4. **Files are read by listed names only.** Plans and notes are opened by a name taken from our own directory listing, never by a path from the request.
5. **No HTML from content.** Markdown renders with `skipHtml`, no images, and web links open in a new tab. Transcript text goes through React or `textContent`, never `innerHTML`.
6. **Strict Content Security Policy.** Scripts, styles and fonts come from the server only. Don't add CDNs or Google Fonts; bundle assets instead.
7. **Supply chain.** Pin exact versions. `pnpm-workspace.yaml` skips releases younger than seven days. Front-end packages are `devDependencies`, and the server keeps zero runtime dependencies. Docker base images are pinned by digest.
8. **No hooks.** It reads what Claude Code already writes, so it can't slow Claude down.

## How the data works

- A **session** is `~/.claude/projects/<project>/<id>.jsonl`. Its **subagents** are `<id>/subagents/agent-<agentId>.jsonl`, plus a `.meta.json` with the description, agent type and the spawning `toolUseId`.
- A transcript's `cwd` is always where the session started, even for subagents working elsewhere. An agent's **room** is the repository its tool paths touch most (`repos.mjs` walks up to the nearest `.git`, mapping worktrees to their repo). A session's room is where it started.
- **Monorepos:** within a repository, the outermost folder below the root that holds a project manifest is an **area**, and the room key becomes `repo › area` (`AREA_SEPARATOR`). An `.orrery.json` at the root (`{"areas": ["apps/*"]}`) names areas instead. `collapseAreas` in `graph.mjs` folds a repository back into one room unless two or more of its areas are busy, and a session started at a root takes the area it worked in most. Try it with `pnpm demo --monorepo`.
- **Waiting on you** means the last assistant message ended its turn (`stop_reason: end_turn`) or called `AskUserQuestion`. A later non-meta user record clears it.
- **Usage** is counted once per API `message.id` and kept per model on each node (token counts only). Cost is worked out in the page from `web/src/pricing.ts`; update that table when Anthropic changes prices.
- **Quiet** is a tool call with no result yet (`pendingTool`) plus five minutes without activity (`isQuiet` in `status.ts`). The server tracks open calls by `tool_use` id; a result or a new human prompt closes them.
- **Replay** reads a per-node history of state changes (`[at, activity, waiting reason, last tool, last record]`, 400 entries) and `firstAt` on nodes and message edges. `replay()` in `graph.mjs` rebuilds a node view at a time and reuses `snapshot()` for visibility. Usage and open tool calls are not replayed.
- **Messages** between agents come from `SendMessage` tool calls (outgoing) and user records with `origin.kind === 'peer'` (incoming).
- **Orb states** come from the last tool an agent used (`ACTIVITY_BY_TOOL` in `graph.mjs`). Shell commands are classified by `shellActivity`: readers turn blue, writers violet, everything else green. Only the state is kept.
- **Search** (`/api/search`) scans plan and memory-note text on the server and returns short snippets; agents are matched in the browser.
- **Dismissals, theme and the notifications and voice switches** live in the browser's localStorage only. Voice uses on-device speech voices only, so titles never reach a speech service. Notifications come from the open tab, never a service worker, and only for waits that start after the page loaded.

## Style

Match the code around you: small functions, constants for magic numbers, and comments only for why. The look: Instrument Serif for headings, Inter for text, green `#34955f` and ink `#162925`, tonal surfaces without borders, an 8 px radius (3 px for chips), and dashed orbit rings for sessions. The T.Y.C.H.O. theme sets `data-theme="dark"` plus `data-hud` on `<html>`, so it inherits every dark style; its overrides live under `:root[data-hud]`. Check UI changes in a real browser before calling them done; `pnpm demo` gives you data to look at.

Never commit real transcripts, session names or screenshots of real sessions. Use the demo data (`scripts/demo.mjs`) for examples, tests and screenshots.
