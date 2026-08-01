/**
 * Stats & Config tab — data layer for the four `/api/stats/*` endpoints plus
 * `/api/drift`. Pure SQL + shaping: no `Request`/`Response`, no HTTP. Callers
 * (`server.ts`) wrap the plain objects returned here in `Response.json(...)`.
 *
 * Split deliberately into two layers:
 *  - pure shaping/mapper functions (exported, unit-testable with fixture
 *    data, no DB) — anything that combines two JSONB columns per row
 *    (model_usage + sub_agents, findings_count + findings_list) lives here,
 *    because that combination is awkward and opaque as a correlated SQL
 *    subquery but a one-line reduce in JS.
 *  - async `getXStats(sql, window)` functions that run the SQL and call the
 *    shaping functions. These are not unit-tested directly (would require a
 *    live DB, which is disallowed in tests) — their SQL shape is pinned by
 *    source-text assertions in tests/dashboard/stats.test.ts instead, mirroring
 *    tests/db/pg-pr-review-store-mapper.test.ts.
 *
 * `percentile_cont` is used in SQL for every true numeric percentile (cost,
 * duration, turns, dispatch count) per the plan's instruction that an average
 * hides the tail. Data volume is small (≤ ~1600 rows total today), so columns
 * that need per-row JSONB combination are fetched raw and shaped in JS rather
 * than forced into a correlated subquery.
 */
import { statSync } from 'node:fs';
import type postgres from 'postgres';
import type { PRFinding } from '../agents/pr-reviewer/schema.ts';

// ---------------------------------------------------------------------------
// Window handling — the one piece of "user input" every endpoint accepts.
// ---------------------------------------------------------------------------

export type StatsWindow = '7d' | '30d' | '90d';

const WINDOW_DAYS: Record<StatsWindow, number> = { '7d': 7, '30d': 30, '90d': 90 };

/** Below this row count, a statistic is a coin flip, not a trend. */
export const MIN_RELIABLE_SAMPLE = 10;

/**
 * Whitelist-clamp arbitrary query-string input to a known window. Anything
 * that isn't exactly `'7d'` or `'90d'` — including garbage, injection
 * attempts, and the literal `'30d'` — becomes `'30d'`. This is the only place
 * user input touches window selection; every query below consumes the
 * resulting `days` NUMBER through a parameterised `${days}`, never the raw
 * string, so there is no path from this value into SQL text.
 */
export function parseWindow(raw: string | null | undefined): StatsWindow {
  return raw === '7d' || raw === '90d' ? raw : '30d';
}

export function getWindowDays(window: StatsWindow): number {
  return WINDOW_DAYS[window];
}

export interface WindowMeta {
  window: StatsWindow;
  windowDays: number;
  /** ISO instant the window opens at, so the UI never has to recompute it. */
  since: string;
  sampleSize: number;
  /** True when `sampleSize < MIN_RELIABLE_SAMPLE` — every statistic in the
   *  response is a small-sample reading and must be rendered as such. */
  lowSample: boolean;
}

export function buildWindowMeta(window: StatsWindow, sampleSize: number, now: Date = new Date()): WindowMeta {
  const days = getWindowDays(window);
  return {
    window,
    windowDays: days,
    since: new Date(now.getTime() - days * 86_400_000).toISOString(),
    sampleSize,
    lowSample: sampleSize < MIN_RELIABLE_SAMPLE,
  };
}

function numOrNull(v: number | string | null | undefined): number | null {
  return v === null || v === undefined ? null : Number(v);
}

// ---------------------------------------------------------------------------
// Pure shaping — findings / severity
// ---------------------------------------------------------------------------

/** Read-band = critical + major (see review-cost-review skill: this is the
 *  one metric readers actually act on). Null `findingsList` (not attempted,
 *  or predates this capture) reads as 0, matching `jsonb_array_length(null)`
 *  being null-not-zero at the SQL layer — callers that need to distinguish
 *  "no findings recorded" from "recorded zero" must filter on
 *  `findingsList !== null` themselves before calling this. */
export function readBandCount(findingsList: PRFinding[] | null): number {
  if (!findingsList) return 0;
  return findingsList.filter((f) => f.severity === 'critical' || f.severity === 'major').length;
}

export function severityDistribution(rows: Array<PRFinding[] | null>): Record<string, number> {
  const dist: Record<string, number> = { critical: 0, major: 0, minor: 0, nitpick: 0 };
  for (const findings of rows) {
    if (!findings) continue;
    for (const f of findings) dist[f.severity] = (dist[f.severity] ?? 0) + 1;
  }
  return dist;
}

export function verdictDistribution(recommendations: Array<string | null>): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const rec of recommendations) {
    const key = rec ?? '(none)';
    dist[key] = (dist[key] ?? 0) + 1;
  }
  return dist;
}

export interface CostPerReadBandItem {
  avgCostUsd: number | null;
  avgReadBandItems: number | null;
  /** avgCostUsd / avgReadBandItems — null when there is nothing to divide by
   *  (no eligible rows, or every eligible row had zero read-band items). */
  value: number | null;
  sampleSize: number;
}

/**
 * Mirrors the review-cost-review skill's "the one metric that decides" query
 * exactly: divide the AVERAGE cost by the AVERAGE read-band count across
 * eligible rows, not a per-row division then averaged — the latter blows up
 * (or silently drops) on any row with zero read-band items.
 * Eligible = both `costUsd` and `findingsList` recorded (non-null).
 */
export function computeCostPerReadBandItem(
  rows: Array<{ costUsd: number | null; findingsList: PRFinding[] | null }>,
): CostPerReadBandItem {
  const eligible = rows.filter((r) => r.costUsd != null && r.findingsList != null);
  const n = eligible.length;
  if (n === 0) return { avgCostUsd: null, avgReadBandItems: null, value: null, sampleSize: 0 };
  const avgCostUsd = eligible.reduce((s, r) => s + r.costUsd!, 0) / n;
  const avgReadBandItems = eligible.reduce((s, r) => s + readBandCount(r.findingsList), 0) / n;
  return {
    avgCostUsd,
    avgReadBandItems,
    value: avgReadBandItems > 0 ? avgCostUsd / avgReadBandItems : null,
    sampleSize: n,
  };
}

/** `findings_count` (scalar column) and `jsonb_array_length(findings_list)`
 *  can disagree — data-shapes.md calls this an integrity signal to report,
 *  not reconcile. Returns false (not a mismatch) when either side is
 *  unrecorded, since there's nothing to compare. */
