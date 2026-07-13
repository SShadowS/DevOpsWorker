# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
bun run typecheck          # tsc --noEmit (strict mode)
bun run test               # Unit tests only (fast, no credentials needed)
bun run test:integration   # Real API tests (needs Claude auth + optionally AZURE_DEVOPS_PAT + TEST_WORK_ITEM_ID)
bun run test:all           # Unit + integration
bun run pipeline -- run --work-item <id> --session <path>
bun run pipeline -- continue --work-item <id>
bun run pipeline -- status --work-item <id>
bun run pipeline -- watch [--interval <minutes>]
```

Required env vars: `AZURE_DEVOPS_PAT`, `DATABASE_URL` (PostgreSQL connection string), plus one of: `CLAUDE_CODE_OAUTH_TOKEN` (recommended — Claude MAX subscription, run `claude setup-token` to generate) or `ANTHROPIC_API_KEY` (pay-per-token fallback; takes precedence over OAuth if both set). Bun auto-loads `.env` from the project root — no dotenv library needed.

## Updating Dependencies (the Claude Agent SDK ships often)

The SDK + CLI update almost daily. Two mechanisms keep this safe and routine:

- **`SDK Canary`** CI workflow (`.github/workflows/sdk-canary.yml`) runs daily: bumps the SDK to
  latest (no commit) and runs typecheck + the unit suite. A red canary = a new SDK release broke
  something — investigate before adopting. Trigger manually via the Actions tab.
- **`bun scripts/update-deps.ts`** adopts + verifies an update locally:
  ```bash
  bun scripts/update-deps.ts --sdk-only   # bump just the SDK, typecheck + test
  bun scripts/update-deps.ts               # bump ALL deps to latest, typecheck + test
  ```
  On green: commit `package.json` + `bun.lock`, push, **rebuild the prod image**
  (`pwsh private/deploy/docker-build.ps1` — bakes the new deps into `devopsworker:latest`), and
  re-pin the overlay + internal-tooling `CORE_REF`/submodule to the new core tag so their CI follows.

## What This Is

Multi-agent DevOps pipeline that takes Azure DevOps work items through a chain of 7 AI agents (analysis → planning → coding → PR → documentation) using the Claude Agent SDK. Human-in-the-loop checkpoints gate plan approval and PR publishing. Revision loops auto-iterate on planning and coding when reviewers request changes.

## Repository Layout — Know Which Repo You Are In

**This repo is the public core. Anything site-specific belongs elsewhere.** A deployment
composes the core with a private overlay:

| What | Where | Commit here? |
|---|---|---|
| Core pipeline: `src/`, `Dockerfile`, core tests | this repo (public) | yes — generic code only |
| Private overlay: site agents, deploy scripts, repo registry, internal docs | `private/` — **a separate git repo**, gitignored here | no — commit inside `private/` |

The core gitignores `./private` and default-probes it at runtime, so a workspace is just
this repo with the overlay cloned into `private/`. Before you commit, check which repo the
file you touched lives in — `git -C private status` is a different repo from `git status`.

**Never put in this repo:** customer/tenant names, internal tool invocations, internal repo
URLs, environment IDs, or design docs. See "Where Docs Go" below.

A deployment keeps its own instructions in `CLAUDE.local.md` at the workspace root
(gitignored — it names internal repos, tools, and environments). If that file exists, read it.

## Architecture

### Stage Abstraction

Everything in the pipeline is a `Stage` (interface in `src/types/pipeline.types.ts`): agent stages, revision loops, and checkpoints. The orchestrator (`src/pipeline/orchestrator.ts`) is stage-agnostic — it iterates the stage array, calls `canRun()` then `execute()`, and persists state after each step.

Three stage factories compose the pipeline:
- **`agentStage()`** (`src/pipeline/stage.ts`) — wraps an `AgentConfig<T>` into a Stage, handles `runAgent()` call + telemetry
- **`revisionLoop()`** (`src/pipeline/revision-loop.ts`) — wraps producer + reviewer stages into a loop with circuit breaker (max N attempts)
- **`checkpoint()`** (`src/pipeline/checkpoint.ts`) — human approval gate that polls Azure DevOps for tags, PR status, or `/rerun-*` comments

The default pipeline is assembled in `src/pipeline/pipeline-definition.ts`.

### State Flow

`PipelineState` is an accumulated bag — each stage reads what it needs and writes its output field. State is persisted to PostgreSQL (JSONB columns in `pipeline_state` and `pipeline_config` tables). The `pipeline continue` command loads state and resumes from the current stage.

### PostgreSQL

All pipeline state, actions, logs, and webhook events are stored in PostgreSQL. Connection via `DATABASE_URL` env var (e.g., `postgres://pipeline:pipeline@localhost:5432/pipeline`).

