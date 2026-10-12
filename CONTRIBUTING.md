# Contributing to Agent Orrery

Thanks for helping make Agent Orrery better. Bug reports, ideas and pull requests are all welcome.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting bugs and suggesting features

Open an [issue](https://github.com/Luis-Sejer/agent-orrery/issues/new/choose) and pick the template that fits. For bugs, include how you run Agent Orrery (Docker or from source), your Claude Code version (`claude --version`) and the steps that show the problem. Never paste transcript contents: they can hold your code and secrets.

Found a security issue? Please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development setup

You need Node 24 or later and pnpm (`corepack enable`).

```sh
git clone https://github.com/Luis-Sejer/agent-orrery.git
cd agent-orrery
pnpm install
pnpm demo          # build and run on made-up sessions, http://127.0.0.1:4780
```

To work on the page with hot reload, run `pnpm start` (or `pnpm demo`) in one terminal and `pnpm dev` in another. Vite proxies to the server on port 4777.

### Project layout

| Path | What lives there |
|---|---|
| `server.mjs` | The HTTP server: request checks, live updates, plans and memory routes |
| `graph.mjs` | Turns transcript records into the graph; keeps metadata only |
| `repos.mjs` | Works out which git repository a path belongs to |
| `library.mjs` | Lists and reads plans and memory notes |
| `web/src/` | The page: React, React Flow and Thinking Orbs |
| `web/src/layout.ts` | Rooms, folding and focus: what goes where on the canvas |
| `web/src/components/SearchPalette.tsx` | Search everything (⌘K) |
| `web/src/useNotifications.ts`, `useTheme.ts`, `useDismissed.ts` | Notifications, light and dark, and dismissed sessions |
| `scripts/demo.mjs` | Made-up sessions for trying it out and for screenshots |
| `scripts/screenshots.mjs` | Takes the README screenshots from the demo |

## Guidelines

- **Keep the safety rules.** [AGENTS.md](AGENTS.md) lists them. A change that touches one needs a test.
- **No runtime dependencies for the server.** Node's standard library only.
- **Pin exact versions** for anything you add to the page, and keep it a `devDependency`.
- **Keep it accessible.** Real buttons and links, labels on icon buttons, visible focus, and respect for Reduce Motion.
- **Keep it small.** Prefer the simplest change that works, and match the style of the code around it.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make your change and run `pnpm test`, `pnpm typecheck` and `pnpm build`.
3. Try it with `pnpm demo`. If the screens change, run `pnpm screenshots` and commit the new images.
4. Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) if users will notice the change.
5. Open a pull request that explains what changed and why, with a screenshot for anything visual.
