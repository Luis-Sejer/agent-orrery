# Security Policy

## Supported versions

Only the latest commit on `main` receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: go to the [Security tab](https://github.com/Luis-Sejer/agent-graph/security) and choose **Report a vulnerability**. Don't open a public issue.

You can expect an acknowledgement within a few days, and a fix or a plan as soon as the issue is understood.

## What agent-graph does with your data

- It reads Claude Code's files under `~/.claude/projects` and `~/.claude/plans`. It never writes to them, or to anything else.
- It keeps the graph in memory only. Nothing is stored, logged or sent anywhere.
- The page receives metadata only: session titles, repository and branch names, agent types, tool names, file names and times. Plans and memory notes are sent only when you open them.
- Dismissed sessions are remembered in your browser's local storage.

## What's in scope

Anything that lets someone other than you read your sessions, plans or notes, or run code through agent-graph. For example: a website you visit reaching the server, content in a transcript running script in the page, or a request reading a file outside the plans and memory folders.