**Starting the stack:**
```bash
docker compose up -d          # Starts PostgreSQL + watcher + dashboard + webhook-server
docker compose up -d postgres # PostgreSQL only (for local development)
```

**Store architecture:** All stores implement interfaces with `Promise<T> | T` return types (`src/pipeline/*-store.interface.ts`), allowing both sync (SQLite) and async (PostgreSQL) implementations. The `connectStores()` helper (`src/db/connect-stores.ts`) creates all PostgreSQL store instances from `DATABASE_URL`.

**Migration from SQLite:**
```bash
docker compose up -d postgres
DATABASE_URL=postgres://pipeline:pipeline@localhost:5432/pipeline bun scripts/migrate-sqlite-to-pg.ts --sqlite .pipeline/state/pipeline.db
```

**Schema:** Managed by `src/db/postgres.ts` — `CREATE TABLE IF NOT EXISTS` on connect. Tables: `pipeline_state`, `pipeline_config`, `stage_logs`, `actions`, `runner_status`, `webhook_events`.

**Backups:** The `pg-backup` compose service runs daily `pg_dump` and keeps 7 days of gzipped backups in `./backups/`. Backups run automatically with `docker compose up -d`.

```bash
# List available backups
ls -la backups/

# Restore from a backup (stops all services, restores, restarts)
docker compose stop watcher dashboard webhook-server
docker compose exec -T postgres psql -U pipeline -d pipeline -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
gunzip -c backups/pipeline-20260330-221800.sql.gz | docker compose exec -T postgres psql -U pipeline -d pipeline
docker compose up -d

# Take a manual backup right now
docker compose exec pg-backup sh -c 'pg_dump -h postgres -U pipeline pipeline | gzip > /backups/pipeline-manual-$(date +%Y%m%d-%H%M%S).sql.gz'
```

**Important:** Always use `docker compose down` or `docker compose stop` for clean shutdown. Force-killing Docker on Windows can corrupt PostgreSQL WAL, causing data loss on recovery. Named volumes help but are not a full guarantee on WSL2 — backups are the safety net.

### Agent Convention

Each agent lives in `src/agents/<name>/` as a mini Claude Code project:
- `config.ts` — `AgentConfig<T>` definition + stage factory function
- `schema.ts` — Zod schema for structured output
- `CLAUDE.md` — Agent instructions (role, goals, approach, rules)
- `.claude/skills/` — Optional agent-specific skills

**Overlay overrides (private deployments):** the public `CLAUDE.md` / `.claude/`
files are defaults. A private overlay at `private/agents/<name>/` may:
- ship a full `CLAUDE.md` to **replace** the public prompt, **or** a
  `CLAUDE.append.md` to **add** to it (mutually exclusive — replace wins);
- ship `.claude/` (rules/skills) which is copy-merged over the base;
- set typed knobs (`model`, `allowedTools`, `maxTurns`, `sharedPromptFragments`)
  via `OverlayManifest.agents['<name>']`.
Overrides are folded by `resolveAgentKnobs` at the `runAgent` chokepoint and
apply in both local and container runs.

