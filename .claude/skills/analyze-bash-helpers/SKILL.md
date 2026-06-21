---
name: analyze-bash-helpers
description: Use when asked to find recurring Bash patterns in agent telemetry (pr-reviewer OR pipeline stages — coder, planner, analyzer, etc.) that should become helper scripts (to cut turns + tokens), OR to measure uptake of a recently-deployed helper (before/after comparison).
---

# Analyze Bash Helper Candidates

Surfaces recurring Bash patterns from `stage_logs` so they can be replaced by a one-line helper — reducing the agent writing the same ad-hoc boilerplate (inline `python3 -c "import json…"`, repeated grep/find skeletons, file-path digging) across runs.

Works against two row classes in the same table:
- `entity_type='pull_request'` — PR-reviewer rows. Grouping dimension: `agent_name` (orchestrator vs sub-agent).
- `entity_type='work_item'` — pipeline-stage rows (coding, planning, analyzer, test-cases, docs-writer, draft-pr). Grouping dimension: `stage_name`. **Note**: `agent_name` is currently NULL on these until the `PgLogSink` attribution wiring lands; treat `stage_name` as the primary axis here.

## When to use

- **Uptake check** after deploying a new helper (e.g., a new `scripts/parse-mcp.ts` subcommand or a new CLAUDE.md guidance section) — compare the pre-deploy window to the post-deploy window to see if the recurring pattern actually dropped.
- **New-helper discovery** — run periodically (monthly-ish) to surface what's still expensive.
- **Sanity check** before approving a CLAUDE.md or tool change, to baseline current friction.

## Inputs

When invoked, ask the user (or use defaults):
- `--entity-type <pull_request|work_item|all>` — which row class to analyze. Default `pull_request` (back-compat). `work_item` covers pipeline stages; `all` unions both and adds an `entity_type` column to the report.
- `--stage-name <name>` — optional. Restrict to one stage (e.g., `coding`, `planning`). Only meaningful with `--entity-type work_item` or `all`. Omit to break down by stage in the report.
- `--since <ts-or-relative>` — analysis window start. Default `now() - interval '7 days'`. Accepts SQL-style relatives.
- `--compare-to <ts>` — optional second window-start to enable before/after diff. The "since" window is treated as the *after*; `compare-to` is the *before*. Window length matches `since`.
- `--top <n>` — number of clusters to surface. Default 20.
- `--min-count <n>` — minimum frequency to report a cluster. Default 3.

## Procedure

### 1. Pull Bash inputs
Run this against the local Postgres (docker container `devopsworker-postgres-1`, db `pipeline`).

For `--entity-type pull_request` (default):
```sql
SELECT id, work_item_id AS pr_id, stage_name, agent_name, review_run_id, content, created_at
FROM stage_logs
WHERE entity_type = 'pull_request'
  AND content LIKE '%TOOL INPUT: Bash%'
  AND created_at >= <since>
ORDER BY id;
```

For `--entity-type work_item`:
```sql
SELECT id, work_item_id, stage_name, agent_name, content, created_at
FROM stage_logs
WHERE entity_type = 'work_item'
  AND content LIKE '%TOOL INPUT: Bash%'
  AND created_at >= <since>
  [AND stage_name = <stage-name>]   -- only if --stage-name set
ORDER BY id;
```

For `--entity-type all`: drop the `entity_type =` predicate and keep it as a SELECT column so the report can split.

Repeat with the `--compare-to` window if set.

### 2. Extract the `command` field
Each `content` is a logger block:
```
--- TOOL INPUT: Bash ---
{
  "command": "...",
  "description": "..."
}
--- end TOOL INPUT: Bash ---
```
Parse out `command` (and optionally `description`). Multi-line commands have escaped newlines inside the JSON string.

### 3. Normalize each command into a "skeleton"
Replace volatile substrings with placeholders so similar commands cluster:
- File paths after `tool-results/` → `<MCP_RESULT>` (collapsing the random hash + timestamp).
- Hex IDs / UUIDs → `<HASH>`.
- Numeric IDs (PR numbers, line ranges like `--lines 100-150`, head/tail `-c N` / `-n N`) → `<NUM>`.
- Anything inside `python3 -c "…"` longer than 80 chars → `<PY-SCRIPT-(json|re|http|os|…)>` keyed by whichever imports/calls appear (so `json.loads` scripts cluster apart from `re.findall` scripts).
- Bare absolute-paths under `/workspace/session/<repo>/` → `<REPO>/...` keeping the suffix structure.

### 4. Cluster + rank
Group commands by skeleton. For each cluster, compute:
- `freq` — total occurrences.
- `runs` — distinct run count. For `pull_request` rows use `review_run_id`; for `work_item` rows use `work_item_id` (pipeline has no per-stage run id yet).
- `breakdown` — for `pull_request` rows split by `agent_name`; for `work_item` rows split by `stage_name` (and `agent_name` once attribution lands).
- `avg_len` — average command length (proxy for output tokens saved if replaced).
- `score = freq * avg_len / 100` (rough "tokens you'd save by replacing this with a one-liner").