export function findingsCountMismatch(findingsCount: number | null, findingsList: PRFinding[] | null): boolean {
  if (findingsCount == null || findingsList == null) return false;
  return findingsCount !== findingsList.length;
}

// ---------------------------------------------------------------------------
// Pure shaping — cost / sub-agent apportionment
// ---------------------------------------------------------------------------

interface SubAgentCostUsage {
  apportionedCostUsd?: number;
}

/** Sums `sub_agents[*].apportionedCostUsd` — the value the codebase already
 *  computes at write time specifically to split an orchestrator's total cost
 *  from its dispatched sub-agents' share (see `SubAgentUsage` jsdoc in
 *  `src/types/pipeline.types.ts`). Null `subAgents` (no dispatches recorded)
 *  sums to 0. */
export function sumApportionedSubAgentCost(subAgents: Record<string, SubAgentCostUsage> | null): number {
  if (!subAgents) return 0;
  return Object.values(subAgents).reduce((sum, u) => sum + (u.apportionedCostUsd ?? 0), 0);
}

/** Below this coverage fraction, the split is more instrumentation-shaped
 *  than data-shaped: a majority of the window has no sub_agents object at
 *  all, so `orchestratorCostUsdMax` is dominated by absence of capture
 *  rather than by measured orchestrator-only spend. 50% (a plain majority)
 *  was chosen as a round, easily-explained bar — not tuned to any observed
 *  value. */
export const MIN_RELIABLE_COVERAGE_PCT = 50;

export interface SubAgentCoverage {
  /** Rows carrying at least one named sub-agent entry — i.e. `rosterCount > 0`.
   *  A row with `sub_agents: null` OR `sub_agents: {}` both count as
   *  uncovered: neither tells us anything about that row's actual sub-agent
   *  spend. */
  rowsWithSubAgentData: number;
  /** Same population `orchestratorCostUsdMax`/`subAgentCostUsdMin` are summed
   *  over (every row in the window, not `costSampleSize` — that field is
   *  scoped to rows with `cost_usd` recorded for the percentile stats, a
   *  different query with a different population). */
  totalRows: number;
  coveragePct: number | null;
  /** `coveragePct < MIN_RELIABLE_COVERAGE_PCT`. Null coverage (no rows) does
   *  NOT count as low — there's nothing to be unreliable about. */
  lowCoverage: boolean;
}

/**
 * Quantifies what fraction of the cost-split's own population actually has
 * sub-agent telemetry to apportion. `sub_agents` capture is recent — verified
 * live against production: 107 rows carry a non-empty `sub_agents` object as
 * of 2026-08-01, all dated 2026-07-26 or later, none before. Over a 30d
 * window that is only ~32% coverage; a wider window's coverage is lower
 * still. That absence is a SECOND, distinct cause of the orchestrator/
 * sub-agent split's upward bias, separate from the roster undercount
 * `orchestratorSubAgentSplit.note` already documents. A row missing
 * `sub_agents` because the column didn't exist yet contributes its entire
 * cost to `orchestratorCostUsdMax` the same way a row with an undercounted
 * roster does, but for a reason that has nothing to do with dispatch
 * counting — disclosure here lets a consumer tell the two apart.
 */
export function computeSubAgentCoverage(subAgentsColumn: Array<Record<string, unknown> | null>): SubAgentCoverage {
  const totalRows = subAgentsColumn.length;
  const rowsWithSubAgentData = subAgentsColumn.filter((sa) => rosterCount(sa) > 0).length;
  const coveragePct = totalRows > 0 ? (rowsWithSubAgentData / totalRows) * 100 : null;
  return {
    rowsWithSubAgentData,
    totalRows,
    coveragePct,
    lowCoverage: coveragePct != null && coveragePct < MIN_RELIABLE_COVERAGE_PCT,
  };
}

interface ModelUsageCost {
  costUsd?: number;
  output?: number;
}

export interface ModelUsageEntry {
  model: string;
  rows: number;
  totalCostUsd: number;
  totalOutputTokens: number;
  /** True when the key matches the `[1m]` long-context premium-tier suffix —
   *  the specific contamination data-shapes.md calls out by name. `model_usage`
   *  keys are an open set (never hardcode the "expected" list), so this is the
   *  one pattern-based flag we CAN assert without a canonical model roster. */
  flagged: boolean;
}

const FLAGGED_MODEL_PATTERN = /\[1m\]/i;

/** Aggregates `model_usage` (keyed by model id, open set — never hardcode a
 *  model list) across rows. Sorted by total cost descending so the biggest
 *  spender reads first. */
export function aggregateModelUsage(rows: Array<Record<string, ModelUsageCost> | null>): ModelUsageEntry[] {
  const totals = new Map<string, { rows: number; cost: number; output: number }>();
  for (const row of rows) {
    if (!row) continue;
    for (const [model, usage] of Object.entries(row)) {
      const entry = totals.get(model) ?? { rows: 0, cost: 0, output: 0 };
      entry.rows += 1;
      entry.cost += usage?.costUsd ?? 0;
      entry.output += usage?.output ?? 0;
      totals.set(model, entry);
    }
  }
  return [...totals.entries()]
    .map(([model, { rows: r, cost, output }]) => ({
      model,
      rows: r,
      totalCostUsd: cost,
      totalOutputTokens: output,
      flagged: FLAGGED_MODEL_PATTERN.test(model),
    }))
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd);
}

// ---------------------------------------------------------------------------
// Pure shaping — dispatch / roster (the known instrument fault)
// ---------------------------------------------------------------------------

/** `tool_calls->'Agent'` — THE authoritative dispatch count (never
 *  `sub_agents`'s key count; see data-shapes.md). Missing key or missing
 *  object reads as 0. */
export function dispatchCount(toolCalls: Record<string, number> | null): number {
  if (!toolCalls) return 0;
  const v = toolCalls['Agent'];
  return typeof v === 'number' ? v : 0;
}

/** The `sub_agents` roster size — known to undercount actual dispatches.
 *  Reported alongside `dispatchCount`, never in place of it. */
export function rosterCount(subAgents: Record<string, unknown> | null): number {
  return subAgents ? Object.keys(subAgents).length : 0;
}

