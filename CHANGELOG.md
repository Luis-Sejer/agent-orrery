# Changelog

All notable changes to Agent Orrery are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Agent Orrery follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The Orrery view: your agents in rings around you, closest when they're waiting on you, then running, then finished, with a sector for each repository. The rings turn slowly like an orrery's and steady themselves while you point at an agent; agents glide between rings as their status changes, and finished ones fold into a pile. It's the view the page opens on; Agents, the grid of rooms, is one tab over.
- The page remembers which view you were on (Agents, Orrery, Plans or Memory) when you reload.
- Arrange the orrery by repository: each repository gets a ring of its own, the ones that need you innermost, so many repositories add rings instead of thinning sectors.
- Arrange the orrery as a galaxy: each repository is a small solar system with a sun, its name and status rings of its own, on lanes around you with the ones that need you closest, and agents' names show once you zoom in.
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
- Open agents from the keyboard: Tab to an agent on the canvas and press Enter or Space to open its details. The drawer's heading takes focus when it opens, and focus goes back to where you were when it closes.
- Pause motion, a switch in the settings that holds the rings, orbs, glows and glides still, as your system's reduced-motion setting does.
- Clean view keeps a small list of the sessions waiting on you in the corner, so a wall screen still says who needs you.

### Changed

- New lines in transcripts show up as soon as they're written, instead of within a second, and checking costs less with many sessions.
- Orbs show what shell commands do: reading files with `cat` or `grep` turns an agent's orb blue, and editing with `sed` or a redirect turns it violet.
- A session compacted while it waited on you no longer jumps to Running; compaction and other bookkeeping don't count as activity.
- A subagent that hands back its report shows as finished straight away, instead of running for another 15 minutes.
- A long branch name on a card or in the drawer is cut short with an ellipsis instead of pushing the column wider than the page.
- A pile of finished agents in the orrery is an orb-sized stack with its count, so it no longer covers the agents beside it.
- Monorepo detection only splits real monorepos (a declared workspace, or several packages with no project at the root), and never treats `node_modules` or build folders as packages. A single project with dependencies no longer grows rooms like `node_modules/mysql2`, and a dependency with its own `.git` belongs to the repository that installed it.
- A session that ended its turn while subagents or background shells it started this turn are still running shows as running, "Waiting on 2 agents and a shell", instead of waiting on you. It joins Your turn once they're done; a question to you still counts as waiting. A shell counts for half an hour at most, so a background dev server can't keep a session busy.
- A session silent for three minutes right after a tool result is shown as probably asking you a question: Claude Code writes a question to the transcript only once you've answered it. A task notification that arrives after a session finished no longer wakes it.
- The page is much lighter to leave open: every orb shares one 30 fps loop and skips when off screen, the rings update 10 times a second while turning steadily and sleep when still, and orrery cards skip re-renders when they only move. Idle cost on the demo fell by a third to two thirds per view.
- The server holds far less memory (about 540 MB less on a 600 MB transcript set), reads large transcripts in chunks, pushes updates at most once a second but no longer up to five seconds late under constant writes, reads only the files that changed, and forgets transcripts older than the window.
- A worktree whose branch name has a slash (`feat/x`) joins its repository instead of showing up as a monorepo package of its own.
- Dismissing a session sticks with the dashboard open in several tabs: each tab used to write back its own list and undo dismissals made in the others.
- Selecting an agent no longer rearranges the canvas: piles of finished agents stay folded and light up instead.
- Waiting cards glow on their own rhythm instead of all at once.
- Renamed to Agent Orrery.
- The canvas, the drawer and settings work better with a screen reader: agents are named buttons, orbs are hidden as decoration, the search palette is a proper combobox that says how many results it found, the replay slider reads out the time, and the waiting count, connection and "Copied" are announced.
- Waiting cards and halos run their beam only for the first two minutes of a wait, and message lines flow only while a message is new; after that they rest, still red or amber.
- Labels on the canvas stay readable when you zoom out: agents' names, ring and repository names and the caption under you keep at least about 12 px. Waiting agents keep their names in a zoomed-out galaxy.
- A galaxy is centred on you as far as the screen allows, instead of on the middle of its systems.
- Arranged by repository, each ring's name sits on a larger pill.
- In the Agents view, rooms waiting on you come first, room names are easier to read and cut short when long, and dimmed cards stay readable.
- Your turn: Quiet comes before Running now, titles wrap to two lines, and long repository names are cut short. Waiting cards read the same in Your turn and the Agents view ("Finished, 20 min ago"), and "waiting on you" is used everywhere.
- Narrow windows and pages zoomed to 200% or 400% stack the toolbar, Your turn, the canvas and the drawer, and Plans and Memory show the list above the reader. On a phone the toolbar stays at the top as you scroll.
- The toolbar stays on one line with the drawer open, the minimap steps aside for the drawer, and the settings button says "Settings" on wide screens. Settings scroll when the window is short and close when you tab out of them; the switches look like switches.
- Clicking an agent the drawer would cover moves it into view.
- The Agents view no longer drops its lines for a few frames when you select an agent.
- With no activity, the empty orrery no longer sits behind the message, and Plans and Memory with nothing saved show no empty reader.
- Small copy fixes: "Show 4 finished", "Sent a message" in the timeline, "689k tokens", and the resume command scrolls instead of breaking inside the session id.
- Light theme: a deeper red for waiting text and an amber Quiet heading that both pass 4.5:1. T.Y.C.H.O. shows the selected agent's name in amber, uses cyan for keyboard focus, and keeps status lines in the text face.

### Removed

- The <kbd>/</kbd> shortcut for search: a single-key shortcut can be set off by accident with speech input, and it couldn't be turned off. <kbd>⌘</kbd> <kbd>K</kbd> and <kbd>Ctrl</kbd> <kbd>K</kbd> still open search.

## [0.1.0] - 2026-10-12

### Added

- A live map of Claude Code sessions and subagents, grouped into rooms by the repository each agent works in.
- Your turn: sessions that finished or asked a question, oldest first, with a dismiss button that holds until the session does something new.
- Orbs that show what each agent is doing, and messages between agents travelling along the lines.
- Click an agent to highlight everything connected to it, with a timeline of what it has done and a resume command.
- Plans and Memory views for what Claude has saved, with search.
- Docker setup that runs read-only, as you, on this machine only.
- A demo with made-up sessions (`pnpm demo`).