Sort by score desc. Drop clusters with `freq < --min-count`.

### 5. Per cluster, suggest a helper
For each of the top clusters:
- **Recognize** known patterns and label them:
  - `cat <MCP_RESULT> | python3 -c "<PY-json>"` parsing `get_pull_request_changes` → already replaceable by `parse-mcp changes <file>` (commit `7ad2ea9`).
  - `... get_file_content …` → `parse-mcp file-content`.
  - `... list_repositories …` → `parse-mcp repos`.
  - `... search_code …` → `parse-mcp search`.
  - `find /workspace/session -name '*.al' -path '*/Cloud/*'` → candidate for a `local-find <pattern>` helper.
  - Repeated `git -C <repo> diff origin/A...origin/B -- '*.al' ':!*.xlf'` → candidate for a `pr-diff` script if local-first is reconsidered.
- **Otherwise**, sketch the helper: what arguments + what output. Don't propose anything if the cluster is plausibly one-off intentional work.

### 6. If `--compare-to` is set
Run the same clustering on the older window. Diff the clusters by skeleton:
- **Helpers working** — clusters whose freq dropped substantially after the deploy date (call out the % drop).
- **Helpers not yet adopted** — known helpers that should match a cluster but their freq didn't drop (or new helper command barely appears) — flag for prompt-revision.
- **New candidates** — clusters that are persistent or growing.

### 7. Report

Print a markdown table to the user. Schema (column set adapts to `--entity-type`):

```
=== Bash pattern analysis (<entity-type>): <window-after> [vs <window-before>] ===
Total commands: <after total>  (before: <before total>)  Runs: <after runs>  (before: <before runs>)

Top clusters (score desc):
# entity-type=pull_request:
| # | freq (Δ) | reviews | agents | example | suggested helper / status |
|---|----------|---------|--------|---------|--------------------------|

# entity-type=work_item:
| # | freq (Δ) | items | stages | example | suggested helper / status |
|---|----------|-------|--------|---------|--------------------------|

# entity-type=all:
| # | freq (Δ) | entity | runs | breakdown | example | suggested helper / status |
|---|----------|--------|------|-----------|---------|--------------------------|

Helpers WORKING (when --compare-to set):
- parse-mcp changes:  freq 67 → 9  (-87%)  ✓
- ...

Helpers NOT YET ADOPTED:
- parse-mcp repos:  detected helper but still 14 inline python parses of list_repositories  → check CLAUDE.md placement / agent prompt
- ...

NEW candidates:
- find /workspace/session -name '*.al' …  freq=18  reviews=8  → suggested: local-find <pattern>
- ...
```

If output is short, print directly. If long, write to `docs/superpowers/plans/bash-helper-analysis-<date>.md` and link.

## Special-case invocation: "parse-mcp uptake check"

For the specific check after the 2026-05-27 parse-mcp helpers deploy (commit `7ad2ea9`, image `369192a4abd2`):

```
--since '2026-05-27T16:00Z' --compare-to '2026-05-20T00:00Z'
```

The expected signal: clusters labeled `inline python3 parsing tool-results/mcp-azureDevOps-{get_pull_request_changes,list_repositories,search_code}` should drop in frequency. The new helpers' bash signature (`bun /app/scripts/parse-mcp.ts <subcmd> …`) should appear in the post window.

If a known cluster did NOT drop, that means the agent isn't reading or trusting the new CLAUDE.md "Helpers for Spilled MCP Results" section — that's a prompt problem, not a script problem.

## Notes / limitations

- Telemetry began 2026-05-25 (Phase 1 instrumentation, `PgPrReviewLogSink`). Older Bash inputs live in `/state/logs/pr-reviews/<prId>/*.log` on the `do-pipeline-state` volume — readable via `docker run --rm -v do-pipeline-state:/state alpine grep …` but not as queryable as the DB.
- Pipeline-stage rows (`entity_type='work_item'`) were always captured by `PgLogSink`, so the work_item history goes back further than PR-reviewer. But `agent_name` is NULL on those rows until the `PgLogSink.setAgentName` wiring lands — sub-agent attribution within a stage is not currently distinguishable. Use `stage_name` as the breakdown axis.
- Cluster normalization is heuristic; tune the substitutions per emergent pattern. If the top cluster looks too coarse (different intents collapsing) or too fine (same intent splitting), adjust the regexes.
- The "tokens saved" estimate is rough; actual savings depend on how the agent invokes the helper (one Bash call vs writing the python).

## Related

- `scripts/parse-mcp.ts` — current helper script. Add new subcommands here when a new pattern is identified.
- `src/agents/pr-reviewer/CLAUDE.md` — "Helpers for Spilled MCP Results" section. Update with copy-paste examples for any new helper to drive adoption.
- `src/agents/<stage>/CLAUDE.md` — when a work_item-class helper is identified (e.g., for the coder stage), add the copy-paste example to that stage's CLAUDE.md, not the pr-reviewer's.
- `docs/superpowers/plans/baseline-prs.md` — Phase 1/2 gate data + post-mortem; useful baselines.
