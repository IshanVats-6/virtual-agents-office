# Reaching your office from anywhere

Your agent logs only exist on your machine, so the office is split in two:

- **Collector** (your machine): reads the logs and pushes the office state over HTTPS every few seconds.
- **Relay** (a small server): serves the page behind a password. It never reads any logs.

If the collector stops (laptop asleep, machine off), the relay keeps showing the last state with an "offline" banner.

## 1. Run the relay

```bash
OFFICE_USER=me OFFICE_PASSWORD='a-long-password' PUSH_TOKEN='a-long-random-token' \
  docker compose up -d --build
```

Put it behind your own HTTPS (Caddy, nginx, Traefik, Cloudflare Tunnel, a PaaS…). Only ever expose it over HTTPS: the login is HTTP Basic auth, and the page contains your prompts.

Without Docker:

```bash
OFFICE_MODE=relay HOST=0.0.0.0 PORT=4747 \
OFFICE_USER=me OFFICE_PASSWORD='…' PUSH_TOKEN='…' STATE_FILE=/var/lib/office/state.json \
  node server.mjs
```

## 2. Point your machine at it

```bash
PUSH_URL=https://office.example.com/api/push PUSH_TOKEN='…same token…' node start.mjs --no-open
```

`PUSH_TOKEN_FILE=/path/to/token` works too, if you'd rather keep it out of your shell history.

## 3. Keep the collector running

**macOS (launchd).** Save as `~/Library/LaunchAgents/com.example.office.plist`, then
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.office.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.example.office</string>
  <key>ProgramArguments</key>
  <array><string>/opt/homebrew/bin/node</string><string>/Users/you/virtual-agents-office/server.mjs</string></array>
  <key>WorkingDirectory</key><string>/Users/you/virtual-agents-office</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>PUSH_URL</key><string>https://office.example.com/api/push</string>
    <key>PUSH_TOKEN_FILE</key><string>/Users/you/.config/office-token</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/Library/Logs/office.log</string>
  <key>StandardErrorPath</key><string>/Users/you/Library/Logs/office.log</string>
</dict></plist>
```

> Keep the checkout **outside `~/Downloads`, `~/Documents` and `~/Desktop`**. macOS blocks background jobs from those folders, and the job will hang with no error. `~/.local/share/…` is a safe spot.

**Linux (systemd user unit).** Save as `~/.config/systemd/user/office.service`, then `systemctl --user enable --now office`:

```ini
[Unit]
Description=virtual agents office collector
[Service]
ExecStart=/usr/bin/node %h/virtual-agents-office/server.mjs
Environment=PUSH_URL=https://office.example.com/api/push
Environment=PUSH_TOKEN_FILE=%h/.config/office-token
Restart=always
[Install]
WantedBy=default.target
```

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `PORT`, `HOST` | both | Where to listen (default `4747` on `127.0.0.1`) |
| `OFFICE_MODE=relay` | relay | Don't read local logs; accept pushes |
| `OFFICE_USER`, `OFFICE_PASSWORD` | relay | Browser login. Without a password, the page is open to anyone who can reach it |
| `PUSH_TOKEN`, `PUSH_TOKEN_FILE` | both | Bearer token for `/api/push` |
| `PUSH_URL` | collector | Where to push |
| `STATE_FILE` | relay | Keeps the last state across restarts |
| `OFFICE_DEMO=1` | collector | Force the demo office |
