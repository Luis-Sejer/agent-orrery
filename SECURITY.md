# Security Policy

## Supported versions

Only the latest commit on `main` receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: go to the [Security tab](https://github.com/Luis-Sejer/agent-orrery/security) and choose **Report a vulnerability**. Don't open a public issue.

You can expect an acknowledgement within a few days, and a fix or a plan as soon as the issue is understood.

## What Agent Orrery does with your data

- It reads Claude Code's files under `~/.claude/projects` and `~/.claude/plans`, and the status files in `~/.claude/sessions`. That folder also holds each session's key file; only files named `<pid>.json` are ever opened. It never writes to any of them, or to your code.
- It keeps the graph in memory only. Nothing is stored, logged or sent anywhere.
- The page receives metadata only: session titles, repository and branch names, agent types, tool names, file names and times. Plans and memory notes are sent only when you open them.
- Search reads plan and memory text on your machine and sends back short snippets to the page.
- It writes one file of its own, `state.json` in its data folder: your settings and the sessions you dismissed, nothing else. Only its own page can change it, and only with known settings and values. Nothing is kept in your browser's storage. Notifications are shown by your browser and go nowhere else. Spoken announcements use only voices that run on your machine, never a network speech service.

## What's in scope

Anything that lets someone other than you read your sessions, plans or notes, or run code through Agent Orrery. For example: a website you visit reaching the server, content in a transcript running script in the page, or a request reading a file outside the plans and memory folders.