/**
 * Defines the population the dispatch median/p90 are computed over: EVERY
 * row in the window, zero-filling a row with no `'Agent'` key via
 * `dispatchCount` (already 0 for that case) rather than excluding it.
 *
 * A missing `'Agent'` key means the tool was never invoked that run — a real
 * zero-dispatch observation (e.g. the cheap sanity/backport review path,
 * which fans out to no sub-agents), not absent telemetry. Excluding those
 * rows from the percentile — as the SQL previously did via
 * `WHERE tool_calls ? 'Agent'` — silently drops a real cluster of the
 * distribution and makes the reported `dispatch.sampleSize` (the full window)
 * disagree with the population the percentile actually ran over. This
 * function is the single source of truth for that population, on both the
 * JS side (`dispatchSampleSize` below) and, by construction, the SQL side —
 * `getIntegrityStats`'s dispatch-percentile query zero-fills with the same
 * `COALESCE(..., 0)` convention and applies no additional row filter, so its
 * population is provably this same one, not a query that has to be eyeballed
 * to match.
 */
export function dispatchCountsForPercentile(rows: Array<{ tool_calls: Record<string, number> | null }>): number[] {
  return rows.map((r) => dispatchCount(r.tool_calls));
}

// ---------------------------------------------------------------------------
// Pure shaping — per-sub-agent model attribution (contamination, observed side)
// ---------------------------------------------------------------------------

export interface SubAgentModelAttributionEntry {
  agent: string;
  /** `null` when the sub_agents entry has no `model` field recorded — never
   *  coerced to a fake model string. */
  model: string | null;
  count: number;
}

/**
 * Aggregates HOW MANY runs each named sub-agent (the `sub_agents` object KEY —
 * same identity `rosterCount` already uses) executed under each OBSERVED
 * model. This is the observed side only. Comparing it against each agent's
 * DECLARED frontmatter pin is deliberately NOT done here: the pin lives in
 * `ConfigReport` (`/api/config`), a separate, unwindowed endpoint this module
 * has no access to (and should not — see the module doc comment on layering).
 * The client (`stats-integrity.tsx`) already fetches both signals and does
 * the cross-reference where both are in hand.
 *
 * Sorted by agent name, then by count descending within an agent, so the
 * most common observed model for a given agent reads first.
 */
export function aggregateSubAgentModelAttribution(
  rows: Array<Record<string, { model?: string }> | null>,
): SubAgentModelAttributionEntry[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (!row) continue;
    for (const [agent, usage] of Object.entries(row)) {
      const model = usage?.model ?? null;
      totals.set(`${agent} ${model ?? ''}`, (totals.get(`${agent} ${model ?? ''}`) ?? 0) + 1);
    }
  }
  return [...totals.entries()]
    .map(([key, count]) => {
      const sep = key.indexOf(' ');
      const agent = key.slice(0, sep);
      const modelPart = key.slice(sep + 1);
      return { agent, model: modelPart === '' ? null : modelPart, count };
    })
    .sort((a, b) => a.agent.localeCompare(b.agent) || b.count - a.count);
}

// ---------------------------------------------------------------------------
// Pure shaping — tool mix
// ---------------------------------------------------------------------------

export interface ToolMixEntry {
  tool: string;
  totalCalls: number;
  /** Divided by the TOTAL row count in the window, not the count of rows
   *  that happen to carry this key — a tool absent from most rows (LSP is
   *  the expected case) must show a correspondingly low average, not one
   *  inflated by silently excluding the rows where it wasn't called. */
  avgPerReview: number;
  reviewsUsing: number;
}

/** Note: a tool that never appears as a key in ANY row's `tool_calls` for the
 *  whole window cannot be surfaced here at all — there's no roster of
 *  possible tool names to fall back on. This only guarantees that a tool
 *  present in *some* rows isn't dropped or averaged over a shrunk
 *  denominator just because it's rare (the LSP case: present in few rows,
 *  correctly reads as a low but non-zero average once it has appeared at
 *  least once). */
export function aggregateToolMix(rows: Array<Record<string, number> | null>): ToolMixEntry[] {
  const totals = new Map<string, { total: number; using: number }>();
  for (const row of rows) {
    if (!row) continue;
    for (const [tool, count] of Object.entries(row)) {
      const entry = totals.get(tool) ?? { total: 0, using: 0 };
      entry.total += count;
      if (count > 0) entry.using += 1;
      totals.set(tool, entry);
    }
  }
  const n = rows.length;
  return [...totals.entries()]
    .map(([tool, { total, using }]) => ({
      tool,
      totalCalls: total,
      avgPerReview: n > 0 ? total / n : 0,
      reviewsUsing: using,
    }))
    .sort((a, b) => b.totalCalls - a.totalCalls);
}

// ---------------------------------------------------------------------------
// Pure shaping — inferred effort (no effort column exists; this is a proxy)
// ---------------------------------------------------------------------------

export type EffortBand = 'high' | 'low' | 'other' | 'unknown';

/** Empirically observed bands (see CLAUDE.md DEFAULT_EFFORT notes) — NOT a
 *  guarantee, a proxy. Anything outside both ranges is 'other', not forced
 *  into the nearer band. */
const HIGH_EFFORT_RANGE: readonly [number, number] = [43_000, 56_000];
const LOW_EFFORT_RANGE: readonly [number, number] = [21_000, 27_000];

export function classifyEffort(outputTokens: number | null): EffortBand {
  if (outputTokens == null) return 'unknown';
  if (outputTokens >= HIGH_EFFORT_RANGE[0] && outputTokens <= HIGH_EFFORT_RANGE[1]) return 'high';
  if (outputTokens >= LOW_EFFORT_RANGE[0] && outputTokens <= LOW_EFFORT_RANGE[1]) return 'low';
  return 'other';
}

interface SubAgentTokenUsage {
  tokens?: { output?: number };
  /** Model this sub-agent ran on, as reported on its assistant messages —
   *  see `SubAgentUsage.model` in `pipeline.types.ts`. Optional here because
   *  older rows and the SDK's own `?` on that field both mean it may be
   *  absent; consumed by `aggregateSubAgentModelAttribution` below. */
  model?: string;
}

/**
 * The orchestrator's OWN output tokens = total output tokens across every
 * model in `model_usage` MINUS the sum of every dispatched sub-agent's
 * MEASURED output tokens (not apportioned — `SubAgentUsage.tokens` is
 * reported directly by the SDK per sub-agent, unlike `apportionedCostUsd`
 * which is derived). This holds regardless of whether the orchestrator and
 * its sub-agents share a model, because `model_usage` aggregates the whole
 * run including every sub-agent call.
 *
 * Caveat inherited from the sub_agents instrument fault: when a dispatch is
 * missing from the `sub_agents` roster (see `dispatchCount` vs
 * `rosterCount`), its output tokens are missing from the subtraction too, so
 * this OVERESTIMATES the orchestrator's true output on rows with an
 * undercounted roster. Null `modelUsage` (nothing recorded) returns null.
 */
