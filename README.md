<div align="center">

<img src="public/logo.svg" width="72" alt="">

# virtual-agents-office

**Your AI agents, as an office you can walk around.**

Every scheduled agent becomes an employee with a name, a job title and a desk. They type while they run, sleep heads-down between shifts, huddle in a meeting room when they spawn sub-agents, and take a coffee break when they finish. Click anyone for a 30-day scorecard: runs, success rate, spend, tokens, and what they actually shipped.

```bash
npx github:IshanVats-6/virtual-agents-office
```

That's it. It scans this machine, starts on `localhost:4747` and opens your browser.

</div>

---

## What it reads

Everything is read **locally and read-only**. Nothing is uploaded, and there is no telemetry.

| Source | Where | What you get |
|---|---|---|
| **Claude Code** | `~/.claude/projects`, `~/.claude/scheduled-tasks` | Sessions, live activity, scheduled agents |
| **Codex** | `~/.codex/sessions`, `~/.codex/automations` | Sessions and automations (incl. their rrule schedules) |
| **Claude Cowork** | the desktop app's session folder (macOS) | Scheduled tasks and their runs |
| **OpenClaw** | Codex runs with `originator: openclaw`, gateway on :18789 | The always-on agent and whether it's up |
| **Hermes** (optional) | a remote container over SSH | An always-on chat agent |
| **[codeburn](https://github.com/getagentseal/codeburn)** (optional) | `codeburn sessions --format json` | Cost, tokens and cache hit per agent |

You need Node 18+ and at least one of the above. **If nothing is found you get a demo office**, so you can see what it looks like before wiring anything up.

## What you see

- **Staff** are your standing agents (scheduled tasks and automations), one desk each, permanently.
- **Contractors** are one-off interactive sessions from the last 24h, at hot desks.
- **Status:** working · needs you (a tool is waiting for approval, or a question was asked) · on break · asleep (between shifts, with the next shift on the monitor) · on leave (schedule paused) · ⚠ last run failed.
- **Movement:** sub-agents walk in and huddle in a meeting room; an agent that calls another agent walks to their desk; anyone who just finished goes for coffee.
- **Grouping:** by Team, Department or Tool. Departments and tools become wings holding their team pods.
- **Scorecards:** runs, success rate, spend, tokens, typical run time, cache hit, a daily chart, "work delivered" (files edited, commits, Notion updates, email drafts, web research, commands, sub-agents) and recent runs with what each one produced.
- **Reception:** click Iris for a company overview — headcount, 30-day spend, spend by team, who needs attention, upcoming shifts.

Press `▶` in the header to stage a busy office if yours is quiet.

## Make it yours

```bash
cp config.example.json config.json
```

Only the keys you set are overridden; the rest come from `defaults.json`.

- `company`, `tagline` — the name on the lobby wall.
- `teams` — group agents into named pods by a regex on the task id. Without this you get one pod per department.
- `roles` — map a keyword to a job title. Otherwise the task name becomes the title.
- `deptKeywords`, `departments` — how departments are guessed, and their colors.
- `nameOverrides` — pin a specific name to a specific agent.
- `port`, `maxContractors`, `analyticsDays`.

**Tip:** if your task titles already start with something like `🔴 Marketing | Daily blog`, the department is taken from that prefix automatically.

### Show next run times for Claude Code tasks

Claude Code keeps its cron times in its scheduler, not in a file, so those agents show "Scheduled" with no countdown. To fill it in, ask Claude Code:

> list my scheduled tasks and write them to `schedules.json` in this repo as `{"tasks":[{"id","title","cron","enabled"}]}`

Codex and Cowork schedules are read live, so they always show a next run.

## Remote access (optional)

The same server runs in **relay mode**: your machine keeps reading logs and pushes the office to a small server you can reach from anywhere.

```bash
# on the server
OFFICE_MODE=relay HOST=0.0.0.0 OFFICE_PASSWORD=<pick one> PUSH_TOKEN=<pick one> node server.mjs
# on your machine
PUSH_URL=https://office.example.com/api/push PUSH_TOKEN=<same> node server.mjs
```

There's a `Dockerfile` and `docker-compose.yml` for the relay in [`docs/remote.md`](docs/remote.md), plus how to keep the collector running at login on macOS (launchd) and Linux (systemd).

## Privacy

The activity feed contains **your real prompts, file paths and commands**. Keep that in mind:

- The local server binds to `127.0.0.1` only.
- The relay refuses every request without a password, and only accepts pushes with a bearer token.
- Set `"privacy": { "hideFeed": true }` in `config.json` to drop prompt text and show only tool names.
- `config.json`, `schedules.json` and the analytics cache are git-ignored.

## How it works

```
start.mjs     one command: detect, serve, open the browser
server.mjs    collectors (Claude/Codex/Cowork/Hermes) + roster + HTTP/SSE, or relay mode
analytics.mjs parses each run once (cached) for "work delivered", merges codeburn cost data
demo.mjs      synthetic office for first runs
public/       the isometric office (one file, no build step, no dependencies)
```

Adding a source means returning sessions in the shape the collectors already use (`tool, sid, title, start, end, status, feed…`) — see `collectClaude` in `server.mjs` for the smallest example. PRs welcome.

## License

MIT
