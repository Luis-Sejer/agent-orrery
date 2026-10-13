# Working on Agent Orrery

Read this before changing code. To install it rather than change it, follow `INSTALL.md`.

## What it is

A local dashboard of Claude Code sessions that only reads Claude Code's files and your code. The one thing it writes is its own state (settings and dismissed sessions) in its data folder. It has two halves:

- **Server** (`server.mjs`, `graph.mjs`, `repos.mjs`, `library.mjs`, `store.mjs`, `artifacts.mjs`): plain Node, no runtime dependencies. It follows the transcripts in `~/.claude/projects/` and the status files in `~/.claude/sessions/` with file events (plus a check every 5 seconds, because events through Docker's file sharing can go missing) and pushes a graph to the page over server-sent events. It also serves plans (`~/.claude/plans`) and memory notes (`~/.claude/projects/*/memory`) read-only.
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

1. **The graph carries metadata only.** Titles, repo names, branch, agent type, tool names, file basenames and times. Never message text, commands, tool inputs or outputs. The exceptions are a published artifact's title (from the call's `title` or file name) and its claude.ai address, taken from the reply only with `ARTIFACT_URL`, a strict pattern. `graph.test.mjs` checks that a planted `SECRET` never reaches the snapshot or timeline.
2. **Loopback only.** Bind `127.0.0.1` outside Docker; compose publishes on `127.0.0.1` only.
3. **`isTrustedRequest` guards every request.** Host must be loopback (stops DNS rebinding), Origin must be ours, and `Sec-Fetch-Site` must be same-origin. The one exception is a top-level page load, which another site can't read. Reads are `GET`. The only writes are `PATCH /api/settings` and `PATCH /api/dismissals`, and `isTrustedWrite` also requires our own `Origin` and a JSON body, which a form on another site can't send. `store.mjs` keeps only known settings with known values and sane dismissals, and writes nowhere but `AGENT_ORRERY_DATA_DIR`.
4. **Never write Claude Code's files or the user's code.** Every mount but the data folder is read-only in `compose.yaml`.
5. **Files are read by listed names only.** Plans and notes are opened by a name taken from our own directory listing, never by a path from the request.
6. **No HTML from content.** Markdown renders with `skipHtml`, no images, and web links open in a new tab. Transcript text goes through React or `textContent`, never `innerHTML`.
7. **Strict Content Security Policy.** Scripts, styles and fonts come from the server only. Don't add CDNs or Google Fonts; bundle assets instead.
8. **Supply chain.** Pin exact versions. `pnpm-workspace.yaml` skips releases younger than seven days. Front-end packages are `devDependencies`, and the server keeps zero runtime dependencies. Docker base images are pinned by digest.
9. **No hooks.** It reads what Claude Code already writes, so it can't slow Claude down.

## How the data works

