# Roadmap

Ideas that fit Agent Orrery but aren't planned yet. Want one? Say so in an [issue](https://github.com/Luis-Sejer/agent-orrery/issues/new/choose), or build it: see [CONTRIBUTING.md](CONTRIBUTING.md).

- **A published Docker image.** Build and publish to the GitHub Container Registry on each release, so installing doesn't need a local build.
- **Other agents.** Codex and other coding agents that save transcripts locally.
- **Monorepos.** Today a room is a git repository, so a monorepo is one big room. Split it by package instead: each file an agent touches belongs to the nearest project manifest under the repo root (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, Nx's `project.json`), and files at the root go to a root area. Split only once two or more packages are active, so multi-repo setups look the same as now. Agents shows the repo as the outer box with a sub-room per package; the orrery groups package sectors into one arc per repo. An optional `.orrery.json` in the repo maps folders to names where the manifests don't match how people think about the code.
