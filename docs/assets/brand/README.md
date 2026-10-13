# Agent Orrery brand kit

Everything you need to mention or link to Agent Orrery. All files here, and the images and video in the folders around it, are MIT licensed like the rest of the project.

## Describing it

**One line**

> Agent Orrery is a live map of your Claude Code agents, and what's waiting on you.

**Three sentences**

> Agent Orrery shows every Claude Code session and subagent on your machine, grouped by the git repository each one is working in, with lines for who started whom and the messages between them. A "Your turn" list shows which sessions finished, asked you a question or need your permission, and clicking an agent shows what it has done and how to resume it. It reads the files Claude Code already writes and never changes them, saves only its own settings, runs locally in Docker, and never sends anything off your machine.

**Name.** Write it as two words, **Agent Orrery**, with capitals. Use `agent-orrery` only where a slug is needed (URLs, package and repository names). The byline is **by sejer**, lower case.

**Links.**

- Site: https://orrery.luissejer.dk/
- Code: https://github.com/Luis-Sejer/agent-orrery

## The mark

An orrery is the clockwork model of the planets on their orbits. The mark is an orb on two dashed orbits, with a small green moon. In the app, each agent is an orb and each repository is a room; the mark is the same idea at its smallest.

| File | Use |
|---|---|
| `logo-light.svg`, `logo-light@2x.png` | Mark, name and byline, for light backgrounds |
| `logo-dark.svg`, `logo-dark@2x.png` | The same, for dark backgrounds |
| `mark.svg`, `mark@2x.png` | The mark alone, for light backgrounds and small spaces |
| `mark-dark.svg`, `mark-dark@2x.png` | The mark alone, for dark backgrounds |
| `../icon.svg`, `../icon.png` | App icon: the mark on a rounded square, 1024 × 1024 |
| `../social/banner.png` | GitHub social preview, 1280 × 640 |
| `../social/og.png` | Open Graph and link previews, 1200 × 630 |
| `../hero.webp`, `../hero-dark.webp`, `../hero.png` | The app running on demo data, animated and still |
| `../agent-orrery-launch.mp4`, `../poster.jpg` | 25-second launch video with sound, and its poster frame |

The SVG logos have their type converted to outlines, so they need no fonts. Give the logo clear space of at least the height of the mark on every side, and don't set it smaller than 120 px wide (the mark alone works down to 16 px).

## Colours

| Name | Hex | Use |
|---|---|---|
| Surface | `#f8f9fa` | Page background |
| Surface low | `#f3f4f5` | Panels and quiet areas |
| Card | `#ffffff` | Cards |
| Ink | `#162925` | Text, the orb's core |
| Muted | `#5b6763` | Secondary text, the byline |
| Green | `#34955f` | Orbits, the moon, links, running agents |
| Deep green | `#236b45` | Links and pressed states on light |
| Waiting red | `#c0504a` | An agent waiting on you |
| Amber | `#b9822f` | Messages between agents |
| Blue | `#3f7fae` | An agent reading |
| Violet | `#7d64a8` | An agent writing code |

The dark theme uses green-black grounds (`#0f1715`, `#131d1b`, cards `#18221f`), ink `#e4ebe8`, muted `#9aaaa5` and green `#4caf78`. On dark, the orb's core turns light (`#e4ebe8`).

The state colours (red, amber, blue, violet) mean something in the app. Use them for those meanings, not as decoration.

## Type

- **Instrument Serif**, regular, with slightly tight tracking (−0.02em), for the name and headings.
- **Inter** for everything else. The byline is Inter italic in the muted colour.

Both are free under the SIL Open Font License. The site serves its own copies from `docs/fonts/`, with the licences beside them.

## Do

- Use the logo files as they are, on the background they're made for.
- Use the mark alone where space is tight, such as an avatar or a favicon.
- Use screenshots and recordings made from the demo data (`pnpm demo`).

## Don't

- Recolour, stretch, rotate or outline the mark, or add effects to it.
- Set the name in another typeface, or as one word.
- Drop the byline from the full logo.
- Use screenshots of real Claude Code sessions. They can show private code and prompts.
- Suggest Agent Orrery is made or endorsed by Anthropic. It isn't affiliated with Anthropic.

## Sound

The launch video's music and effects are original: synthesised from scratch with ffmpeg's tone and noise generators by `docs/src/audio.mjs`, with no samples or recordings. They are MIT licensed with the rest of the project.

## Remaking these files

Everything here is rendered from the sources in `docs/src/`. Run `pnpm build` in the repository, then `sh docs/src/render.sh` (or `sh docs/src/render.sh hero` for just the animated hero). It needs Node 24, Google Chrome, ffmpeg and img2webp, and records the app on the made-up demo data only.
