<div align="center">

<img src="public/logo.svg" width="76" alt="">

# virtual agents office

### Your AI agents, as an office you can walk around.

[![MIT license](https://img.shields.io/badge/license-MIT-C9EF52?style=flat-square)](LICENSE)
[![Node 18+](https://img.shields.io/badge/node-18%2B-5B8DEF?style=flat-square)](https://nodejs.org)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-2F3B66?style=flat-square)](package.json)
[![stars](https://img.shields.io/github/stars/IshanVats-6/virtual-agents-office?style=flat-square&color=FFB86B)](https://github.com/IshanVats-6/virtual-agents-office/stargazers)

```bash
npx github:IshanVats-6/virtual-agents-office
```

**One command.** It reads this machine, opens `localhost:4747`, and there's your team.

<img src="docs/img/hero.png" alt="The office: team pods, meeting rooms, kitchen and lounge, seen from above" width="880">

</div>

---

Your scheduled agents stop being cron lines in a config file and become people at desks.

They **type while they run**, **sleep heads-down between shifts**, **huddle in a meeting room** when they spawn sub-agents, **walk over to another agent** when they hand off work, and **take a coffee break** when a run finishes. Click anyone and you get a 30-day scorecard: runs, success rate, spend, tokens, and what they actually shipped.

<table>
<tr>
<td width="50%"><img src="docs/img/pod.png" alt="A team pod: agents asleep at their desks between shifts"><br><em>Asleep between shifts, with the next run on the monitor.</em></td>
<td width="50%"><img src="docs/img/scorecard.png" alt="An agent scorecard with runs, spend, tokens and work delivered"><br><em>Click anyone: cost, success rate, work delivered, recent runs.</em></td>
</tr>
<tr>
<td width="50%"><img src="docs/img/overview.png" alt="The receptionist's company overview"><br><em>Ask the receptionist how the company is doing.</em></td>
<td width="50%"><img src="docs/img/lounge.png" alt="The lounge with a ping pong table and bean bags"><br><em>Kitchen, lounge, huddle rooms, focus booths.</em></td>
</tr>
</table>

## Quick start

```bash
npx github:IshanVats-6/virtual-agents-office     # run it
npx github:IshanVats-6/virtual-agents-office --demo   # a staged office, if yours is quiet
```

Or clone it:

```bash
git clone https://github.com/IshanVats-6/virtual-agents-office
cd virtual-agents-office && npm start
```

Node 18+ is the only requirement. No install step, no build, no dependencies, no account.

## Which tools it reads

Everything is read **locally and read-only**. Nothing is uploaded and there is no telemetry.

| | Tool | What you get |
|---|---|---|
| 🟠 | **Claude Code** | Live activity, scheduled tasks, sub-agent huddles, approvals waiting on you |
| 🟢 | **Codex** | Live activity, automations and their schedules |
| 🟣 | **Claude Cowork** | Scheduled tasks and their runs |
| 🔴 | **OpenClaw** | The always-on agent, and whether its gateway is up |
| 🟡 | **Hermes** (optional) | An always-on chat agent on a remote box, over SSH |
| 🔵 | **Cursor, Copilot, Gemini CLI, Cline, Roo, Zed, Warp, OpenCode, Droid, Kiro, Qwen, Kimi, Goose and ~20 more** | Desks with cost, tokens and run history, through [codeburn](https://github.com/getagentseal/codeburn) |

The last row is a bridge: if [codeburn](https://github.com/getagentseal/codeburn) is installed (`npm i -g codeburn`), every agent it can price gets a desk and a scorecard, without a live feed. Claude Code, Codex and Cowork are read directly, so they also get the live activity and movement.

**Manus and other cloud-only agents** keep no local history, so they can't be shown yet.

**Found nothing?** You get a demo office with a banner, so the first run still shows you what this is.

## What you're looking at

- **Staff** are your standing agents (scheduled tasks and automations). One desk each, permanently, whether they're running or not.
- **Contractors** are one-off interactive sessions from the last 24 hours, at hot desks.
- **Status:** working · needs you (a tool is waiting for approval, or a question was asked) · on break · asleep, with the next shift on the monitor · on leave (schedule paused) · ⚠ last run failed.
- **Grouping:** by Team, Department or Tool. Departments and tools become wings that hold their team pods.
- **Scorecards:** runs, success rate, spend, tokens, typical run time, cache hit, a daily chart, work delivered (files edited, commits, Notion updates, email drafts, web research, commands, sub-agents briefed) and recent runs with the outcome of each.
- **Receptionist:** click her for headcount, 30-day spend, spend by team, who needs attention and what runs next.

Scroll to zoom, drag to pan, `T` for the team directory, `1`–`9` to jump to a pod, `▶` to stage a busy office.

## How agents get names, roles and teams

All of it is derived from the task itself, and all of it is overridable.

| From the task | Becomes |
|---|---|
| The task id, e.g. `weekly-seo-audit` | **Job title** via keywords: `seo` → SEO Specialist, `backup` → Backup Operator, `triage` → Support Agent. No match: the task name itself |
| The same id | **Department** via keywords: `deploy\|release\|backup` → Engineering, `seo\|blog\|content` → Marketing, `invoice\|billing` → Finance |
| A prefix in the title, e.g. `Marketing \| Daily blog` | That prefix wins as the department |
| Your `teams` config, e.g. `{"name":"SEO Squad","match":"seo\|backlink"}` | **Team pod** on the floor. Without it, one pod per department |
| A stable hash of the task id | **The person's name**, so an agent keeps the same name forever |

```bash
cp config.example.json config.json    # then override only what you want
```

`company`, `tagline`, `teams`, `roles`, `deptKeywords`, `departments`, `nameOverrides`, `port`, `analyticsDays`, `maxContractors`, `bridgeOtherTools`.

### Next run times for Claude Code tasks

Claude Code keeps cron times in its scheduler rather than a file, so those agents show "Scheduled" with no countdown. To fill it in, ask Claude Code:

> list my scheduled tasks and write them to `schedules.json` here as `{"tasks":[{"id","title","cron","enabled"}]}`

Codex and Cowork schedules are read live and always show a next run.

## Reach it from anywhere (optional)

The same server also runs as a **relay**: your machine keeps reading logs and pushes the office to a small server you can open from your phone, behind a password.

```bash
# on the server
OFFICE_MODE=relay HOST=0.0.0.0 OFFICE_PASSWORD='…' PUSH_TOKEN='…' node server.mjs
# on your machine
PUSH_URL=https://office.example.com/api/push PUSH_TOKEN='…' node start.mjs
```

`Dockerfile`, `docker-compose.yml` and launchd/systemd units are in [docs/remote.md](docs/remote.md).

## Privacy

The activity feed contains **your real prompts, file paths and commands**.

- The local server binds to `127.0.0.1` only.
- The relay refuses every request without a password, and only accepts pushes carrying a bearer token.
- `"privacy": { "hideFeed": true }` in `config.json` strips prompt and reply text, keeping only tool names.
- `config.json`, `schedules.json` and the analytics cache are git-ignored.
- The only thing this project ever asks of your GitHub account is a star, once, with a yes/no prompt. Nothing is starred silently.

## How it works

```
start.mjs      detect sources, serve, open the browser
server.mjs     collectors + roster + HTTP/SSE  (or relay mode)
analytics.mjs  parses each run once (cached), merges codeburn cost data
demo.mjs       the staged office for first runs
public/        the whole isometric office in one file, no build step
```

Adding a source means returning sessions in the shape the collectors already use (`tool, sid, title, start, end, status, feed…`). `collectClaude` in `server.mjs` is the smallest example. Issues and PRs welcome.

## Support this

If it made you smile, [**star the repo**](https://github.com/IshanVats-6/virtual-agents-office) so other people find it, and tell me which tool you want supported next.

[![Sponsor](https://img.shields.io/badge/sponsor-%E2%99%A5-ff6b9a?style=for-the-badge)](https://github.com/sponsors/IshanVats-6)

Built by [IV Consulting](https://ivconsulting.in/?source=virtual-agents-office), where we build AI agents that actually run in production. MIT licensed, so use it however you like.
