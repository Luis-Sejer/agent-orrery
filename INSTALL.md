# Installing Agent Orrery (for an AI agent)

You are installing Agent Orrery for the person you're working with: a dashboard at http://127.0.0.1:4777 that shows their Claude Code sessions, the subagents in them, and which sessions are waiting on them. It runs in Docker and only reads files.

Work through the steps in order. Each one says how to check it worked. Tell the person what you did at the end, in plain words.

## Rules

- **Don't change their Claude setup.** Agent Orrery needs no hooks, plugins, MCP servers or settings. Never edit `~/.claude/settings.json` or anything else under `~/.claude`.
- **Keep it on this machine.** Never change the port mapping away from `127.0.0.1`, never set `AGENT_ORRERY_BIND`, and never expose the port any other way. The dashboard shows what their agents are working on.
- **Don't commit or push.** Settings go in `.env`, which git ignores.
- **Ask before installing software.** If Docker Desktop is missing, tell them and stop. Don't install it yourself.
- **Use `docker compose`**, not a hand-written `docker run`. The compose file carries the security settings (read-only mounts, non-root user, no capabilities). The one writable mount is `./data`, where it saves its own settings.

## 1. Check Docker

```bash
docker info --format '{{.ServerVersion}}'
```

A version number means Docker is running. An error means Docker Desktop isn't installed or isn't started. Ask them to install or start it (https://www.docker.com/products/docker-desktop/), then wait for them.

## 2. Get the code

If the repository is already on disk, `git pull` in it. Otherwise clone it next to their other repositories:

```bash
git clone https://github.com/Luis-Sejer/agent-orrery.git ~/Documents/GitHub/agent-orrery
cd ~/Documents/GitHub/agent-orrery
```

Put it wherever they keep repositories if that isn't `~/Documents/GitHub`.

## 3. Write `.env`

Agent Orrery needs three facts about this machine. Find each one, then write them to `.env` in the repository folder.

- **User and group id.** Claude Code's session files are readable only by their owner, so the container runs as them. Get them from `id -u` and `id -g`.
- **Where their repositories live.** This is used to tell which repo an agent is working in. Look for the folder that holds most of their git repositories, usually `~/Documents/GitHub` or `~/code`. If you can't tell, ask. It must be one folder that contains the repos, possibly in subfolders.
- **The port.** Keep `4777` unless something already uses it. Check with `lsof -iTCP:4777 -sTCP:LISTEN`. If it's taken, use `4778`.

```bash
cat > .env <<EOF
AGENT_ORRERY_UID=$(id -u)
AGENT_ORRERY_GID=$(id -g)
AGENT_ORRERY_CODE_DIR=$HOME/Documents/GitHub
AGENT_ORRERY_PORT=4777
EOF
```

Replace `AGENT_ORRERY_CODE_DIR` and `AGENT_ORRERY_PORT` with what you found. `$HOME` is fine in the code folder; write a full path, not `~`.

## 4. Start it

```bash
docker compose up -d --build
```

The first build takes a minute or two. Then check it:

```bash
docker ps --filter name=agent-orrery --format '{{.Status}}'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4777/
```

The status should say `Up` (it reads `healthy` after about 30 seconds) and curl should print `200`. Use their port if you changed it.

If curl doesn't print `200`, read `docker logs agent-orrery`:

| Log says | Cause | Fix |
|---|---|---|
| `EACCES` / `permission denied` under `.claude` | Wrong user id | Re-check `id -u` and `id -g` in `.env`, then `docker compose up -d` |
| `no built page in web/dist` | Build didn't finish | Run `docker compose up -d --build` again and read the build output |
| Nothing, and the container keeps restarting | Port clash | Pick another port in `.env` |

## 5. Make it start with the computer

The container restarts by itself, but only while Docker Desktop is running. Ask them to turn on **Docker Desktop → Settings → General → Start Docker Desktop when you sign in**. You can't change this setting for them.

## 6. Hand over

Open the dashboard for them (`open http://127.0.0.1:4777` on macOS), then tell them:

- It shows Claude Code sessions from the last 6 hours, and anything waiting on them for 24 hours.
- **Your turn** lists sessions that finished or asked a question. The ✕ dismisses one until it does something new.
- Clicking an agent highlights everything connected to it. The drawer has a resume command they can paste into a terminal.
- **Orrery** shows the same agents in rings around them, with whatever waits on them closest.
- **Plans** and **Memory** show what Claude has saved, read-only.
- To update later: `git pull && docker compose up -d --build` in the repository folder.
- To remove it: `docker compose down` in the repository folder, then delete the folder.

## Optional settings

These also go in `.env`. Restart with `docker compose up -d` after changing them.

| Variable | Default | What it does |
|---|---|---|
| `AGENT_ORRERY_WINDOW_HOURS` | `6` | How far back to show sessions and agents |
| `AGENT_ORRERY_WAITING_HOURS` | `24` | How long a session waiting on them stays listed |
| `AGENT_ORRERY_VIEW`, `AGENT_ORRERY_ARRANGEMENT`, `AGENT_ORRERY_THEME`, … | unset | What every browser starts with; the README lists them all, and Settings → "Copy these settings for .env" writes them |
