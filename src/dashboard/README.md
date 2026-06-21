# Pipeline Dashboard

Real-time web UI for monitoring pipeline sessions. Watches `.pipeline/state/` for changes and pushes updates to the browser via Server-Sent Events.

## Usage

```bash
bun run dashboard                          # http://localhost:3000
bun run dashboard -- --port 8080           # custom port
bun run dashboard -- --state-dir /abs/path # custom state directory
```

## What It Shows

Each session card displays:

- **Status badge** — running, waiting (checkpoint), failed, completed
- **Stage progression bar** — 7 circles connected by lines, color-coded:
  - Green = completed
  - Blue pulsing = active
  - Amber pulsing = waiting (checkpoint)
  - Red = error
  - Gray = pending
- **Summary** — cost, duration, stages run, timestamps
- **Expandable details** — telemetry table, error block, checkpoint info, revision feedback, config

Updates are live — modifying a state JSON file pushes changes to all connected browsers automatically.

## Architecture

```
Browser ──SSE──▶ server.ts ◀──fs.watch()── .pipeline/state/*.json
                    │
                    ├── GET /              → index.html (self-contained SPA)
                    ├── GET /api/sessions  → all sessions as JSON
                    ├── GET /api/sessions/:id → single session
                    └── GET /api/events    → SSE stream
```

- **No dependencies** — uses only `Bun.serve()`, `fs.watch()`, and `EventSource`
- **Single HTML file** — no build step, no bundler
- **PAT stripped** — config data sent to browser never includes Azure DevOps tokens
- **Debounced file watch** — 200ms per work item to handle Windows duplicate events

## Files

| File | Purpose |
|------|---------|
| `types.ts` | `DashboardSession` and `StageProgress` DTOs |
| `state-reader.ts` | Reads state/config JSON, derives status, computes stage progression |
| `server.ts` | HTTP server + SSE + file watcher |
| `index.html` | Self-contained dark-theme SPA |
