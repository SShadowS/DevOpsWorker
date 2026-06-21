# DevOpsWorker

Multi-agent AI pipeline that takes Azure DevOps work items through analysis, planning, coding, review, and PR creation — orchestrated by a chain of specialized Claude agents with human-in-the-loop approval gates. Also provides automated PR reviews for manually-created pull requests via webhook integration.

```mermaid
flowchart TD
    START([analyse tag]) --> A[Analyzer]
    A --> B[Planner]
    B <-->|revise / approve| C[Plan Reviewer]
    B --> CP1{{Plan Checkpoint}}
    CP1 --> ENV[Env Provision]
    ENV --> D[Coder]
    D <-->|revise / approve| E[Code Reviewer]
    D --> TC[Test Cases]
    TC --> F[Draft PR]
    F --> CP2{{PR Checkpoint}}
    CP2 --> G[Documenter]
    G --> DONE([Done])

    style CP1 fill:#f9a825,stroke:#f57f17,color:#000
    style CP2 fill:#f9a825,stroke:#f57f17,color:#000
```

## Quick Start

### Docker Compose (recommended)

```bash
# Create .env with required variables
cat >> .env <<EOF
AZURE_DEVOPS_PAT=your-pat
CLAUDE_CODE_OAUTH_TOKEN=your-token
DATABASE_URL=postgres://pipeline:pipeline@postgres:5432/pipeline
EOF

# Start the full stack (PostgreSQL + watcher + dashboard + webhook server)
docker compose up -d

# Dashboard: http://localhost:3000
# Webhook server: http://localhost:3001
```

### Local Development

