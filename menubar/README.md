# Agent Orrery menu bar companion

A small macOS menu bar app. It shows how many Claude Code sessions are waiting on you, lists them, and opens the one you pick in the dashboard. It only reads `GET /api/waiting` from your own Agent Orrery on `127.0.0.1`.

- The menu bar shows an orb glyph, and a count when anything waits. The menu bar draws it in one colour, so the count is the signal rather than red.
- Each waiting session shows its label, then its repo, what it wants and how long ago, for example "storefront-api, asked you a question, 6 min ago".
- Click a session to open `http://127.0.0.1:<port>/#agent=<id>`, which selects and focuses that agent in the page.
- "Open dashboard" and "Quit" sit below the list. If the server can't be reached it shows "Agent Orrery isn't running on port 4777" and keeps polling every 5 seconds.

## Build

You need macOS 14 or later and the Xcode command-line tools.

```bash
./menubar/build.sh
```

This makes `menubar/build/Agent Orrery.app` (no Dock icon) and signs it ad hoc.

To check it without a GUI, run `"menubar/build/Agent Orrery.app/Contents/MacOS/AgentOrreryMenu" --check`. It fetches once, prints the waiting sessions and exits.

## Install

Copy `Agent Orrery.app` to `/Applications` and open it. To start it at login, add it in System Settings, General, Login Items.

The app is unsigned. The first time, right-click it in Finder and choose Open.

## Port

It uses port 4777. To change it, set `AGENT_ORRERY_PORT` in the environment, or save it as a default:

```bash
defaults write dk.luissejer.agent-orrery.menubar AGENT_ORRERY_PORT 4780
```