Agents use the Claude Code `claude_code` system prompt preset with `settingSources: ['project']`, which loads the agent's `CLAUDE.md` automatically. Shared prompt fragments in `src/prompts/` are appended via the preset's `append` parameter. The `agent-workspace.ts` utility stages the agent's `CLAUDE.md` and `.claude/` into the agent's cwd via symlinks before each run and cleans up afterward.

To iterate on agent behavior: edit the agent's `CLAUDE.md` — no TypeScript changes needed.

### Two Azure DevOps Integration Paths

- **Agents** use the `@sshadows/mcp-server-azure-devops` MCP server (configured in `src/sdk/mcp-configs.ts`) for reasoning-heavy operations (creating PRs, reading work items with context)
- **Orchestrator** uses the REST client (`src/sdk/azure-devops-client.ts`) for deterministic polling (tag checks, PR status, comment scanning, posting comments)

### Tool Scoping

Each agent's `allowedTools` restricts what it can access. Tool sets are defined in `src/sdk/mcp-configs.ts` (e.g., `fsReadOnly`, `fsReadWrite`, `fsAndBash`, plus LSP variants `fsReadOnlyWithLSP`, `fsAndBashWithLSP`). Analyzer gets read-only + LSP; Coder gets full bash + git + LSP. The `Skill` tool is automatically enabled for agents with `.claude/skills/`.

### Checkpoint Rewind

When a `/rerun-plan` or `/fix` comment is detected, the checkpoint sets `revisionFeedback.targetStage` to the revision loop name (e.g., `'planning'` or `'coding'`). The orchestrator rewinds to that stage. The `rewindToStage` field in `CheckpointConfig` controls this mapping.

## Development Principles

Follow TDD, SOLID, and DRY — all within reason. Write tests before implementation where practical, keep responsibilities separated, and extract shared logic when duplication is real (not hypothetical). Don't over-engineer: three similar lines are fine if an abstraction would obscure intent.

## Error Hierarchy

All pipeline errors extend `PipelineError` in `src/sdk/errors.ts`. Key types: `AgentExecutionError`, `AgentValidationError`, `ExternalServiceError`, `CheckpointTimeoutError`, `RevisionExhaustedError`. The REST client throws `AzureDevOpsError` (plain `Error`, not `PipelineError`) — the orchestrator wraps it with the correct stage name. On error, state is persisted with the error details; `pipeline continue` retries from the failed stage.

## Testing

Tests live in `tests/` mirroring `src/` structure. Uses `bun:test` (`import { describe, test, expect, mock } from 'bun:test'`).