```bash
# Install dependencies
bun install

# Start PostgreSQL
docker compose up -d postgres

# Set required env vars (or add to .env — Bun auto-loads it)
export AZURE_DEVOPS_PAT="your-pat"
export CLAUDE_CODE_OAUTH_TOKEN="your-token"  # or ANTHROPIC_API_KEY
export DATABASE_URL="postgres://pipeline:pipeline@localhost:5432/pipeline"

# Run pipeline for a work item
bun run pipeline -- run --work-item <id> --session <path>

# Resume a paused/failed pipeline
bun run pipeline -- continue --work-item <id>

# Check pipeline status
bun run pipeline -- status --work-item <id>

# Watch mode — polls ADO for tagged work items
bun run pipeline -- watch [--interval <minutes>] [--concurrency <n>]

# Launch dashboard
bun run dashboard

# Start webhook server (receives Azure DevOps PR events)
bun run pipeline -- webhook-server [--port <n>]
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AZURE_DEVOPS_PAT` | Yes | Azure DevOps personal access token |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `CLAUDE_CODE_OAUTH_TOKEN` | Yes* | Claude MAX subscription token (run `claude setup-token`) |
| `ANTHROPIC_API_KEY` | Yes* | Pay-per-token fallback (takes precedence if both set) |
| `PG_PASSWORD` | No | PostgreSQL password (default: `pipeline`) |
| `AZURE_DEVOPS_ORG` | No | Org name (default: `your-org`; normally set via the overlay `ado` defaults — see [Private Overlay](#private-overlay)) |
| `AZURE_DEVOPS_PROJECT` | No | Project name (default: `Your Project`; normally set via the overlay `ado` defaults) |
| `AZURE_DEVOPS_WEBHOOK_SECRET` | No | HMAC secret for webhook signature validation |
| `WEBHOOK_PORT` | No | Webhook server port (default: `3002`) |

\* One of `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` is required.

Environment-provisioning variables (BC test environments) are contributed by the
overlay's `envProvider`, not the core — see [Private Overlay](#private-overlay).

## Private Overlay

The public core ships with **empty registries** — no repositories, no environment
backend, no proprietary prompts. Site-specific and proprietary configuration lives
in a gitignored `private/` overlay that the core loads at runtime. No forking
required, and any number of consumers can share the same public codebase, each with
their own overlay.

A `private/manifest.ts` (TypeScript, imported natively by Bun) contributes:

| Field | Adds |
|-------|------|
| `repos` | Azure DevOps repositories the pipeline operates on |
| `companions` | Read-only dependency repos cloned alongside the target |
| `models` | Per-agent model overrides |
| `ado` | Azure DevOps org / project / area-path defaults |
| `pipeline` | Declarative stage edits (insert / replace / remove, anchored by stage name) |
| `envProvider` | Backend for provisioning ephemeral test environments |

Overlay directory resolution: `--private-dir` flag → `PRIVATE_DIR` env →
default-probe `./private`. With no overlay present, `loadManifest()` returns `{}`
and the core runs unchanged.

### Getting started

Copy the worked skeleton in [`private.example/`](private.example/) to `private/`:

```bash
cp -r private.example private
# then edit private/manifest.ts + private/config/repos.ts with your values
```

[`private.example/README.md`](private.example/README.md) enumerates every injection
point; [`docs/extending.md`](docs/extending.md) covers the three extensibility axes
(stages, agents, agent providers).

### Portability (no symlinks)

`private/` is a real directory — typically its own git repo — not a symlink, so it
clones cleanly onto any machine next to the public checkout:

```bash
git clone <public-repo> devopsworker
git clone <your-private-repo> devopsworker/private   # default-probe finds ./private
```

In containers the overlay is **bind-mounted** (Compose services, and watcher-spawned
containers via `HOST_PRIVATE_DIR`), never baked into the image — the published image
stays overlay-free.

## Development

```bash
bun run typecheck          # tsc --noEmit (strict mode)
bun run test               # Unit tests (fast, no credentials)
bun run test:integration   # Real API tests (needs credentials)
bun run test:all           # Unit + integration
```

## Architecture

### Stage Abstraction

Everything in the pipeline is a `Stage` (interface in `src/types/pipeline.types.ts`). Three stage factories compose the pipeline:

- **`agentStage()`** — wraps an `AgentConfig<T>` into a Stage
- **`revisionLoop()`** — pairs producer + reviewer with circuit breaker (max N attempts)
- **`checkpoint()`** — human approval gate that polls for tags, PR status, or `/rerun-*` comments

The orchestrator (`src/pipeline/orchestrator.ts`) is stage-agnostic — it iterates the stage array, calls `canRun()` then `execute()`, and persists state after each step.

### Agent Convention

Each agent lives in `src/agents/<name>/` as a mini Claude Code project:

```
src/agents/<name>/
  config.ts        # AgentConfig + stage factory function
  schema.ts        # Zod schema for structured output
  CLAUDE.md        # Agent instructions (role, goals, rules)
  .claude/skills/  # Optional agent-specific skills
```

To iterate on agent behavior: **edit the agent's `CLAUDE.md`** — no TypeScript changes needed. Agents use `settingSources: ['project']` which auto-loads their CLAUDE.md.

### Agents

| Agent | Model | Purpose |
|-------|-------|---------|
| **analyzer** | opus | Assesses work item readiness, extracts requirements |
| **planner** | sonnet | Produces development plan with file-level changes |
| **plan-reviewer** | opus | Evaluates plan quality and feasibility |
| **coder** | sonnet | Writes code, commits, triggers CI |
| **code-reviewer** | opus | 7-domain parallel review via specialized subagents |
| **test-cases** | sonnet | Creates ADO Test Case work items |
| **draft-pr** | sonnet | Creates draft PR in Azure DevOps |
| **documenter** | sonnet | Generates user-facing documentation |
| **docs-writer** | sonnet | Drafts documentation site articles |
| **rule-learner** | opus | Extracts coding patterns from PR reviews |
| **env-reprovision** | opus | Recreates purged BC environments, deploys existing PR code |
| **pr-reviewer** | opus | Reviews manually-created PRs using 7 parallel analysis sub-agents |

### Standalone Agents

Some agents run outside the pipeline orchestrator, triggered by dashboard actions, PR comments, or webhooks:

- **env-reprovision** — Recreates a purged BC environment and deploys the existing PR code. Triggered by the "Reprovision Env" dashboard button or a `/reprovision-env` PR comment.
- **pr-reviewer** — Reviews non-pipeline PRs using 7 parallel analysis sub-agents (correctness, quality, security, performance, architecture, error handling, integration). Triggered by the webhook server when a PR is created or updated.

### State Storage

Pipeline state is stored in PostgreSQL (JSONB columns). All services (watcher, dashboard, webhook server, pipeline containers) connect via the `DATABASE_URL` environment variable over the `pipeline-net` Docker network. Tables: `pipeline_state`, `pipeline_config`, `stage_logs`, `actions` (queue), `runner_status`, `webhook_events`.

Schema is managed by `src/db/postgres.ts` — `CREATE TABLE IF NOT EXISTS` on first connection. Store implementations in `src/db/pg-*.ts` implement interfaces from `src/pipeline/*-store.interface.ts`. The `connectStores()` helper (`src/db/connect-stores.ts`) creates all store instances from `DATABASE_URL`.

**Migrating from SQLite:**

```bash
docker compose up -d postgres
DATABASE_URL=postgres://pipeline:pipeline@localhost:5432/pipeline \
  bun scripts/migrate-sqlite-to-pg.ts --sqlite .pipeline/state/pipeline.db
```

### Two Azure DevOps Integration Paths

- **Agents** use the `@sshadows/mcp-server-azure-devops` MCP server for reasoning-heavy operations
- **Orchestrator** uses the REST client (`src/sdk/azure-devops-client.ts`) for deterministic polling

### Human Interaction Points

| Action | Where | How |
|--------|-------|-----|
| Trigger pipeline | Work item | Add tag `analyse` |
| Approve plan | Work item | Add tag `plan-approved` |
| Publish PR | Pull request | Remove draft status |
| Redo planning | Work item | Comment `/rerun-plan` |
| Targeted fix | Pull request | Comment `/fix <feedback>` |
| Reprovision env | Pull request | Comment `/reprovision-env` (or dashboard button) |

## Project Structure

```
src/
  agents/          # Agent directories (config + schema + CLAUDE.md each)
  cli/             # CLI commands (run, continue, status, watch, dashboard, webhook-server)
  dashboard/       # Web UI for monitoring and actions
  db/              # Database (PostgreSQL stores, connection, SQLite legacy)
  formatters/      # Output formatting (telemetry, PR comments)
  pipeline/        # Orchestrator, stages, checkpoints, revision loops, interfaces
  prompts/         # Shared prompt fragments appended to agent presets
  sdk/             # Claude Agent SDK wrapper, Azure DevOps REST client, MCP configs
  types/           # TypeScript interfaces (PipelineState, PipelineConfig, AgentConfig)
  webhook-server/  # Azure DevOps webhook receiver (PR events)
tests/             # Mirrors src/ structure, uses bun:test
docs/              # Design specs and implementation plans
private.example/   # Worked overlay skeleton — copy to private/ to customize
private/           # Gitignored overlay (your repos, prompts, env backend); absent in public clones
```

## Docker Compose

The full stack runs as four services on a shared `pipeline-net` Docker network:

| Service | Port | Description |
|---------|------|-------------|
| `postgres` | 5432 | PostgreSQL 17 — shared state store |
| `watcher` | — | Polls Azure DevOps, spawns pipeline containers |
| `dashboard` | 3000 | Web UI for monitoring and actions |
| `webhook-server` | 3001 | Receives Azure DevOps PR webhook events |

```bash
docker compose up -d              # Start everything
docker compose up -d postgres     # PostgreSQL only
docker compose logs -f watcher    # Follow watcher logs
docker compose down               # Stop everything
```

Pipeline containers are spawned by the watcher onto `pipeline-net`, giving them direct access to PostgreSQL via `DATABASE_URL=postgres://pipeline:...@postgres:5432/pipeline`.

## Webhook Server

The webhook server receives Azure DevOps service hook events and triggers automated PR reviews for manually-created pull requests.

```bash
# Start the webhook server
bun run pipeline -- webhook-server --port 3002
```

### Setup

1. Start the webhook server alongside the watcher and dashboard
2. In Azure DevOps, go to **Project Settings > Service hooks**
3. Create subscriptions for:
   - `Pull request created` → `POST https://your-server:3002/webhook`
   - `Pull request updated` → `POST https://your-server:3002/webhook`
4. Set the webhook secret (optional but recommended) matching `AZURE_DEVOPS_WEBHOOK_SECRET`

### How It Works

1. Webhook arrives → signature validated → payload parsed
2. Repository matched against known repos in `src/config/repos.ts`
3. Pipeline-created PRs are skipped (checks `pipeline_state` table)
4. Non-pipeline PRs get a `review-pr` action queued in PostgreSQL
5. The watcher picks up the action and dispatches the `pr-reviewer` agent
6. The agent runs 7 parallel analysis sub-agents and posts a review comment to the PR

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/webhook` | POST | Receive Azure DevOps events |
| `/health` | GET | Health check (`{"ok": true, "uptime": ...}`) |

Webhook events are persisted for 7 days (for debugging/replay) and automatically cleaned up.

## Error Handling

All pipeline errors extend `PipelineError` (`src/sdk/errors.ts`). On error, state is persisted with error details; `continue` retries from the failed stage.

| Error Type | When |
|------------|------|
| `AgentExecutionError` | Agent SDK call fails |
| `AgentValidationError` | Agent output doesn't match Zod schema |
| `ExternalServiceError` | Azure DevOps API failure |
| `CheckpointTimeoutError` | Human didn't respond within timeout |
| `RevisionExhaustedError` | Revision loop hit max attempts |

## License

Licensed under the [Apache License 2.0](LICENSE) — see [`LICENSE`](LICENSE) and
[`NOTICE`](NOTICE). The gitignored `private/` overlay is not part of this
repository and is not covered by this license.
