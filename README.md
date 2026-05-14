# Codex Usage Watch

A small self-hosted dashboard for watching local Codex activity, the 5-hour usage window, and the weekly usage window from Safari or a phone over Tailscale.

It reads only local Codex session artifacts under `~/.codex/sessions` and `~/.codex/archived_sessions`. When Codex writes `token_count` events with rate-limit metadata, the dashboard shows measured primary and weekly percentages plus reset times. When that metadata is absent, it still clusters local activity into inferred usage windows.

## Run

```bash
npm start
```

Open:

```text
http://localhost:4177
```

For Tailscale, keep the server bound to `0.0.0.0` and visit:

```text
http://<your-tailscale-device-name>:4177
```

## Run in the background on macOS

Install a user LaunchAgent:

```bash
npm run install:launchd
```

Then load or restart it:

```bash
launchctl unload "$HOME/Library/LaunchAgents/com.local.codex-usage-watch.plist" 2>/dev/null || true
launchctl load "$HOME/Library/LaunchAgents/com.local.codex-usage-watch.plist"
```

Logs are written to:

```text
~/Library/Logs/codex-usage-watch.log
~/Library/Logs/codex-usage-watch.err.log
```

## Configuration

Environment variables:

```bash
PORT=4177
HOST=0.0.0.0
CODEX_HOME="$HOME/.codex"
CODEX_DASHBOARD_DAYS=45
CODEX_ACTIVITY_GAP_MINUTES=30
```

## Notes

This is a local observer, not an OpenAI billing or entitlement API. Treat measured rate-limit data as best when present, and inferred activity as a planning aid when rate-limit metadata is missing.