- **Do NOT use `mock.module()`** for mocking imports — it contaminates other test files in the same Bun process. Instead, replace `globalThis.fetch` directly and restore in `afterEach`.
- Mock fetch pattern: `globalThis.fetch = mock(() => Promise.resolve(new Response(...))) as unknown as typeof fetch` (double-cast needed for Bun's fetch type).
- Agent `buildPrompt` uses `state.field!` (non-null assertion) because `canRun()` guards ensure the field exists before `execute()` is called.

## Where Docs Go

This repo is public. Internal design docs — specs, plans, status, anything naming a
specific customer, environment, or internal tool — belong in the private overlay at
`private/internal-docs/`, never in `docs/` and never in the repo root. `docs/superpowers/`
is gitignored to enforce this.

Public docs that ship here: `README.md`, `docs/extending.md`, and this file.

## Project Status

Update `private/internal-docs/ProjectStatus.md` after structural changes (new files,
resolved TODOs, new capabilities). It is an overlay file — it does not exist in this repo.

## Coder Agent Working Directory

The Coder agent operates inside the target extension repo (a separate git repo) within the session path. It branches from the repo's default branch, writes AL code to the configured source/test directories, commits, and triggers the repo's configured CI pipeline via `az pipelines run`. (Concrete repo coordinates — branch, paths, pipeline id — come from the repo registration, supplied by the private overlay.)

## Docker Container & AL LSP Plugin

### Container Architecture

**Image builds — the container is split into a generic public base + a deployment overlay:**

1. **`devopsworker-public:latest`** — the generic public base (`Dockerfile` at the repo root). Builds the
   core pipeline + AL tooling, bakes NO env-tool backend. Has a `/entrypoint.d/*.sh` hook the deploy
   overlay uses.
2. **`devopsworker:latest`** — the production image the watcher spawns (`DEFAULT_IMAGE_NAME` in
   `src/cli/watch.ts`). Built `FROM devopsworker-public` by the deployment overlay's `deploy/Dockerfile`
   (`private/deploy/`), which adds the overlay's env CLI + any baked apps + a hook script that sets
   `ENV_CLI` and a Ninja-authorized git email. This is the image agents actually run in.
3. **`devopsworker-{watcher,dashboard,webhook-server}:latest`** — built by `docker compose build`. Used
   only by the compose services themselves. NOT used for spawned containers.

When you change code that runs inside spawned containers (anything in `src/cli/review-pr.ts`,
`src/agents/`, `src/sdk/`, `src/db/`, etc.), rebuild the production image via the deploy script (it
builds both stages), then the compose services:

```bash
pwsh private/deploy/docker-build.ps1           # builds devopsworker-public, then devopsworker:latest
docker compose build                           # Rebuild compose service images
docker compose up -d                           # Restart services
```

Forgetting to rebuild `devopsworker:latest` is a common pitfall — compose services pick up code changes but spawned containers silently run stale code. Symptoms: no errors, but side effects (like DB writes) don't happen.

The entrypoint (`docker/entrypoint.sh`) handles git credentials, repo cloning, AL extension fetching, and AL LSP plugin setup before dropping to the `pipeline` user.

### AL LSP Plugin in Containers

The AL LSP plugin gives agents `hover`, `documentSymbol`, `findReferences`, etc. for AL code intelligence. Getting it working in containers required solving several issues:

**Plugin resolution (`resolveAlLspPlugin()` in `src/sdk/mcp-configs.ts`):**
- The plugin directory contains both version subdirs (`1.6.1/`) and files (`plugin.json`, `.lsp.json`, `bin/`). `readdirSync` + sort picks the last entry alphabetically — filter to `^\d+\.\d+` directories only, or it picks `plugin.json` (a file) instead of the version dir.

**Version directory symlinks (entrypoint):**
- The entrypoint creates a version subdir with symlinks to plugin contents. Bash glob `*` skips dotfiles, so `.lsp.json` (the critical file Claude Code reads to register LSP tools) was missing. Use `ls -A` instead of glob `*` to include dotfiles.

**`.lsp.json` is mandatory:**
- Without `.lsp.json` in the plugin's version directory, Claude Code registers the plugin but does NOT expose the `LSP` tool. The plugin appears loaded but agents see no LSP tool. This is the most subtle failure mode — everything looks correct but the tool silently doesn't appear.

**Path mangling from Git Bash (testing only):**
- When running `docker run -e AL_EXTENSION_PATH=/state/...` from Git Bash on Windows, MSYS2 converts `/state/` to `C:/Program Files/Git/state/`. Use `MSYS_NO_PATHCONV=1` prefix for manual testing. Not an issue in production — the entrypoint sets paths inside the container.

**`.NET` runtime dependency:**
- The AL Language Server (`Microsoft.Dynamics.Nav.EditorServices.Host`) is a `.NET` app requiring `libicu72`. Without it, the binary crashes with "Couldn't find a valid ICU package". Added to `Dockerfile` apt-get.

**Claude Code marketplace files:**
- Do NOT add `known_marketplaces.json` to the container. It causes Claude Code CLI to hang trying to clone plugins from GitHub at startup. Plugins are passed via SDK `query()` options instead.

### Testing LSP in Containers

```bash
# Tool visibility test (does agent see LSP tool?)
MSYS_NO_PATHCONV=1 docker run --rm --entrypoint bash \
  -v do-pipeline-state:/state -v "path/to/scripts:/app/scripts" \
  -v "path/to/AL/project:/workspace/al-project" --env-file .env \
  devopsworker:latest -c '... setup ... bun scripts/test-lsp-availability.ts /workspace/al-project'

# Direct LSP binary test (does the Go wrapper respond?)
printf "Content-Length: N\r\n\r\n{initialize request}" | timeout 15 /path/to/al-lsp-wrapper
```

### Watcher Detection Paths

The `pipeline watch` command polls Azure DevOps and dispatches work automatically. It detects work via five paths (in `src/cli/watch.ts`):

1. **`analyse` tag** → `start-fresh` — new work item with no existing state
2. **`plan-approved` tag** → `continue-pipeline` — checkpoint-paused item ready to proceed
3. **`resume` tag** → `continue-pipeline` — error-state item to retry from failed stage (clears error, removes tag)
4. **Rerun comments** (`/rerun-plan`, `/fix`) → `continue-pipeline` — checkpoint-paused item with human feedback in comments
5. **PR completed** (`status === 'completed'`) → `continue-pipeline` — auto-detected for items paused at `pr-completed` checkpoint, no manual tag/comment needed

### Error Recovery

On pipeline error, the watcher adds `need-input` and removes `analyse`. The error comment posted to the work item lists recovery options:

1. **`resume` tag** — add to work item; watcher picks it up, clears error, resumes from failed stage
2. **Dashboard** — use the "Retry" button
3. **CLI** — `bun run pipeline -- continue --work-item <id>`
4. **Re-analyse** — re-tag with `analyse` (restarts from scratch)

### A/B Testing Agent Prompt Strategies

```bash
bun scripts/ab-test-lsp.ts --task <task.md> --models sonnet --docker --runs 3 --concurrency 10 --yes
bun scripts/ab-test-lsp.ts --task <task.md> --filter baseline,operation-mapping-plus-append --docker --runs 3 --yes
bun scripts/ab-test-lsp.ts --task <task.md> --cwd <al-project> --dry-run  # local, no Docker
```

Tests different LSP prompt configurations in Docker containers. Variants defined in `scripts/ab-test-lsp/variants.ts`. Results written to `scripts/ab-results/`. Must rebuild the Docker image after changing scripts: `pwsh private/deploy/docker-build.ps1`

### LSP Prompt Strategy (empirically validated)

The `operation-mapping-plus-append` configuration achieved 1.00 LSP ratio on Sonnet. It uses:
1. **CLAUDE.md**: Operation-mapping guide (task→LSP operation lookup table) — the critical channel
2. **systemPrompt.append**: `src/prompts/lsp-reinforcement.md` — reinforcement in system prompt
3. **.claude/rules/USE-AL-LSP-TOOLS.md**: Kept for triple-channel reinforcement

**Anti-patterns (empirically confirmed to backfire):**
- Negative framing ("NEVER use Grep") — makes agent avoid LSP entirely
- Telling agent what NOT to do ("don't overuse documentSymbol") — kills all LSP usage
- Putting LSP instructions only in rules or only in append — CLAUDE.md is required
- Sonnet follows LSP instructions far better than Opus; don't use aggressive prompting on Opus

### Docker Container Environment

`REPO_CONFIG`, `REPO_URL`, `REPO_BRANCH` are NOT in `.env` — they come from the repo registry (`src/config/repos.ts`, populated by the overlay) and must be passed as `-e` flags to `docker run`. The A/B test framework handles this via `--repo <key>`. The `.env` file is passed via `--env-file .env` for auth tokens and `DATABASE_URL`.

> Deployment-overlay specifics (the env CLI binary, any baked apps such as activation
> packages, the two-stage image build, and BuildKit-secret handling) live with the
> overlay's `deploy/` directory and its build script — not in the public core.
