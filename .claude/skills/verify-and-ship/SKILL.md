---
name: verify-and-ship
description: >-
  Run the full DevOpsWorker completion gate before declaring work done or
  deploying: typecheck the core and the composed overlay, run both test suites,
  rebuild the spawned-container image devopsworker:latest, verify it from the
  inside, then refresh the compose services. Use when the user says "verify",
  "ship it", "is this done", "run the completion gate", or before finishing a
  change that runs inside spawned containers.
disable-model-invocation: true
---

# verify-and-ship

The completion gate for DevOpsWorker. **Skipping the image rebuild is the classic
silent failure**: `docker compose` picks up code changes but the SPAWNED containers
keep running stale code — no error, just side effects (like DB writes) that never
happen. Run the steps in order; STOP and report at the first red step.

Report each step's real result (the decisive line of output). Never claim a step
passed that you skipped — say you skipped it and why.

## 1 — Typecheck (core + composed overlay)

```bash
bun run typecheck
bunx tsc --noEmit -p tsconfig.private.json   # skip if private/ is absent
```

## 2 — Tests (both suites)

```bash
bun run test
bun test --preload ./tests/setup.ts private/tests   # skip if private/ is absent
```

Never point these at the production DB — `tests/db/*` runs TRUNCATE/DELETE. Use a
throwaway `DATABASE_URL`.

## 3 — Rebuild the spawned-container image

Needed whenever the change runs inside spawned containers (anything under
`src/cli/review-pr.ts`, `src/agents/`, `src/sdk/`, `src/db/`). When unsure, rebuild.

```bash
pwsh private/deploy/docker-build.ps1   # builds devopsworker-public, then devopsworker:latest
```

## 4 — Verify the image from the inside (don't trust the build log)

```bash
MSYS_NO_PATHCONV=1 docker run --rm --entrypoint bash devopsworker:latest -c \
  'cat /app/node_modules/@anthropic-ai/claude-agent-sdk/package.json | jq -r .version; claude --version'
```

Confirm the versions/behavior you changed actually landed in the image.

## 5 — Refresh the compose services

```bash
docker compose build && docker compose up -d
```

Confirm postgres stays healthy. **NEVER `docker compose down -v`** — it destroys the
`devopsworker_pgdata` volume.