export function orchestratorOutputTokens(
  modelUsage: Record<string, { output?: number }> | null,
  subAgents: Record<string, SubAgentTokenUsage> | null,
): number | null {
  if (!modelUsage) return null;
  const totalOutput = Object.values(modelUsage).reduce((s, u) => s + (u.output ?? 0), 0);
  const subAgentOutput = subAgents
    ? Object.values(subAgents).reduce((s, u) => s + (u.tokens?.output ?? 0), 0)
    : 0;
  return Math.max(0, totalOutput - subAgentOutput);
}

export interface EffortMix {
  high: number;
  low: number;
  other: number;
  unknown: number;
}

export function summarizeEffortMix(bands: EffortBand[]): EffortMix {
  const mix: EffortMix = { high: 0, low: 0, other: 0, unknown: 0 };
  for (const b of bands) mix[b]++;
  return mix;
}

export interface EffortDrift {
  overall: EffortMix;
  /** Earlier half of the window's rows by `createdAt`, oldest first. */
  earlierHalf: EffortMix;
  laterHalf: EffortMix;
}

/**
 * Splits the window at its row-count midpoint (by time) and reports the
 * inferred-effort mix in each half, so a shift in the high/low balance over
 * the window is visible without needing per-day buckets. `inferred: true`
 * belongs on the caller's response envelope — this is a proxy derived from
 * token counts, never a recorded fact.
 */
export function computeEffortDrift(
  entries: Array<{ createdAt: string; outputTokens: number | null }>,
): EffortDrift {
  const sorted = [...entries].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const mid = Math.floor(sorted.length / 2);
  const earlier = sorted.slice(0, mid);
  const later = sorted.slice(mid);
  const bandsOf = (xs: typeof sorted) => xs.map((x) => classifyEffort(x.outputTokens));
  return {
    overall: summarizeEffortMix(bandsOf(sorted)),
    earlierHalf: summarizeEffortMix(bandsOf(earlier)),
    laterHalf: summarizeEffortMix(bandsOf(later)),
  };
}

// ---------------------------------------------------------------------------
// Pure shaping — build provenance (image_sha)
// ---------------------------------------------------------------------------

export type ImageShaClass = 'sha' | 'unknown' | 'empty' | 'not-recorded';

/** The four possible `image_sha` states from data-shapes.md: a real sha, the
 *  literal string `"unknown"` (plain `docker compose build`), an empty string
 *  (raw `docker build` skipping the arg), or `null` (row predates the
 *  feature — every row today). Only `'sha'` is an actual build identifier;
 *  the other three must render as words, never as a sha-shaped string. */
export function classifyImageSha(value: string | null): ImageShaClass {
  if (value == null) return 'not-recorded';
  if (value === 'unknown') return 'unknown';
  if (value === '') return 'empty';
  return 'sha';
}

// ---------------------------------------------------------------------------
// HEAD resolution — git bind-mounted read-only at a FIXED, hardcoded path.
//
// The watcher/dashboard are themselves compose services (see docker-compose.yml),
// so HEAD drifting from what is actually running is exactly the failure class
// the status ribbon exists to catch. That requires a real git invocation, which
// is why this section is impure and sits apart from the pure shaping above: a
// unit test may not mock the filesystem or the subprocess (`mock.module()` is
// disallowed repo-wide), so the classification logic is kept pure and tested
// with fixture inputs, and only the thin wrapper touching git/fs is impure.
// ---------------------------------------------------------------------------

/** Read-only bind mount source — see the `dashboard` service in
 *  docker-compose.yml (`./.git:/repo/.git:ro`). Hardcoded on purpose: no
 *  request parameter, query string, or env var may choose which directory
 *  this process runs `git` against — that is the whole point of "fixed
 *  path". The only reason it is still a function *parameter* below (with
 *  this constant as its default) is so tests can point the same code at a
 *  real temporary git repo instead of mocking `fs`/`Bun.spawn`; every
 *  production call site (`getDriftStats`) calls with no override. */
const REPO_GIT_DIR = '/repo/.git';

/** Bounds every git subprocess so a wedged invocation (or a mount that hangs
 *  on stat) cannot hang the `/api/drift` request. 3s is generous for a
 *  `rev-parse`/`rev-list --count` against a local bind mount — a judgement
 *  call, not a measured figure. */
const GIT_TIMEOUT_MS = 3_000;

export type GitDirState = 'directory' | 'file' | 'missing';

/** What the fixed mount path actually is, checked BEFORE spawning git — this
 *  is what turns "a worktree's .git is a file, not a directory" into a
 *  distinct, sayable state instead of an opaque git error. Never throws:
 *  ENOENT and every other stat failure both read as `'missing'`, which is
 *  the expected, common case (no `/repo/.git` in local dev, in tests, or on
 *  any deployment predating this mount). */
export function statGitDir(path: string): GitDirState {
  try {
    return statSync(path).isDirectory() ? 'directory' : 'file';
  } catch {
    return 'missing';
  }
}

export type HeadUnresolvedReason = 'not-mounted' | 'not-a-directory' | 'command-failed' | 'timeout' | 'empty-output';

export interface HeadResolution {
  value: string | null;
  reason: HeadUnresolvedReason | null;
}

export interface GitInvocation {
  code: number;
  stdout: string;
  timedOut: boolean;
}

/** Turns a git-dir state plus an (optional) invocation result into the
 *  ribbon's first-class HEAD state. Pure — no filesystem, no subprocess — so
 *  every branch is unit-tested with fixture inputs rather than a mounted
 *  repo. `result` is `null` exactly when `dirState !== 'directory'`: there
 *  was nothing to invoke git against. */
export function classifyHeadResolution(dirState: GitDirState, result: GitInvocation | null): HeadResolution {
  if (dirState === 'missing') return { value: null, reason: 'not-mounted' };
  if (dirState === 'file') return { value: null, reason: 'not-a-directory' };
  if (!result || result.timedOut) return { value: null, reason: 'timeout' };
  if (result.code !== 0) return { value: null, reason: 'command-failed' };
  const sha = result.stdout.trim();
  return sha ? { value: sha, reason: null } : { value: null, reason: 'empty-output' };
}

