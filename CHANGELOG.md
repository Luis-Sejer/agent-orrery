# Changelog

All notable changes to agent-graph are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and agent-graph follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-12

### Added

- A live map of Claude Code sessions and subagents, grouped into rooms by the repository each agent works in.
- Your turn: sessions that finished or asked a question, oldest first, with a dismiss button that holds until the session does something new.
- Orbs that show what each agent is doing, and messages between agents travelling along the lines.
- Click an agent to highlight everything connected to it, with a timeline of what it has done and a resume command.
- Plans and Memory views for what Claude has saved, with search.
- Docker setup that runs read-only, as you, on this machine only.
- A demo with made-up sessions (`pnpm demo`).
