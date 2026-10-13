# Changelog

All notable changes to Agent Orrery are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Agent Orrery follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The Orrery view: your agents in rings around you, closest when they're waiting on you, then running, then finished, with a sector for each repository. The rings turn slowly like an orrery's and steady themselves while you point at an agent; agents glide between rings as their status changes, and finished ones fold into a pile. It's the view the page opens on; Agents, the grid of rooms, is one tab over.
- The page remembers which view you were on (Agents, Orrery, Plans or Memory) when you reload.
- Arrange the orrery by repository: each repository gets a ring of its own, the ones that need you innermost, so many repositories add rings instead of thinning sectors.
- One settings menu holds the filters, the orrery's arrangement, the theme, replay, notifications and voice, leaving the toolbar with search and the views. Clean view hides the side panel, minimap and zoom as well.
- Monorepos: each package or app with its own manifest becomes an area with a room of its own (`shop › apps/web`), but only while two or more of a repository's areas are busy. An `.orrery.json` names the areas instead, and `pnpm demo --monorepo` shows a made-up one.
- Worktrees as their own rooms: a switch in the settings gives each worktree's branch a room or ring of its own. Off by default, so worktrees join their repository.
- Switching the orrery's arrangement glides every agent to its new ring while the view eases to the new size, instead of redrawing at once.
- T.Y.C.H.O., a fourth theme: a holographic HUD in amber and orange on black, with a turning dial around you in the Orrery view.
- Voice: turn it on in the settings and the page says out loud when a session starts waiting on you, using a voice on your machine.
- Cost: an estimate for each agent, session (with its subagents) and room, and one line in the inbox for everything in view. Models without a known price show tokens only.
- Quiet agents: a running agent that has been silent for five minutes is flagged amber and listed under Quiet, and says which tool call is still open, since that may be a permission prompt. An agent with an open tool call now counts as running for up to two hours instead of 15 minutes.
- Replay: scrub back through the last hours, or play them at about ten minutes a second, with a banner and notifications paused. The server keeps a short in-memory history for it and serves `/api/replay` and `/api/window`.
- A macOS menu bar companion in `menubar/` that counts the sessions waiting on you and opens the one you pick. It reads the new `/api/waiting` route, and the page now selects an agent from a `#agent=<id>` link.
- Search everything with ⌘K (Ctrl K elsewhere): agents by name, repo or branch, and plans and memory notes by their text, with the matches highlighted. Pick a result to jump straight to it.
- Notifications: turn them on in the settings, and your browser tells you when a session starts waiting on you while you're in another tab. Click one to jump to the session.
- A dark theme that follows your system, and a button to pick light or dark instead.
- Hide finished: a room you've opened can fold its finished agents back into a pile.
- The drawer lists a session's subagents, so you can jump to any of them, even when they're folded away.
- Tables, task lists and strikethrough in plans and memory notes.
- A website, app icon, logos, social images and a launch video, all made from the demo.

### Changed

- New lines in transcripts show up as soon as they're written, instead of within a second, and checking costs less with many sessions.
- Orbs show what shell commands do: reading files with `cat` or `grep` turns an agent's orb blue, and editing with `sed` or a redirect turns it violet.
- A session compacted while it waited on you no longer jumps to Running; compaction and other bookkeeping don't count as activity.
- A subagent that hands back its report shows as finished straight away, instead of running for another 15 minutes.
- A long branch name on a card or in the drawer is cut short with an ellipsis instead of pushing the column wider than the page.
- A pile of finished agents in the orrery is an orb-sized stack with its count, so it no longer covers the agents beside it.
- Monorepo detection only splits real monorepos (a declared workspace, or several packages with no project at the root), and never treats `node_modules` or build folders as packages. A single project with dependencies no longer grows rooms like `node_modules/mysql2`, and a dependency with its own `.git` belongs to the repository that installed it.
- A session that ended its turn while subagents it started are still running shows as running, "Waiting on 2 agents", instead of waiting on you. It joins Your turn once they're done; a question to you still counts as waiting.
- A worktree whose branch name has a slash (`feat/x`) joins its repository instead of showing up as a monorepo package of its own.
- Dismissing a session sticks with the dashboard open in several tabs: each tab used to write back its own list and undo dismissals made in the others.
- Selecting an agent no longer rearranges the canvas: piles of finished agents stay folded and light up instead.
- Waiting cards glow on their own rhythm instead of all at once.
- Renamed to Agent Orrery.

## [0.1.0] - 2026-10-12

### Added

- A live map of Claude Code sessions and subagents, grouped into rooms by the repository each agent works in.
- Your turn: sessions that finished or asked a question, oldest first, with a dismiss button that holds until the session does something new.
- Orbs that show what each agent is doing, and messages between agents travelling along the lines.
- Click an agent to highlight everything connected to it, with a timeline of what it has done and a resume command.
- Plans and Memory views for what Claude has saved, with search.
- Docker setup that runs read-only, as you, on this machine only.
- A demo with made-up sessions (`pnpm demo`).