- A **session** is `~/.claude/projects/<project>/<id>.jsonl`. Its **subagents** are `<id>/subagents/agent-<agentId>.jsonl`, plus a `.meta.json` with the description, agent type and the spawning `toolUseId`. A **workflow**'s agents are one folder deeper, `<id>/subagents/workflows/<run>/agent-<agentId>.jsonl`, with a `workflowPhase` and no `toolUseId`, so they hang off the session; `agentTranscripts` in `transcripts.mjs` lists both. A **fork** (`isFork` in the meta) starts its transcript with a copy of the parent message that spawned it; `isCopiedSpawn` in `graph.mjs` skips it, or the fork would claim its own spawn and count the parent's tokens.
- **Live status:** each running Claude Code process writes `~/.claude/sessions/<pid>.json` with `sessionId`, `status` (`busy`: a turn or background agents running; `shell`: a background command; `idle`; `waiting`) and, while waiting, `waitingFor` (`input needed`, `permission prompt`, `dialog open` and others), and deletes it on exit. `readLiveSessions` in `server.mjs` opens only files named `<pid>.json` (the folder also holds secret key files) and skips dead pids where it can check them; `setLive` in `graph.mjs` maps `waitingFor` to a reason (`question`, `permission`, `dialog`) so the raw text never leaves the server, and gives each session `live` (null when unknown, `{ status: 'closed' }` once it has ended). Where `live` is set it decides (`settleLive` in `status.ts`, `liveWait` in `graph.mjs`); the transcript guesses below apply only without it.
- A transcript's `cwd` is always where the session started, even for subagents working elsewhere. An agent's **room** is the repository its tool paths touch most (`repos.mjs` walks up to the nearest `.git`, mapping worktrees to their repo). A session's room is where it started.
- **Monorepos:** a repository is one when its root declares a workspace, or has no project of its own and two or more packages (`isMonorepo` in `repos.mjs`). Within one, the outermost folder below the root that holds a project manifest is an **area**, never inside `node_modules` or other dependency and build folders, and the room key becomes `repo › area` (`AREA_SEPARATOR`). An `.orrery.json` at the root (`{"areas": ["apps/*"]}`) names areas instead. `collapseAreas` in `graph.mjs` folds a repository back into one room unless two or more of its areas are busy, and a session started at a root takes the area it worked in most. Try it with `pnpm demo --monorepo`.
- **Waiting on you** means the last assistant message ended its turn (`stop_reason: end_turn`) or called `AskUserQuestion`. A later non-meta user record clears it. A session that ended its turn while subagents it started still run is waiting on them, not you (`awaitAgents` in `status.ts`, and `waitingSessions` for the menu bar).
- **Usage** is counted once per API `message.id` and kept per model on each node (token counts only). Cost is worked out in the page from `web/src/pricing.ts`; update that table when Anthropic changes prices.
- **Quiet** is a tool call with no result yet (`pendingTool`) plus five minutes without activity (`isQuiet` in `status.ts`). The server tracks open calls by `tool_use` id; a result or a new human prompt closes them.
- **Artifacts:** an `Artifact` call that publishes (no `action`, or `publish`, and not an asset upload) is kept by its id until its reply, whose first claude.ai artifact address names the page (`artifactCall`, `artifactUrlIn` and `settleArtifact` in `graph.mjs`). A republish keeps the page's title unless it gives a new one; a delete takes it off. Each node lists its own; `artifacts.mjs` finds them in every transcript Claude Code has kept, read once and then only what is new, for the Artifacts view (`/api/artifacts`) and search. The page links only addresses `isArtifactUrl` accepts and opens them in a new tab: claude.ai pages need your login and can't be shown inside Orrery.
- **Packets:** each node counts its tool calls (`toolCount`); `usePackets` in `web/src/usePackets.ts` compares the counts between pushes and gives a subagent's line (`SpawnEdge`) a packet per new call, three at most, timed by hand with `beginElement`, as SMIL times a late-added animation from the page's start. None in replay or when `prefersStill()`.
- **Forecast:** the server keeps the session window's readings, one a minute for an hour, in memory (`recordUsage`), and `forecast` in `server.mjs` fits a straight line through those of the current window: `perHour`, `atReset` and `limitAt` (null unless it hits 100 % before the reset). Nothing until it has ten minutes of readings.
- **Advanced settings:** `NUMBER_SETTINGS` in `store.mjs` (the two hour windows) are saved like the others and read with `store.number`; the server applies a change on the next pass (`onWrite` triggers discovery). Their environment variables are only defaults now.
- **Plan usage:** Claude Code gives the plan's limits (`rate_limits.five_hour` and `.seven_day`: `used_percentage`, `resets_at`) only to the status line, so `statusline/orrery-usage.sh`, which the user adds to theirs (INSTALL.md step 6), writes those fields alone to `~/.claude/orrery/usage.json`. `parseUsage` in `server.mjs` reads it on every tick (and on a file event), and the snapshot carries it as `usage`; `/api/usage` serves it to the menu bar. Never fetch usage from Anthropic or read credentials for it. `web/src/usage.ts` turns a window that has passed its reset back to 0 and names stale numbers.
- **Same files:** each node keeps the paths it edited (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`) for ten minutes. `collisions` in `graph.mjs` pairs agents in the same file: separate sessions within the window of each other, agents of one session only while their edits overlap, never a parent and its own subagent. Only basenames reach the page, in `snapshot().collisions`, which is live only (a replay has none).
- **Waiting on you, over time:** `youWaits` on a session holds `[start, end]` spans of waits you ended: a prompt after its turn ended, the answer to a question (written only once answered, with the question's own timestamp), or a status file leaving `waiting`. The page adds the open wait (`waitSpans` in `web/src/waits.ts`). `/api/day?since=` gives each session's working spans and its subagents' from the history below, for the Day view.
- **Settings and dismissals** live on the server, shared by every browser, in `<data dir>/state.json` (`store.mjs`); nothing is kept in browser storage. Settings nobody has changed take their defaults from `AGENT_ORRERY_*` variables (`SETTINGS` in `store.mjs`). The page gets the state in a `<meta name="agent-orrery-state">` tag, as a script would need the CSP loosened, saves each change with `PATCH`, and hears about changes from other pages as `state` events on `/events`. `web/src/settings.ts` is the page's side of it; `moveOldSettings` there carries settings an older version left in browser storage over to the server once, then deletes them. Without a writable data folder the state lasts until the server restarts.
- **Replay** reads a per-node history of state changes (`[at, activity, waiting reason, last tool, last record]`, 400 entries) and `firstAt` on nodes and message edges. `replay()` in `graph.mjs` rebuilds a node view at a time and reuses `snapshot()` for visibility. Usage and open tool calls are not replayed.
- **Messages** between agents come from `SendMessage` tool calls (outgoing) and user records with `origin.kind === 'peer'` (incoming).
- **Orb states** come from the last tool an agent used (`ACTIVITY_BY_TOOL` in `graph.mjs`). Shell commands are classified by `shellActivity`: readers turn blue, writers violet, everything else green. Only the state is kept.
- **Search** (`/api/search`) scans plan and memory-note text on the server and returns short snippets; agents are matched in the browser.
- Voice uses on-device speech voices only, so titles never reach a speech service. Notifications come from the open tab, never a service worker, and only for waits that start after the page loaded.

## Style

Match the code around you: small functions, constants for magic numbers, and comments only for why. The look: Instrument Serif for headings, Inter for text, green `#34955f` and ink `#162925`, tonal surfaces without borders, an 8 px radius (3 px for chips), and dashed orbit rings for sessions. The T.Y.C.H.O. theme sets `data-theme="dark"` plus `data-hud` on `<html>`, so it inherits every dark style; its overrides live under `:root[data-hud]`. Check UI changes in a real browser before calling them done; `pnpm demo` gives you data to look at.

Motion and keyboard: anything that moves asks `prefersStill()` (`web/src/motion.ts`), which is true under reduced motion or Pause motion (`data-still` on `<html>`), and CSS animations go in the stylesheet, where both stop them. Waits and messages animate only while they are fresh (`FRESH_MS`, two minutes). Agents on the canvas are buttons (`opensDetails` in `layout.ts`) that open on Enter or Space; rooms, piles and the backdrop are not focus stops, only their own buttons are. When a control disappears, move focus to where the user expects it (the drawer heading, the next card, the pile's "Hide finished").

Never commit real transcripts, session names or screenshots of real sessions. Use the demo data (`scripts/demo.mjs`) for examples, tests and screenshots.