/** Loose hex-sha check. Guards the one place a DB/env-sourced string (never a
 *  request parameter — see `computeCommitsBehindHead`) reaches a git
 *  argument: a value failing this never reaches `Bun.spawn`. Defends both
 *  against garbage (the literal `'unknown'`, `''`) and against git argument
 *  injection (a value starting with `-` being read as a flag instead of a
 *  revision) — a hex string can never start with `-`. */
const SHA_PATTERN = /^[0-9a-f]{4,40}$/i;
export function isPlausibleSha(value: string): boolean {
  return SHA_PATTERN.test(value);
}

/** Runs `git` against the FIXED `gitDir` with a hard timeout. Never throws:
 *  `Bun.spawn` throws SYNCHRONOUSLY when the executable is missing (see
 *  `src/sdk/git-run.ts` for the same caveat), so the spawn itself is inside
 *  the try/catch, not just the await. `args` is always a literal array built
 *  by this module's own callers — `isPlausibleSha` above is the one place
 *  external data (a sha) is allowed to reach it. */
async function runGitFixed(gitDir: string, args: string[], timeoutMs: number): Promise<GitInvocation> {
  // The spawn itself must stay inside this try: `Bun.spawn` throws
  // SYNCHRONOUSLY (not a rejected promise) when the executable is missing —
  // see `src/sdk/git-run.ts` for the same caveat. `proc` is also declared
  // with `const` inline (rather than pre-declared with a widened
  // `ReturnType<typeof Bun.spawn>`) so TS infers the exact `stdout: 'pipe'`
  // subprocess type instead of the generic union.
  try {
    const proc = Bun.spawn(['git', '-c', `safe.directory=${gitDir}`, `--git-dir=${gitDir}`, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<GitInvocation>((resolve) => {
      timer = setTimeout(() => {
        proc.kill();
        resolve({ code: -1, stdout: '', timedOut: true });
      }, timeoutMs);
    });
    const run = (async (): Promise<GitInvocation> => {
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return { code, stdout, timedOut: false };
    })();

    try {
      return await Promise.race([run, timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { code: -1, stdout: '', timedOut: false };
  }
}

/**
 * Resolves HEAD from the read-only bind mount. Never throws, never hangs
 * (see `GIT_TIMEOUT_MS`), and degrades to an explicit `HeadUnresolvedReason`
 * rather than a guess — a deploy without the mount (local dev, or any
 * environment predating this feature) resolves to `'not-mounted'`, not an
 * exception. `gitDir`/`timeoutMs` are only ever overridden by tests; the one
 * production call site (`getDriftStats`) uses the defaults.
 */
export async function resolveHeadSha(gitDir: string = REPO_GIT_DIR, timeoutMs: number = GIT_TIMEOUT_MS): Promise<HeadResolution> {
  const dirState = statGitDir(gitDir);
  if (dirState !== 'directory') return classifyHeadResolution(dirState, null);
  const result = await runGitFixed(gitDir, ['rev-parse', '--short', 'HEAD'], timeoutMs);
  return classifyHeadResolution(dirState, result);
}

/**
 * How many commits `sha` is behind `HEAD` in the mounted repo, or `null`
 * when it cannot be determined — NEVER `0` as a fallback (see
 * design-constraints.md: a coerced `0` reads as "in sync" and is the exact
 * lie this ribbon exists to prevent). `null` covers every failure mode
 * uniformly: the mount is absent, `sha` fails `isPlausibleSha`, `sha` is not
 * reachable in this repo's history (built elsewhere, or — this repo's own
 * history was rewritten in July 2026 — simply no longer present), or the
 * git call timed out.
 */
export async function computeCommitsBehindHead(
  sha: string,
  gitDir: string = REPO_GIT_DIR,
  timeoutMs: number = GIT_TIMEOUT_MS,
): Promise<number | null> {
  if (!isPlausibleSha(sha)) return null;
  if (statGitDir(gitDir) !== 'directory') return null;
  const result = await runGitFixed(gitDir, ['rev-list', '--count', `${sha}..HEAD`], timeoutMs);
  if (result.timedOut || result.code !== 0) return null;
  const n = Number(result.stdout.trim());
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// SQL — shared helpers
// ---------------------------------------------------------------------------

async function countInWindow(sql: postgres.Sql, days: number): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n
    FROM pr_reviews
    WHERE created_at > now() - (${days}::int * interval '1 day')
  `;
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// GET /api/stats/cost
// ---------------------------------------------------------------------------

export interface CostStats extends WindowMeta {
  medianCostUsd: number | null;
  p90CostUsd: number | null;
  avgCostUsd: number | null;
  totalCostUsd: number;
  costSampleSize: number;
  orchestratorSubAgentSplit: {
    /** True orchestrator spend is <= this. Forced by the apportionment
     *  arithmetic, not an estimate we chose to round conservatively: see
     *  `note`. */
    orchestratorCostUsdMax: number;
    /** True sub-agent spend is >= this. */
    subAgentCostUsdMin: number;
    /** = orchestratorCostUsdMax / totalCostUsd — an upper bound on the true
     *  share, for the same reason orchestratorCostUsdMax is. Null with 0
     *  total cost. */
    orchestratorSharePctMax: number | null;
    /** How much of THIS split's own population actually has sub-agent
     *  telemetry to apportion — see `computeSubAgentCoverage`. A low value
     *  means the split is dominated by rows with no sub_agents capture at
     *  all, not by measured orchestrator-only spend. */
    coverage: SubAgentCoverage;
    note: string;
  };
  costPerReadBandItem: CostPerReadBandItem;
  modelBreakdown: ModelUsageEntry[];
  perRepo: Array<{ repoKey: string; count: number; medianCostUsd: number | null; totalCostUsd: number | null }>;
  monthlyProjection: { value: number | null; basis: string };
}

export async function getCostStats(sql: postgres.Sql, window: StatsWindow): Promise<CostStats> {
  const days = getWindowDays(window);
  const totalN = await countInWindow(sql, days);

  const [percentiles] = await sql<Array<{ n: string; median: number | null; p90: number | null; total: number | null; avg: number | null }>>`
    SELECT count(*)::text AS n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY cost_usd) AS median,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY cost_usd) AS p90,
      sum(cost_usd) AS total,
      avg(cost_usd) AS avg
    FROM pr_reviews
    WHERE created_at > now() - (${days}::int * interval '1 day')
      AND cost_usd IS NOT NULL
  `;

  const rows = await sql<Array<{
    cost_usd: number | null;
    sub_agents: Record<string, SubAgentCostUsage> | null;
    findings_list: PRFinding[] | null;
    model_usage: Record<string, ModelUsageCost> | null;
  }>>`
    SELECT cost_usd, sub_agents, findings_list, model_usage
    FROM pr_reviews
    WHERE created_at > now() - (${days}::int * interval '1 day')
  `;

  const repoRows = await sql<Array<{ repo_key: string; n: string; median: number | null; total: number | null }>>`
    SELECT repo_key,
      count(*)::text AS n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY cost_usd) AS median,
      sum(cost_usd) AS total
    FROM pr_reviews
    WHERE created_at > now() - (${days}::int * interval '1 day')
      AND cost_usd IS NOT NULL
    GROUP BY repo_key
    ORDER BY sum(cost_usd) DESC NULLS LAST
  `;

  const subAgentCostTotal = rows.reduce((s, r) => s + sumApportionedSubAgentCost(r.sub_agents), 0);
  const totalCost = Number(percentiles?.total ?? 0);
  const orchestratorCost = Math.max(0, totalCost - subAgentCostTotal);

  return {
    ...buildWindowMeta(window, totalN),
    medianCostUsd: numOrNull(percentiles?.median),
    p90CostUsd: numOrNull(percentiles?.p90),
    avgCostUsd: numOrNull(percentiles?.avg),
    totalCostUsd: totalCost,
    costSampleSize: Number(percentiles?.n ?? 0),
    orchestratorSubAgentSplit: {
      orchestratorCostUsdMax: orchestratorCost,
      subAgentCostUsdMin: subAgentCostTotal,
      orchestratorSharePctMax: totalCost > 0 ? (orchestratorCost / totalCost) * 100 : null,
      coverage: computeSubAgentCoverage(rows.map((r) => r.sub_agents)),
      note:
        'subAgentCostUsdMin sums sub_agents[*].apportionedCostUsd (a model\'s total cost shared out by measured ' +
        "token count among its COUNTED contributors — see SubAgentUsage in src/types/pipeline.types.ts). That sum " +
        'always equals the model\'s true total by construction, so a dispatch missing from the sub_agents roster ' +
        "(a known, nondeterministic undercount vs tool_calls->'Agent' — see /api/stats/integrity) does not merely " +
        'go uncounted: its cost is forced into orchestratorCostUsdMax instead. The bias is one-directional and ' +
        'not a rounding choice — subAgentCostUsdMin can only read low and orchestratorCostUsdMax can only read high. ' +
        'A SECOND, distinct cause — instrumentation coverage, not roster undercount — has the same one-directional ' +
        'effect: sub_agents capture is a recent addition to the write path, so a row from before it existed has NO ' +
        'sub_agents object at all, regardless of how much it actually dispatched. See coverage for how much of ' +
        'this split rests on rows that predate that capture entirely, as opposed to rows where capture ran but ' +
        'undercounted the roster.',
    },
    costPerReadBandItem: computeCostPerReadBandItem(rows.map((r) => ({ costUsd: r.cost_usd, findingsList: r.findings_list }))),
    modelBreakdown: aggregateModelUsage(rows.map((r) => r.model_usage)),
    perRepo: repoRows.map((r) => ({
      repoKey: r.repo_key,
      count: Number(r.n),
      medianCostUsd: numOrNull(r.median),
      totalCostUsd: numOrNull(r.total),
    })),
    monthlyProjection: {
      value: days > 0 ? (totalCost / days) * 30 : null,
      basis: `linear extrapolation of the ${window} window total`,
    },
  };
}

// ---------------------------------------------------------------------------
// GET /api/stats/quality
// ---------------------------------------------------------------------------

export interface QualityStats extends WindowMeta {
  readBandSampleSize: number;
  avgReadBandItems: number | null;
  belowBandCount: number;
  belowBandPct: number | null;
  severityDistribution: Record<string, number>;
  verdictDistribution: Record<string, number>;
}

export async function getQualityStats(sql: postgres.Sql, window: StatsWindow): Promise<QualityStats> {
  const days = getWindowDays(window);
  const totalN = await countInWindow(sql, days);

  const rows = await sql<Array<{ findings_list: PRFinding[] | null; recommendation: string | null }>>`
    SELECT findings_list, recommendation
    FROM pr_reviews
    WHERE created_at > now() - (${days}::int * interval '1 day')
  `;

  const withFindings = rows.filter((r) => r.findings_list != null);
  const readBandCounts = withFindings.map((r) => readBandCount(r.findings_list));
  const belowBandCount = readBandCounts.filter((c) => c === 0).length;

  return {
    ...buildWindowMeta(window, totalN),
    readBandSampleSize: withFindings.length,
    avgReadBandItems: readBandCounts.length > 0 ? readBandCounts.reduce((a, b) => a + b, 0) / readBandCounts.length : null,
    belowBandCount,
    belowBandPct: withFindings.length > 0 ? (belowBandCount / withFindings.length) * 100 : null,
    severityDistribution: severityDistribution(rows.map((r) => r.findings_list)),
    verdictDistribution: verdictDistribution(rows.map((r) => r.recommendation)),
  };
}

// ---------------------------------------------------------------------------
// GET /api/stats/integrity
// ---------------------------------------------------------------------------

export interface IntegrityStats extends WindowMeta {
  modelUsage: {
    breakdown: ModelUsageEntry[];
    flaggedKeys: ModelUsageEntry[];
  };
  dispatch: {
    sampleSize: number;
    /** The population medianDispatch/p90Dispatch are actually computed over.
     *  Equal to `sampleSize` by construction — see `dispatchCountsForPercentile`
     *  for why zero-fill-all-rows was chosen over excluding rows with no
     *  'Agent' key. Reported explicitly rather than assumed equal, mirroring
     *  `costSampleSize` on `/api/stats/cost`. */
    dispatchSampleSize: number;
    medianDispatch: number | null;
    p90Dispatch: number | null;
    avgRosterCount: number | null;
    mismatchCount: number;
    mismatchRate: number | null;
    note: string;
  };
  inferredEffort: {
    inferred: true;
    bands: { high: readonly [number, number]; low: readonly [number, number] };
    drift: EffortDrift;
    note: string;
  };
  findingsIntegrity: {
    comparedRows: number;
    mismatchCount: number;
    mismatchRate: number | null;
  };
  errorRate: { count: number; total: number; rate: number | null };
  /** Observed per-sub-agent model attribution — the OTHER half of "model
   *  contamination" (`modelUsage.flaggedKeys` above is the `[1m]`-pattern
   *  half). Declared pins are NOT joined in here — see
   *  `aggregateSubAgentModelAttribution`'s doc comment for why that
   *  cross-reference belongs to the client, which already holds both
   *  `IntegrityStats` (windowed) and `ConfigReport` (unwindowed, declared
   *  pins) without this endpoint needing to reach across that boundary. */
  subAgentModelAttribution: {
    entries: SubAgentModelAttributionEntry[];
    note: string;
  };
}

export async function getIntegrityStats(sql: postgres.Sql, window: StatsWindow): Promise<IntegrityStats> {
  const days = getWindowDays(window);
  const totalN = await countInWindow(sql, days);

  const rows = await sql<Array<{
    tool_calls: Record<string, number> | null;
    sub_agents: Record<string, SubAgentTokenUsage> | null;
    model_usage: Record<string, ModelUsageCost> | null;
    findings_count: number | null;
    findings_list: PRFinding[] | null;
    error: string | null;
    created_at: string;
  }>>`
    SELECT tool_calls, sub_agents, model_usage, findings_count, findings_list, error, created_at::text
    FROM pr_reviews
    WHERE created_at > now() - (${days}::int * interval '1 day')
  `;

  // Zero-fills a missing 'Agent' key (COALESCE(...,0)) and applies no row
  // filter beyond the window — same population as `rows` above, and the same
  // convention `dispatchCountsForPercentile` uses on the JS side. See that
  // function's doc comment for why zero-fill-all-rows was chosen over
  // excluding rows with no dispatches.
  const [dispatchPercentiles] = await sql<Array<{ median: number | null; p90: number | null }>>`
    SELECT
      percentile_cont(0.5) WITHIN GROUP (ORDER BY COALESCE((tool_calls->>'Agent')::numeric, 0)) AS median,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY COALESCE((tool_calls->>'Agent')::numeric, 0)) AS p90
    FROM pr_reviews
    WHERE created_at > now() - (${days}::int * interval '1 day')
  `;

  const dispatchCounts = dispatchCountsForPercentile(rows);
  const rosterCounts = rows.map((r) => rosterCount(r.sub_agents));
  const mismatchCount = rows.filter((_, i) => dispatchCounts[i] !== rosterCounts[i]).length;
  const avgRosterCount = rosterCounts.length > 0 ? rosterCounts.reduce((a, b) => a + b, 0) / rosterCounts.length : null;

  const modelBreakdown = aggregateModelUsage(rows.map((r) => r.model_usage));

  const effortEntries = rows.map((r) => ({
    createdAt: r.created_at,
    outputTokens: orchestratorOutputTokens(r.model_usage, r.sub_agents),
  }));

  const comparedForFindings = rows.filter((r) => r.findings_count != null && r.findings_list != null);
  const findingsMismatchCount = rows.filter((r) => findingsCountMismatch(r.findings_count, r.findings_list)).length;

  const errorCount = rows.filter((r) => r.error != null).length;

  const subAgentModelAttribution = aggregateSubAgentModelAttribution(rows.map((r) => r.sub_agents));

  return {
    ...buildWindowMeta(window, totalN),
    modelUsage: {
      breakdown: modelBreakdown,
      flaggedKeys: modelBreakdown.filter((m) => m.flagged),
    },
    dispatch: {
      sampleSize: rows.length,
      dispatchSampleSize: dispatchCounts.length,
      medianDispatch: numOrNull(dispatchPercentiles?.median),
      p90Dispatch: numOrNull(dispatchPercentiles?.p90),
      avgRosterCount,
      mismatchCount,
      mismatchRate: rows.length > 0 ? mismatchCount / rows.length : null,
      note:
        "tool_calls->'Agent' is the authoritative dispatch count. sub_agents roster undercounts nondeterministically " +
        '— never report roster count alone as "how many agents ran". medianDispatch/p90Dispatch are computed over ' +
        "EVERY row in the window (dispatchSampleSize == sampleSize by construction): a row with no 'Agent' key is a " +
        'real zero-dispatch review (e.g. the cheap sanity path), zero-filled rather than excluded.',
    },
    inferredEffort: {
      inferred: true,
      bands: { high: HIGH_EFFORT_RANGE, low: LOW_EFFORT_RANGE },
      drift: computeEffortDrift(effortEntries),
      note:
        'No effort column exists. Bands are inferred from orchestrator output tokens (model_usage totals minus ' +
        'measured sub-agent output) and inherit the sub_agents undercount as an overestimate of the orchestrator share.',
    },
    findingsIntegrity: {
      comparedRows: comparedForFindings.length,
      mismatchCount: findingsMismatchCount,
      mismatchRate: comparedForFindings.length > 0 ? findingsMismatchCount / comparedForFindings.length : null,
    },
    errorRate: {
      count: errorCount,
      total: rows.length,
      rate: rows.length > 0 ? errorCount / rows.length : null,
    },
    subAgentModelAttribution: {
      entries: subAgentModelAttribution,
      note:
        'Observed models only — sub_agents is a known, nondeterministic undercount of true dispatch counts ' +
        "(see dispatch.mismatchRate above): a dispatch missing from this roster has no model recorded here at " +
        'all. Model contamination could therefore be WORSE than these counts show, never better. This field ' +
        "reports what ran, not whether it matched what was pinned — cross-reference against each agent's " +
        'declared frontmatter pin (/api/config) to find actual deviations.',
    },
  };
}

// ---------------------------------------------------------------------------
// GET /api/stats/operational
// ---------------------------------------------------------------------------

export interface OperationalStats extends WindowMeta {
  reviewsPerDay: {
    average: number | null;
    series: Array<{ date: string; count: number }>;
  };
  duration: { medianMs: number | null; p90Ms: number | null; sampleSize: number };
  turns: { median: number | null; p90: number | null; sampleSize: number };
  toolMix: ToolMixEntry[];
  perRepo: Array<{ repoKey: string; count: number; medianDurationMs: number | null; medianTurns: number | null }>;
}

export async function getOperationalStats(sql: postgres.Sql, window: StatsWindow): Promise<OperationalStats> {
  const days = getWindowDays(window);
  const totalN = await countInWindow(sql, days);

  const [durationTurns] = await sql<Array<{
    n: string; medianDuration: number | null; p90Duration: number | null; medianTurns: number | null; p90Turns: number | null;
  }>>`
    SELECT count(*)::text AS n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS "medianDuration",
      percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms) AS "p90Duration",
      percentile_cont(0.5) WITHIN GROUP (ORDER BY turns) AS "medianTurns",
      percentile_cont(0.9) WITHIN GROUP (ORDER BY turns) AS "p90Turns"
    FROM pr_reviews
    WHERE created_at > now() - (${days}::int * interval '1 day')
  `;

  const dailyRows = await sql<Array<{ day: string; n: string }>>`
    SELECT date_trunc('day', created_at)::date::text AS day, count(*)::text AS n
    FROM pr_reviews
    WHERE created_at > now() - (${days}::int * interval '1 day')
    GROUP BY 1
    ORDER BY 1
  `;

  const toolRows = await sql<Array<{ tool_calls: Record<string, number> | null }>>`
    SELECT tool_calls
    FROM pr_reviews
    WHERE created_at > now() - (${days}::int * interval '1 day')
  `;

  const repoRows = await sql<Array<{ repo_key: string; n: string; medianDuration: number | null; medianTurns: number | null }>>`
    SELECT repo_key, count(*)::text AS n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS "medianDuration",
      percentile_cont(0.5) WITHIN GROUP (ORDER BY turns) AS "medianTurns"
    FROM pr_reviews
    WHERE created_at > now() - (${days}::int * interval '1 day')
    GROUP BY repo_key
    ORDER BY count(*) DESC
  `;

  return {
    ...buildWindowMeta(window, totalN),
    reviewsPerDay: {
      average: days > 0 ? totalN / days : null,
      series: dailyRows.map((r) => ({ date: r.day, count: Number(r.n) })),
    },
    duration: {
      medianMs: numOrNull(durationTurns?.medianDuration),
      p90Ms: numOrNull(durationTurns?.p90Duration),
      sampleSize: Number(durationTurns?.n ?? 0),
    },
    turns: {
      median: numOrNull(durationTurns?.medianTurns),
      p90: numOrNull(durationTurns?.p90Turns),
      sampleSize: Number(durationTurns?.n ?? 0),
    },
    toolMix: aggregateToolMix(toolRows.map((r) => r.tool_calls)),
    perRepo: repoRows.map((r) => ({
      repoKey: r.repo_key,
      count: Number(r.n),
      medianDurationMs: numOrNull(r.medianDuration),
      medianTurns: numOrNull(r.medianTurns),
    })),
  };
}

// ---------------------------------------------------------------------------
// GET /api/drift
// ---------------------------------------------------------------------------

export interface DriftStats extends WindowMeta {
  head: HeadResolution;
  composeService: {
    value: string | null;
    classification: ImageShaClass;
    source: string;
    /** Commits `value` is behind the live-resolved HEAD, or `null` when it
     *  cannot be computed — HEAD itself is unresolved, `value` is not a real
     *  sha, or `value` is not reachable in the mounted repo's history. Never
     *  `0` as a stand-in for "unknown" (see `computeCommitsBehindHead`). */
    commitsBehindHead: number | null;
  };
  spawnedImage: {
    mostRecentSha: {
      value: string | null;
      classification: ImageShaClass;
      recordedAt: string | null;
      commitsBehindHead: number | null;
    };
    distribution: Array<{ classification: ImageShaClass; count: number }>;
  };
  /** First-class "nothing recorded yet" state — true only once at least one
   *  row anywhere in the table carries a real sha. Every row today is null,
   *  so this is currently always false; the UI must render that as an
   *  explicit state, not an empty/broken panel. */
  provenanceRecorded: boolean;
}

export async function getDriftStats(
  sql: postgres.Sql,
  window: StatsWindow,
  buildSha: string | null = process.env['BUILD_SHA'] ?? null,
): Promise<DriftStats> {
  const days = getWindowDays(window);
  const totalN = await countInWindow(sql, days);

  const [mostRecent] = await sql<Array<{ image_sha: string; created_at: string }>>`
    SELECT image_sha, created_at::text
    FROM pr_reviews
    WHERE image_sha IS NOT NULL AND image_sha <> '' AND image_sha <> 'unknown'
    ORDER BY created_at DESC
    LIMIT 1
  `;

  const windowRows = await sql<Array<{ image_sha: string | null }>>`
    SELECT image_sha
    FROM pr_reviews
    WHERE created_at > now() - (${days}::int * interval '1 day')
  `;

  const distribution = new Map<ImageShaClass, number>([
    ['sha', 0],
    ['unknown', 0],
    ['empty', 0],
    ['not-recorded', 0],
  ]);
  for (const r of windowRows) {
    const cls = classifyImageSha(r.image_sha);
    distribution.set(cls, (distribution.get(cls) ?? 0) + 1);
  }

  // HEAD is resolved live from a read-only bind mount (docker-compose.yml,
  // dashboard service) rather than hardcoded — the watcher/dashboard ARE
  // compose services, so a HEAD that has moved past what is actually running
  // is exactly the failure this ribbon exists to surface. Distance-from-HEAD
  // is only ever computed once HEAD itself resolved: a distance without a
  // HEAD to anchor it is a number nobody could trust, so both git calls below
  // are skipped entirely (left `null`) rather than run against a meaningless
  // reference.
  const head = await resolveHeadSha();
  const composeClassification = classifyImageSha(buildSha);
  const mostRecentClassification = classifyImageSha(mostRecent?.image_sha ?? null);
  let composeCommitsBehind: number | null = null;
  let spawnedCommitsBehind: number | null = null;
  if (head.value) {
    [composeCommitsBehind, spawnedCommitsBehind] = await Promise.all([
      composeClassification === 'sha' && buildSha ? computeCommitsBehindHead(buildSha) : Promise.resolve(null),
      mostRecentClassification === 'sha' && mostRecent ? computeCommitsBehindHead(mostRecent.image_sha) : Promise.resolve(null),
    ]);
  }

  return {
    ...buildWindowMeta(window, totalN),
    head,
    composeService: {
      value: buildSha,
      classification: composeClassification,
      source: "this dashboard process's BUILD_SHA env var",
      commitsBehindHead: composeCommitsBehind,
    },
    spawnedImage: {
      mostRecentSha: mostRecent
        ? {
            value: mostRecent.image_sha,
            classification: mostRecentClassification,
            recordedAt: mostRecent.created_at,
            commitsBehindHead: spawnedCommitsBehind,
          }
        : { value: null, classification: mostRecentClassification, recordedAt: null, commitsBehindHead: null },
      distribution: [...distribution.entries()].map(([classification, count]) => ({ classification, count })),
    },
    provenanceRecorded: (distribution.get('sha') ?? 0) > 0 || mostRecent != null,
  };
}
