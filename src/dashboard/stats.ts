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
import { DID_LABELS } from '../db/finding-outcome-mapper.ts';
import { MIN_RELIABLE_COVERAGE_PCT } from './coverage-thresholds.ts';
import { countOf, agree, itThem } from './count-phrase.ts';

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

// ---------------------------------------------------------------------------
// Population handling — keeps A/B and probe runs out of production
// statistics. `getDriftStats` and `buildConfigReport` do NOT take this
// parameter: drift is a fact about images, and config a fact about the
// environment, neither of which has a test population.
// ---------------------------------------------------------------------------

export type Population = 'prod' | 'test';

/**
 * Whitelist-clamp arbitrary query-string input to a population. Anything
 * that is not exactly `'test'` becomes `'prod'`. Mirrors `parseWindow`'s
 * shape exactly: this is the only place user input touches population
 * selection, and the resulting value is converted to a BOOLEAN
 * (`isTestFlag`) before it reaches SQL — never interpolated as text.
 */
export function parsePopulation(raw: string | null | undefined): Population {
  return raw === 'test' ? 'test' : 'prod';
}

export function isTestFlag(population: Population): boolean {
  return population === 'test';
}

/** Present on every population-aware payload (cost/quality/integrity/
 *  operational) — deliberately NOT on `DriftStats`, which has no test
 *  population (see the section comment above). `otherPopulationCount` is the
 *  count of rows in the same window carrying the OPPOSITE `is_test` flag, so
 *  an exclusion is never silent — reported even when it is zero. */
export interface PopulationMeta {
  population: Population;
  otherPopulationCount: number;
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

/** Re-exported (imported at the top of this file) so existing
 *  `import { MIN_RELIABLE_COVERAGE_PCT } from './stats.ts'` call sites
 *  (`tests/dashboard/stats.test.ts`) keep working unchanged. The real
 *  declaration lives in `coverage-thresholds.ts` — a zero-dependency leaf
 *  module — because `stats-costquality.tsx` (client, browser-bundled) needs
 *  this SAME value for its own `findings_list` coverage check and cannot
 *  import it from here: this module is server-only (`node:fs`,
 *  `Bun.spawn`), so a client file may only ever `import type` from it, never
 *  a value. See `coverage-thresholds.ts`'s doc comment for the full
 *  reasoning and why the two coverage checks share one constant rather than
 *  two identically-valued copies. */
export { MIN_RELIABLE_COVERAGE_PCT };

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
  // Nested map (agent -> model -> count) rather than a single string-joined
  // key: agent names and model ids are free-form strings, so concatenating
  // them behind any separator character risks a collision (or, as originally
  // shipped in fix round 1, an actual embedded control byte in the source —
  // corrected here, no behaviour change, same population/tests). A `null`
  // model is stored under the `null` key itself (Map supports non-string
  // keys), never coerced into part of a string.
  const totals = new Map<string, Map<string | null, number>>();
  for (const row of rows) {
    if (!row) continue;
    for (const [agent, usage] of Object.entries(row)) {
      const model = usage?.model ?? null;
      const perModel = totals.get(agent) ?? new Map<string | null, number>();
      perModel.set(model, (perModel.get(model) ?? 0) + 1);
      totals.set(agent, perModel);
    }
  }
  const entries: SubAgentModelAttributionEntry[] = [];
  for (const [agent, perModel] of totals) {
    for (const [model, count] of perModel) {
      entries.push({ agent, model, count });
    }
  }
  return entries.sort((a, b) => a.agent.localeCompare(b.agent) || b.count - a.count);
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

/**
 * Same as `countInWindow`, scoped to one population — used by every endpoint
 * below that accepts a `population` parameter, both for its own
 * `sampleSize` (`testFlag`) and its `otherPopulationCount` (`!testFlag`).
 * Kept as a separate function rather than an optional parameter on
 * `countInWindow` so `getDriftStats`'s own call — which has no population
 * concept — stays exactly as it was.
 */
async function countInWindowForPopulation(sql: postgres.Sql, days: number, testFlag: boolean): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n
    FROM pr_reviews
    WHERE created_at > now() - (${days}::int * interval '1 day')
      AND is_test = ${testFlag}
  `;
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// GET /api/stats/cost
// ---------------------------------------------------------------------------

export interface CostStats extends WindowMeta, PopulationMeta {
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

export async function getCostStats(sql: postgres.Sql, window: StatsWindow, population: Population): Promise<CostStats> {
  const days = getWindowDays(window);
  const testFlag = isTestFlag(population);
  const totalN = await countInWindowForPopulation(sql, days, testFlag);
  const otherPopulationCount = await countInWindowForPopulation(sql, days, !testFlag);

  const [percentiles] = await sql<Array<{ n: string; median: number | null; p90: number | null; total: number | null; avg: number | null }>>`
    SELECT count(*)::text AS n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY cost_usd) AS median,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY cost_usd) AS p90,
      sum(cost_usd) AS total,
      avg(cost_usd) AS avg
    FROM pr_reviews
    WHERE created_at > now() - (${days}::int * interval '1 day')
      AND cost_usd IS NOT NULL
      AND is_test = ${testFlag}
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
      AND is_test = ${testFlag}
  `;

  const repoRows = await sql<Array<{ repo_key: string; n: string; median: number | null; total: number | null }>>`
    SELECT repo_key,
      count(*)::text AS n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY cost_usd) AS median,
      sum(cost_usd) AS total
    FROM pr_reviews
    WHERE created_at > now() - (${days}::int * interval '1 day')
      AND cost_usd IS NOT NULL
      AND is_test = ${testFlag}
    GROUP BY repo_key
    ORDER BY sum(cost_usd) DESC NULLS LAST
  `;

  const subAgentCostTotal = rows.reduce((s, r) => s + sumApportionedSubAgentCost(r.sub_agents), 0);
  const totalCost = Number(percentiles?.total ?? 0);
  const orchestratorCost = Math.max(0, totalCost - subAgentCostTotal);

  return {
    ...buildWindowMeta(window, totalN),
    population,
    otherPopulationCount,
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
        'The sub-agent figure sums each sub-agent\'s share of a model\'s cost, split by measured token count among ' +
        'the sub-agents whose telemetry was actually captured. That sum always accounts for the model\'s full true ' +
        'cost, so a sub-agent missing from the roster (a known, nondeterministic undercount — see the Dispatch ' +
        'section on the integrity card) is not simply left uncounted: its cost is folded into the orchestrator ' +
        'figure instead. The bias only ever runs one way, not a rounding choice — the sub-agent figure can only ' +
        'read too low, and the orchestrator figure can only read too high. A second, separate cause has the same ' +
        'one-directional effect: capturing sub-agent telemetry at all is a recent addition, so a review from ' +
        'before it existed has none recorded, no matter how much it actually dispatched. See the coverage figure ' +
        'above for how much of this split comes from reviews that predate telemetry entirely, versus reviews ' +
        'where telemetry ran but still undercounted the roster.',
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

export interface QualityStats extends WindowMeta, PopulationMeta {
  readBandSampleSize: number;
  avgReadBandItems: number | null;
  belowBandCount: number;
  belowBandPct: number | null;
  severityDistribution: Record<string, number>;
  verdictDistribution: Record<string, number>;
}

export async function getQualityStats(sql: postgres.Sql, window: StatsWindow, population: Population): Promise<QualityStats> {
  const days = getWindowDays(window);
  const testFlag = isTestFlag(population);
  const totalN = await countInWindowForPopulation(sql, days, testFlag);
  const otherPopulationCount = await countInWindowForPopulation(sql, days, !testFlag);

  const rows = await sql<Array<{ findings_list: PRFinding[] | null; recommendation: string | null }>>`
    SELECT findings_list, recommendation
    FROM pr_reviews
    WHERE created_at > now() - (${days}::int * interval '1 day')
      AND is_test = ${testFlag}
  `;

  const withFindings = rows.filter((r) => r.findings_list != null);
  const readBandCounts = withFindings.map((r) => readBandCount(r.findings_list));
  // Per-REVIEW count: a row whose findings_list contains ZERO critical/major
  // findings (readBandCount === 0) — distinct from the per-FINDING severity
  // breakdown (severityDistribution's minor+nitpick total, computed below
  // from the same rows). A review with one critical finding and five minor
  // findings has readBandCount > 0 and is NOT a below-band row here, even
  // though it contributes five findings to the "below-band" side of the
  // per-finding split. The UI (stats-costquality.tsx's BelowBandRowsSection)
  // explicitly warns readers not to conflate the two — this comment is that
  // same distinction, at its source.
  const belowBandCount = readBandCounts.filter((c) => c === 0).length;

  return {
    ...buildWindowMeta(window, totalN),
    population,
    otherPopulationCount,
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

export interface IntegrityStats extends WindowMeta, PopulationMeta {
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

// Hoisted to constants (rather than written inline in the return object below)
// so tests/dashboard/stats.test.ts and tests/dashboard/card-prose-sweep.test.ts
// can both assert on the evaluated string instead of regex-extracting it out of
// this function's source text. Both notes are rendered VERBATIM by the
// Integrity card (stats-integrity.tsx) — see IntegrityStats.inferredEffort.note
// and .subAgentModelAttribution.note above.
export const INFERRED_EFFORT_NOTE =
  "Nothing records a review's effort level, so these bands are inferred: they use the " +
  "orchestrator's output tokens — the total for all models, minus the sub-agent output " +
  "we could measure. The record of which sub-agents ran is incomplete, so the orchestrator's " +
  'share here is an overestimate.';

export const SUB_AGENT_MODEL_ATTRIBUTION_NOTE =
  'These are the models actually seen running. The record of which sub-agents ran is incomplete, and ' +
  'how much it misses varies from run to run: a dispatch missing from it has no model recorded here at ' +
  'all. So there could be more models running where they should not than these counts show, never fewer. ' +
  'This says what ran, not whether it matched what was asked for — to find real deviations, compare it ' +
  'against the model each agent declares in its own settings.';

export async function getIntegrityStats(sql: postgres.Sql, window: StatsWindow, population: Population): Promise<IntegrityStats> {
  const days = getWindowDays(window);
  const testFlag = isTestFlag(population);
  const totalN = await countInWindowForPopulation(sql, days, testFlag);
  const otherPopulationCount = await countInWindowForPopulation(sql, days, !testFlag);

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
      AND is_test = ${testFlag}
  `;

  // Zero-fills a missing 'Agent' key (COALESCE(...,0)) and applies no row
  // filter beyond the window and population — same population as `rows`
  // above (both filter on the identical, non-negated `testFlag` — see the
  // regression pin in tests/dashboard/stats.test.ts), and the same
  // zero-fill convention `dispatchCountsForPercentile` uses on the JS side.
  // See that function's doc comment for why zero-fill-all-rows was chosen
  // over excluding rows with no dispatches.
  const [dispatchPercentiles] = await sql<Array<{ median: number | null; p90: number | null }>>`
    SELECT
      percentile_cont(0.5) WITHIN GROUP (ORDER BY COALESCE((tool_calls->>'Agent')::numeric, 0)) AS median,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY COALESCE((tool_calls->>'Agent')::numeric, 0)) AS p90
    FROM pr_reviews
    WHERE created_at > now() - (${days}::int * interval '1 day')
      AND is_test = ${testFlag}
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
    population,
    otherPopulationCount,
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
        // Fix round 2 (task-6): this is the ONLY authored description of the
        // dispatch caveat — the client (stats-integrity.tsx's
        // buildDispatchSectionView) passes it through verbatim rather than
        // hand-writing its own copy, so there is exactly one place this
        // sentence can drift from reality.
        'Recorded tool activity is the dispatch count to trust here, not the agent roster: the roster undercounts ' +
        'nondeterministically, so never report the roster size alone as "how many agents ran". A high mismatch ' +
        'rate is the ordinary case here, not a sign anything broke — this is a known instrument caveat, not a new ' +
        'problem. The median and p90 figures are computed over every row in the window: a row with no recorded ' +
        'dispatches is a real zero-dispatch review (e.g. the cheap sanity path), counted as zero rather than left out.',
    },
    inferredEffort: {
      inferred: true,
      bands: { high: HIGH_EFFORT_RANGE, low: LOW_EFFORT_RANGE },
      drift: computeEffortDrift(effortEntries),
      note: INFERRED_EFFORT_NOTE,
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
      note: SUB_AGENT_MODEL_ATTRIBUTION_NOTE,
    },
  };
}

// ---------------------------------------------------------------------------
// Pure shaping — error classification (Task 9, fix round 1)
//
// `pr_reviews.error` is free text: whatever `err.message` was at the moment
// a stage threw (src/cli/review-pr.ts). Initially treated as un-parseable and
// left out of the Operational card entirely — reversed after checking real
// production data: over a 90-day window, 21 of 31 recorded errors (68%) are
// `RateLimitError`, and the remainder classify cleanly against the other two
// PipelineError subtypes (src/sdk/errors.ts) that construct a fixed,
// interpolation-free message shape:
//
//   RateLimitError        `Rate limit hit during "${stage}": ${resetInfo}`
//   AgentExecutionError    `Agent "${stage}" failed to produce a result`        (only when `details` wasn't already a string — see its constructor)
//   AgentValidationError   `Agent "${stage}" output failed schema validation`
//
// `resetInfo` (a reset time like "11am (UTC)") is the only part of any of
// these that varies in a way that matters here, so every match below is
// anchored on the STABLE portion of the message — a literal prefix for
// RateLimitError, an exact full-string shape (via regex) for the other two —
// never the variable suffix.
//
// `TransientAgentError` (`Agent "${stage}" failed after ${attempts}
// attempt(s): ${lastError.message}`) is the one class that WRAPS another
// error's message verbatim — confirmed the only such wrapper in the
// PipelineError hierarchy by reading every constructor in errors.ts. Peeling
// off that one fixed prefix and re-classifying the wrapped remainder is
// still a code-derived fact, not a guess: if the wrapped message happens to
// BE one of the three known shapes (as it is for 4 of the live rows —
// `TransientAgentError` wrapping an `AgentExecutionError`'s default
// message), that's real information. If the wrapped message is anything
// else (a raw network error, an auth timeout — genuinely unconstrained),
// classification falls through to `'other'` rather than assuming it means
// "no result" too. Peeling happens exactly once — nothing in the codebase
// double-wraps.
//
// Anything that doesn't match — including "Something went wrong" and any
// `AgentExecutionError` constructed with a custom string `details` — is
// `'other'`. This is deliberate, not a gap to close: a growing `'other'`
// bucket is itself the signal that the parser has fallen behind the error
// text, which is exactly why its count is always shown, never hidden.
// ---------------------------------------------------------------------------

export type ErrorCategory = 'rate-limit' | 'no-result' | 'schema-validation' | 'other';

const RATE_LIMIT_PREFIX = 'Rate limit hit during "';
const NO_RESULT_RE = /^Agent "[^"]*" failed to produce a result$/;
const SCHEMA_VALIDATION_RE = /^Agent "[^"]*" output failed schema validation$/;
const RETRY_WRAPPER_RE = /^Agent "[^"]*" failed after \d+ attempt\(s\): ([\s\S]*)$/;

function classifyErrorShape(message: string): ErrorCategory {
  if (message.startsWith(RATE_LIMIT_PREFIX)) return 'rate-limit';
  if (NO_RESULT_RE.test(message)) return 'no-result';
  if (SCHEMA_VALIDATION_RE.test(message)) return 'schema-validation';
  return 'other';
}

/** Classifies one `error` message. Exported and unit-tested directly against
 *  the exact live production strings (see tests/dashboard/stats.test.ts) —
 *  not paraphrased fixtures. */
export function classifyErrorMessage(message: string): ErrorCategory {
  const direct = classifyErrorShape(message);
  if (direct !== 'other') return direct;
  const wrapped = RETRY_WRAPPER_RE.exec(message);
  return wrapped ? classifyErrorShape(wrapped[1]!) : 'other';
}

/** Never render a raw error string wholesale (constraint: errors are free
 *  text from upstream and can carry incidental detail) — truncated to a
 *  short exemplar length. */
const EXEMPLAR_MAX_LEN = 100;

function truncateExemplar(message: string): string {
  return message.length > EXEMPLAR_MAX_LEN ? `${message.slice(0, EXEMPLAR_MAX_LEN)}…` : message;
}

export interface ErrorClassificationSummary {
  /** Total classified errors this window — expected to equal
   *  `IntegrityStats.errorRate.count` for the same window (both filter the
   *  same `error IS NOT NULL` population), though the two are computed by
   *  independent endpoint functions and not cross-checked at runtime. */
  total: number;
  categories: Record<ErrorCategory, number>;
  /** One truncated, real exemplar per category actually observed this
   *  window — the MOST RECENT occurrence (rows are fetched newest-first),
   *  so a reader sees a fresh example, not a stale historic one. A category
   *  absent from this window has no key here — never a fabricated empty
   *  string standing in for "none seen." */
  exemplars: Partial<Record<ErrorCategory, string>>;
}

/** Pure aggregation over already-fetched, non-null error messages — no SQL,
 *  no null-filtering (the caller's query already filters `error IS NOT
 *  NULL`, matching `errorRate`'s own population in `getIntegrityStats`). */
export function classifyErrors(messages: string[]): ErrorClassificationSummary {
  const categories: Record<ErrorCategory, number> = { 'rate-limit': 0, 'no-result': 0, 'schema-validation': 0, other: 0 };
  const exemplars: Partial<Record<ErrorCategory, string>> = {};
  for (const message of messages) {
    const category = classifyErrorMessage(message);
    categories[category] += 1;
    if (exemplars[category] === undefined) exemplars[category] = truncateExemplar(message);
  }
  return { total: messages.length, categories, exemplars };
}

// ---------------------------------------------------------------------------
// GET /api/stats/operational
// ---------------------------------------------------------------------------

export interface OperationalStats extends WindowMeta, PopulationMeta {
  reviewsPerDay: {
    average: number | null;
    series: Array<{ date: string; count: number }>;
  };
  duration: { medianMs: number | null; p90Ms: number | null; sampleSize: number };
  turns: { median: number | null; p90: number | null; sampleSize: number };
  toolMix: ToolMixEntry[];
  perRepo: Array<{ repoKey: string; count: number; medianDurationMs: number | null; medianTurns: number | null }>;
  /** Classification of every `error` recorded in this window — see the
   *  module doc comment above `ErrorCategory` for exactly what each bucket
   *  matches and why. A `'rate-limit'` count of 0 is a real, verified
   *  reading ("checked, none happened this window"), distinct from the
   *  field simply being absent. */
  errorClassification: ErrorClassificationSummary;
}

export async function getOperationalStats(sql: postgres.Sql, window: StatsWindow, population: Population): Promise<OperationalStats> {
  const days = getWindowDays(window);
  const testFlag = isTestFlag(population);
  const totalN = await countInWindowForPopulation(sql, days, testFlag);
  const otherPopulationCount = await countInWindowForPopulation(sql, days, !testFlag);

  // duration_n/turns_n (not the window's plain count(*)) back sampleSize below,
  // because percentile_cont silently skips nulls — a row that errors before
  // duration_ms/turns is ever written must not inflate the reported n beside
  // a median that was never computed over it. Mirrors costSampleSize's
  // `cost_usd IS NOT NULL` count on /api/stats/cost.
  const [durationTurns] = await sql<Array<{
    duration_n: string; turns_n: string;
    medianDuration: number | null; p90Duration: number | null; medianTurns: number | null; p90Turns: number | null;
  }>>`
    SELECT count(*) FILTER (WHERE duration_ms IS NOT NULL)::text AS duration_n,
      count(*) FILTER (WHERE turns IS NOT NULL)::text       AS turns_n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS "medianDuration",
      percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms) AS "p90Duration",
      percentile_cont(0.5) WITHIN GROUP (ORDER BY turns) AS "medianTurns",
      percentile_cont(0.9) WITHIN GROUP (ORDER BY turns) AS "p90Turns"
    FROM pr_reviews
    WHERE created_at > now() - (${days}::int * interval '1 day')
      AND is_test = ${testFlag}
  `;

  const dailyRows = await sql<Array<{ day: string; n: string }>>`
    SELECT date_trunc('day', created_at)::date::text AS day, count(*)::text AS n
    FROM pr_reviews
    WHERE created_at > now() - (${days}::int * interval '1 day')
      AND is_test = ${testFlag}
    GROUP BY 1
    ORDER BY 1
  `;

  const toolRows = await sql<Array<{ tool_calls: Record<string, number> | null }>>`
    SELECT tool_calls
    FROM pr_reviews
    WHERE created_at > now() - (${days}::int * interval '1 day')
      AND is_test = ${testFlag}
  `;

  const repoRows = await sql<Array<{ repo_key: string; n: string; medianDuration: number | null; medianTurns: number | null }>>`
    SELECT repo_key, count(*)::text AS n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS "medianDuration",
      percentile_cont(0.5) WITHIN GROUP (ORDER BY turns) AS "medianTurns"
    FROM pr_reviews
    WHERE created_at > now() - (${days}::int * interval '1 day')
      AND is_test = ${testFlag}
    GROUP BY repo_key
    ORDER BY count(*) DESC
  `;

  // Same `error IS NOT NULL` population `getIntegrityStats`'s `errorRate`
  // counts (`r.error != null`) — filtered here in SQL rather than in JS
  // purely so `classifyErrors` never has to special-case `null`. Newest
  // first so each category's exemplar (classifyErrors) is the most recent
  // real occurrence, not an arbitrary or stale one.
  const errorRows = await sql<Array<{ error: string }>>`
    SELECT error
    FROM pr_reviews
    WHERE created_at > now() - (${days}::int * interval '1 day')
      AND is_test = ${testFlag}
      AND error IS NOT NULL
    ORDER BY created_at DESC
  `;

  return {
    ...buildWindowMeta(window, totalN),
    population,
    otherPopulationCount,
    reviewsPerDay: {
      average: days > 0 ? totalN / days : null,
      series: dailyRows.map((r) => ({ date: r.day, count: Number(r.n) })),
    },
    duration: {
      medianMs: numOrNull(durationTurns?.medianDuration),
      p90Ms: numOrNull(durationTurns?.p90Duration),
      sampleSize: Number(durationTurns?.duration_n ?? 0),
    },
    turns: {
      median: numOrNull(durationTurns?.medianTurns),
      p90: numOrNull(durationTurns?.p90Turns),
      sampleSize: Number(durationTurns?.turns_n ?? 0),
    },
    toolMix: aggregateToolMix(toolRows.map((r) => r.tool_calls)),
    perRepo: repoRows.map((r) => ({
      repoKey: r.repo_key,
      count: Number(r.n),
      medianDurationMs: numOrNull(r.medianDuration),
      medianTurns: numOrNull(r.medianTurns),
    })),
    errorClassification: classifyErrors(errorRows.map((r) => r.error)),
  };
}

// ---------------------------------------------------------------------------
// GET /api/stats/review-value
//
// "What did PR review actually buy us." Reads `finding_outcomes` — one row per
// read-band (critical/major) finding on a PR that has SETTLED (ADO status
// completed/abandoned), written by a batch job that classifies two independent
// things per finding:
//   - `said_evidence`/`said` — what the team SAID, from the finding's thread
//     and the PR discussion.
//   - `did` — what the branch DID, judged from the post-review diff by a
//     3-ballot majority vote.
// The two are separate columns on purpose (see src/db/finding-outcome-mapper.ts):
// the classifier judging `did` never sees the discussion, so a finding that was
// fixed with nobody replying is distinguishable from one that was argued about.
//
// Three properties of this data drive every shape below, and each is surfaced
// on the card rather than left to a reader to infer:
//
//  1. NOT EVERY ROW IS JUDGED. `did` is null when there was no diff to judge
//     against yet. Every rate over `did` therefore has TWO defensible
//     denominators — judged rows, and all rows raised — that differ by a large
//     factor. `ReviewValueOutcome` carries both, each with its own explicitly
//     named denominator field, so neither can be rendered as "the" rate.
//  2. ROW-LEVEL VERDICTS ARE NOT REPRODUCIBLE. The four-way per-ballot verdict
//     reproduced 67% of the time on byte-identical input, which is why voting
//     is 3 ballots and why `did` collapses to three values. Aggregates here are
//     usable; a single row's verdict is not, and `reproducibilityNote` says so.
//  3. `said` IS POPULATED, BUT NOT ON EVERY ROW — AND THAT IS PERMANENT, NOT A
//     BACKLOG. A said ballot is only spent on a finding with human text behind
//     it, so a finding nobody answered keeps `said` null for good; a tied tally
//     also stores null, with `said_confidence` recording the tie (see the
//     column comments in src/db/postgres.ts). So anything keyed on `said` has
//     its OWN denominator — the rows carrying a label — which is neither
//     `judged` nor `raised`: live at 2026-08-07, 72 of 135 rows carry one while
//     139 were raised. A window with NO labelled row is still reported as NOT
//     MEASURED, never as zero — see `disputedAsWrong`.
// ---------------------------------------------------------------------------

/** One `finding_outcomes` row, reduced to the columns this computation reads.
 *  Deliberately not `FindingOutcome` (src/db/finding-outcome-mapper.ts): this
 *  function must stay callable from a unit test with a four-field literal
 *  rather than a full row, matching every other pure shaper in this file. */
export interface ReviewValueFindingRow {
  did: string | null;
  didConfidence: string | null;
  said: string | null;
  /** On a row whose `said` is null (the only case this is read for): null
   *  means no said ballot was ever cast, `'split'` means one was cast and
   *  tied (`said` has no `SaidLabel` value for a tie, so both leave `said`
   *  null — see the column comment in src/db/postgres.ts). The column's
   *  fuller domain, mirroring `did_confidence`, also has `'unanimous'`,
   *  `'majority'`, and `'single-vote'` — values that pair with a non-null
   *  `said` (a ballot resolved to an answer) and so are outside the two
   *  above for THIS scope, not values this field promises never to hold.
   *  Read only by the not-measured `reason` in `disputedAsWrong`, to say
   *  WHICH null-`said` state a window is actually in instead of listing all
   *  of them — see `buildDisputedNotMeasuredReason` for how it treats a row
   *  outside the two documented values rather than assuming one. */
  saidConfidence: string | null;
  saidEvidence: string | null;
  leadTimeMins: number | null;
}

/** The "raised" half, aggregated in SQL (the route) rather than here.
 *  `finding_outcomes` holds one row per finding the sweep could TRACE, which
 *  is not the same population as the findings review RAISED — so the raised
 *  figure has to come from `pr_reviews.findings_list`, one level up, exactly
 *  as the spec sources it. */
export interface ReviewValueRaisedInput {
  /** Distinct read-band findings in `findings_list` on these PRs, counted
   *  under the SAME normalised file+title identity `findingKey` uses, so a
   *  re-review raising the same finding again counts once. */
  readBandRaised: number;
  /** Of those, how many carry no file anchor — `findingKey` needs a file, so
   *  these can never get an inline thread and can never be traced. */
  noFileAnchor: number;
}

/** The spend half, aggregated in SQL (the route) rather than here — this is
 *  the one input the pure function cannot derive from finding rows, because
 *  cost lives on `pr_reviews`, one level up from a finding. */
export interface ReviewValueSpendInput {
  totalCostUsd: number;
  /** `pr_reviews` rows on the PRs these findings came from. Larger than the
   *  PR count whenever a PR was reviewed more than once. */
  reviewCount: number;
  /** Of those rows, how many carry no `cost_usd` — their spend is missing
   *  from `totalCostUsd` entirely, so the total is a floor. */
  reviewsMissingCost: number;
}

/** `said_evidence` values that mean a human engaged with the finding in
 *  writing. `'stale-signal'` is deliberately NOT here — it is an inference from
 *  the thread going stale, not somebody saying something. */
const ENGAGED_EVIDENCE = ['thread-reply', 'pr-discussion'] as const;

export interface ReviewValueEngagement {
  /** `said_evidence` in ('thread-reply','pr-discussion'). */
  engaged: number;
  /** `said_evidence = 'none'` — the finding was raised and nobody wrote back. */
  silent: number;
  /** Neither: null, or an evidence kind that is not an engagement signal
   *  (`'stale-signal'`). Kept out of both buckets rather than folded into
   *  `silent`, which would overstate silence. */
  unrecorded: number;
  /** engaged / (engaged + silent), 0..1. Null when neither was recorded. */
  engagedRate: number | null;
  /** Every `said_evidence` value seen, verbatim, including ones this code does
   *  not classify — so a new evidence kind added upstream shows up rather than
   *  silently disappearing into `unrecorded`. Null keys as `'(unrecorded)'`. */
  breakdown: Record<string, number>;
}

export interface ReviewValueDisputed {
  /** False while no row carries a `said` label at all. Derived from the data,
   *  not hardcoded — which is why this needed no code change on the day the
   *  said sweep first ran: it flipped, and `count` started reporting, off the
   *  rows alone. It can flip BACK for a window the sweep has not reached. */
  measured: boolean;
  /** Null — NOT zero — while `measured` is false. A zero here would assert
   *  "nobody disputed anything", a claim this data cannot support. Once
   *  measured, a zero is a real zero and the card says which it is. */
  count: number | null;
  /** How many rows carry any `said` label — the population `count` is measured
   *  over, and the ONLY defensible denominator for it. Not `judged` and not
   *  `findingsRaised`: a said label is a fact about a finding's thread, and
   *  most rows have no label for reasons that are not "nobody disputed it"
   *  (nothing written to read, a tied tally, or no thread at all). `count <=
   *  saidRecorded` holds by construction — a `rejected-wrong` row carries a
   *  label by definition — so the fraction the card renders cannot invert. */
  saidRecorded: number;
  /** Of `count`, how many carry no `did` verdict (`did` is null). Null — not
   *  zero — while `measured` is false, for the same reason `count` is. Live at
   *  2026-08-07 both disputed findings sit here: the team said the finding was
   *  wrong and no diff has been judged against it, so the card must not be
   *  read as saying the branch ignored them. It licenses NO claim about the
   *  remainder — `count - unjudged` is "has a verdict", and which verdict is
   *  the verdict table's business, not this line's. */
  unjudged: number | null;
  /** Why this window reads not-measured — and null, NOT a string, once it is
   *  measured. Same contract as `count` and `unjudged`, for a sharper reason
   *  than symmetry: every clause in it is scoped to what `saidRecorded === 0`
   *  establishes, so on a measured payload it is not merely unused, it is
   *  FALSE. It shipped as a plain `string` for one round and every live
   *  payload carried the not-measured sentence — which opens by saying no
   *  problem here has a recorded answer — beside a `saidRecorded` of 72,
   *  contradicting itself. The card never rendered it — `describeDisputed`
   *  returns on the measured branch first — but a consumer reading the JSON
   *  had a self-contradiction inside one object, and "it happens not to be
   *  read" is not a contract. Putting the not-measured-only scope in the TYPE
   *  is. */
  reason: string | null;
}

/** Every count here is over findings whose `lead_time_mins` is RECORDED. That
 *  qualifier is load-bearing and easy to drop: `beforeSettleCount === 0` does
 *  NOT mean no finding was raised before its PR settled, only that none of the
 *  ones we can see was — the card said the stronger thing for a round, in a
 *  sentence `unrecordedCount` then contradicted. */
export interface ReviewValueLeadTime {
  /** Findings with a RECORDED lead time of >= 0: posted before the PR settled.
   *  The only ones where a lead time is a lead time. Says nothing about the
   *  `unrecordedCount` findings, whose settle order is unknown. */
  beforeSettleCount: number;
  /** Negative `lead_time_mins`: the review landed after the PR had already
   *  settled (a cherry-pick sanity review, or a post-merge review). Segmented
   *  out rather than averaged in, where they would drag the figure toward zero
   *  while describing something that is not a lead time at all. */
  afterSettleCount: number;
  /** Median over `beforeSettleCount` rows only. Median, not mean: the
   *  distribution has a long right tail (a PR left open for days). */
  medianMinsBeforeSettle: number | null;
  /** Traced findings with `lead_time_mins` null — `prSettledAt` was unknown
   *  when the sweep ran, or the column predates it. In NEITHER count above,
   *  and the reason those two cannot be read as a partition of the window. */
  unrecordedCount: number;
}

/** Is the SUM that feeds `costPerAddressed` complete? `'floor'` whenever any
 *  review on these PRs carries no recorded cost — backfilling it can only
 *  RAISE the numerator. A machine-checkable state rather than a phrase buried
 *  in prose, so a test can pin the claim instead of a substring of the
 *  sentence that expresses it.
 *
 *  One degenerate case the NAME overstates: with zero reviews at all,
 *  `reviewsMissingCost` is also zero, so this reads `'exact'` for a sum over
 *  an empty set. `buildSpendNote` says "zero rather than exact" there rather
 *  than letting the name speak. Unreachable in practice — the findings query
 *  requires a review in the population — but the flag alone does not rule it
 *  out, so a caller must not read `'exact'` as "a real cost was measured". */
export type NumeratorState = 'exact' | 'floor';

/** Can the DENOMINATOR still move? `'will-grow'` while any finding is
 *  unjudged (classifying more can only add to `addressed`); `'settled'` at
 *  full coverage, where the figure will not move as classification proceeds.
 *  The distinction exists because an earlier version of this note asserted
 *  unconditional growth and was falsified by the first fully-judged window
 *  that rendered it. */
export type DenominatorState = 'will-grow' | 'settled';

export interface ReviewValueSpend extends ReviewValueSpendInput {
  /** totalCostUsd / addressed. Null for EITHER of two disjoint reasons, and a
   *  caller must not assume it means the first: (a) nothing is confirmed acted
   *  on, so there is no denominator; or (b) no review on these PRs carries a
   *  recorded cost, so the numerator is unknown rather than zero — dividing it
   *  would render a measured-looking `$0.00` and assert the reviews were free.
   *  The card distinguishes the two before rendering (`describeSpend` tests
   *  the cost case FIRST, or an all-missing-cost window would be described as
   *  "nothing is confirmed acted on"). Reported ALONGSIDE judged coverage and
   *  never as a settled figure unless BOTH states below say it is one. */
  costPerAddressed: number | null;
  numeratorState: NumeratorState;
  denominatorState: DenominatorState;
  /** Plain-English prose derived from the two states above — never the other
   *  way round. Whichever direction(s) the figure can still move is stated
   *  explicitly, including the case where the missing-cost side and the
   *  coverage side pull it in OPPOSITE directions (missing cost pushes up,
   *  rising coverage pushes down), which is the one case where claiming a
   *  single-direction bound would be wrong. */
  note: string;
}

/** Builds `spend.note` from the two states, so the sentence cannot drift out
 *  of agreement with the flags a test asserts on. Split out (rather than
 *  inlined in `computeReviewValue`) so the five leaves this can render — the
 *  degenerate zero-review case, plus the four real numerator × denominator
 *  combinations — are readable side by side, each spelling out only what
 *  that combination of states actually establishes. */
function buildSpendNote(numerator: NumeratorState, denominator: DenominatorState, missing: number, reviewCount: number): string {
  const core =
    numerator === 'exact'
      ? reviewCount === 0
        ? 'No review on these pull requests has a recorded cost, so this shows zero rather than a real figure.'
        : denominator === 'settled'
          ? 'Both sides of this figure are complete. Every review on these pull requests has a recorded cost, and ' +
            'every problem has been checked, so it will not move as more checking happens.'
          : 'The real figure is at most this much. Every review has a recorded cost, but not every problem has been ' +
            'checked yet, and each one confirmed acted on brings this figure down.'
      : denominator === 'settled'
        ? `The real figure is at least this much. ${missing} of ${countOf(reviewCount, 'review')} ${agree(missing, 'has', 'have')} ` +
          'no recorded cost, so the real spend is at least the figure shown. Every problem has been checked, so ' +
          'that side will not change.'
        : `Treat this as a rough reading, not a firm number. Two things are still incomplete and they pull in opposite ` +
          `directions: ${missing} of ${countOf(reviewCount, 'review')} ${agree(missing, 'has', 'have')} no recorded cost, ` +
          'which makes the figure look low, and not every problem has been checked yet, which makes it look high.';

  return (
    `${core} This is not the same measurement as the Cost panel, which divides by every problem raised rather than ` +
    'by the problems confirmed acted on, so the gap between the two numbers is not a trend. Spend here counts ' +
    'every review on these pull requests, including repeat reviews that found none of the problems counted here.'
  );
}

/** Why the raised count and the traced count differ. A finding gets an inline
 *  thread — and therefore a `finding_outcomes` row — only if it has a FILE to
 *  anchor the thread to (`findingKey(file, title)`, src/sdk/ado/finding-key.ts,
 *  takes a non-optional file). A PR-level finding with no file is raised, is
 *  real, and can never be traced by this method. */
export interface ReviewValueTraceability {
  /** Distinct read-band findings in `pr_reviews.findings_list` on these PRs —
   *  the spec's source for "raised", and the true figure. */
  raised: number;
  /** `finding_outcomes` rows: the raised findings the sweep could follow. */
  traced: number;
  /** raised - traced, floored at 0. */
  untraceable: number;
  /** untraceable / raised, 0..1. Null when nothing was raised. */
  untraceableRate: number | null;
  /** `untraceable === noFileAnchor` — the gap is exactly the file-less count.
   *  False covers TWO different disagreements, not one: a gap larger than the
   *  file-less count (some of it unexplained), and a file-less count larger
   *  than the gap (some file-less finding was traced anyway, which the
   *  anchoring rule says cannot happen). `buildTraceabilityNote` distinguishes
   *  them; consumers that only branch on this boolean must not describe it as
   *  "part of the gap is unexplained", which is only the first case. Either
   *  way it is said out loud rather than presented as if the gap were
   *  understood. */
  reconciled: boolean;
  /** The measured count of raised read-band findings with no file anchor. */
  noFileAnchor: number;
}

export interface ReviewValueOutcome {
  /** Distinct read-band findings RAISED on these PRs, from
   *  `pr_reviews.findings_list` — NOT a count of `finding_outcomes` rows,
   *  which undercounts by every finding that has no file to anchor a thread
   *  to (see `traceability`). Not claimed as exact: two re-reviews that
   *  reword a finding substantially fork its identity key and count twice. */
  findingsRaised: number;
  traceability: ReviewValueTraceability;
  /** `did IS NOT NULL`: the classifier reached a verdict. Includes `UNKNOWN`
   *  (it looked and could not tell), which is a judged row — distinct from a
   *  row with no diff to judge at all. */
  judged: number;
  /** findingsRaised - judged: everything with no verdict, for EITHER reason. */
  unjudgeable: number;
  /** Of `unjudgeable`, the ones that have a row and are simply awaiting a
   *  diff — they will be judged eventually. The remainder
   *  (`traceability.untraceable`) never will be. Kept apart because "not yet"
   *  and "never" are different facts. */
  awaitingDiff: number;
  /** judged / findingsRaised, 0..1. Null when nothing was raised. THE number
   *  that must be rendered beside any rate over `judged`. */
  judgedCoverage: number | null;
  addressed: number;
  /** addressed / judged — the rate the card leads with. Null when judged is 0
   *  (never NaN, never a fake 0%). */
  addressedRateOfJudged: number | null;
  /** addressed / findingsRaised. A DIFFERENT number that is equally true, and
   *  never LARGER than `addressedRateOfJudged` — but not always smaller
   *  either: at full judged coverage the two are equal, which is live in the
   *  Test population today. Both are carried so the card can print each with
   *  its own denominator spelled out rather than picking one and hoping. */
  addressedRateOfRaised: number | null;
  /** Counts for every `DID_LABELS` value plus any unrecognised label seen. */
  didBreakdown: Record<string, number>;
  /** Judged rows whose ballots all agreed — i.e. `did_confidence` is exactly
   *  `'unanimous'`. It licenses NO claim about the remainder: that column's
   *  domain also includes `'majority'`, `'split'`, `'single-vote'` and
   *  `'none'`, so `judged - unanimous` is "not unanimous" and nothing more
   *  specific. This doc comment used to say "the rest reached only a
   *  majority", which is the exact claim `describeVerdictCaption` was
   *  corrected for making — `did_votes` and the verdict table are where a 2-1
   *  or a split is actually visible. */
  unanimous: number;
  /** `did = 'ADDRESSED' AND said_evidence = 'none'` — the code changed and
   *  nobody said a word. Reads `said_evidence`, never `said`: these are by
   *  definition the rows no said ballot was cast for, so keying this on the
   *  label would count exactly none of them. */
  silentlyFixed: number;
  engagement: ReviewValueEngagement;
  disputedAsWrong: ReviewValueDisputed;
  leadTime: ReviewValueLeadTime;
  spend: ReviewValueSpend;
  /** The spec's fourth stated limit, rendered with its MEASURED size rather
   *  than as a rule of thumb — and stating explicitly whether the gap between
   *  raised and traced is fully explained. */
  traceabilityNote: string;
  reproducibilityNote: string;
  scopeNote: string;
}

/**
 * The gap between raised and traced, and how much of it is understood.
 *
 * Every clause here is branched, including the CAUSE. An earlier version
 * stated the missing-file-anchor cause unconditionally and branched only the
 * trailing clause, so an unexplained gap rendered the cause and then "Only 0
 * of them are explained by a missing file anchor" — the same self-contradiction
 * shape as the spend note's "exact / but a floor".
 *
 * `explained` is clamped to the gap so the counts cannot invert: with
 * `noFileAnchor` above `untraceable` the old text printed "Only 5 of them"
 * where "them" was 3. That inversion is itself a signal the two sources are
 * counting differently, so it gets said rather than clamped away silently.
 */
function buildTraceabilityNote(raisedCount: number, untraceable: number, noFileAnchor: number): string {
  if (raisedCount === 0) {
    return 'No findings were raised in this window, so there is nothing to trace.';
  }

  if (untraceable === 0) {
    // The condition establishes that every raised finding has a ROW — nothing
    // about whether any row was judged. An earlier version of the second
    // branch said "has a verdict" here, which rendered as a flat falsehood on
    // a window with nothing judged at all. Both branches now claim only
    // traceability, which is what `untraceable === 0` actually means.
    return noFileAnchor === 0
      ? 'Every finding raised in this window has a comment thread in the pull request, so every one of them can eventually be checked.'
      : `Every finding raised in this window has a comment thread in the pull request, yet ${countOf(noFileAnchor, 'of them was', 'of them were')} ` +
        'recorded as not tied to a specific file, which should have made a comment thread impossible. The two sources are counting ' +
        'differently — reconcile them before quoting this section.';
  }

  const explained = Math.min(noFileAnchor, untraceable);
  // RULE 1. This number is a difference between two counts — the raised count
  // and the number of rows this card could match to it — so it establishes
  // only that the two cannot be matched up. It is not a look at any one
  // finding, and it licenses NO claim about what exists on the pull request:
  // the head said "have no comment thread in the pull request, so they were
  // never checked, and never can be", which asserts a missing thread from an
  // arithmetic gap. A missing file anchor is one cause and the tail below
  // states it where the counts support it; a substantially-reworded re-review
  // forks the identity key (see `computeReviewValue`) and breaks the match with
  // the thread still there, which is why even a reconciled gap is not proof of
  // absence and the head must not read as one.
  const head =
    `This card cannot match ${untraceable} of ${countOf(raisedCount, 'finding')} raised in this window to a comment ` +
    `thread in the pull request. ${agree(untraceable, 'It has', 'They have')} no verdict here, and this card has no ` +
    `way to give ${itThem(untraceable)} one. That gap is a difference between two counts, not a look at any single ` +
    'finding: on its own it does not establish that the threads are missing. ' +
    `${agree(untraceable, 'It is', 'They are')} counted in "raised" and in nothing else.`;

  // MORE file-less findings than gap means some file-less finding was traced
  // anyway, which the anchoring rule says is impossible. That is a
  // contradiction, not a fully-explained gap, so it must NOT reach the
  // "fully accounted for" wording — saying that and then "this should not
  // happen" in the same breath is the self-contradiction this function exists
  // to avoid, just one level up.
  if (noFileAnchor > untraceable) {
    return (
      `${head} More findings here were recorded as not tied to a specific file (${noFileAnchor}) than the size of that ` +
      `gap (${untraceable}), so at least one finding with no file must have been matched to a comment thread anyway ` +
      '— which cannot happen if a comment thread always needs a file to attach to. These two ' +
      'counts do not describe the same population; reconcile them before quoting this section.'
    );
  }

  // The mechanism clause is byte-identical between the two branches below on
  // purpose — it is the same fact ("a thread needs a file, a PR-level
  // finding has none") whether it explains ALL of the gap or only PART of
  // it, and a second wording here would be the same converged-vocabulary
  // defect one level down from `read-band finding`/`file anchor` elsewhere in
  // this function.
  const remainder = untraceable - explained;
  const cause =
    explained === 0
      ? ' None of that gap is explained by findings that were not tied to a specific file, which is the only cause this card knows about — ' +
        'the two sources are counting differently, and the gap should be reconciled before this line is quoted.'
      : explained === untraceable
        ? ' The gap is fully accounted for: a comment thread needs one specific file to attach to, and a finding about the pull request as a whole has no file to attach one to.'
        : ` ${explained} of ${itThem(untraceable)} ${agree(explained, 'is', 'are')} explained by not being tied to a specific file ` +
          '(a comment thread needs one specific file to attach to, and a finding about the pull request as a whole has no file to attach one to). The remaining ' +
          `${remainder} ${agree(remainder, 'is', 'are')} not explained, and should be reconciled before this line is quoted.`;

  return head + cause;
}

/** `finding.saidEvidence` counts as a reply on record — same test the
 *  engagement computation in `computeReviewValue` (`engaged`/`silent`,
 *  ~stats.ts:1930) already applies to the same column. */
function hasEngagedEvidence(f: ReviewValueFindingRow): boolean {
  return f.saidEvidence != null && (ENGAGED_EVIDENCE as readonly string[]).includes(f.saidEvidence);
}

/** The `disputedAsWrong.reason` string for a not-measured window — call ONLY
 *  where `saidRecorded === 0`, i.e. every row in `findings` has `said` null.
 *
 *  The column names below are the GATES, not the words on screen. Nothing this
 *  function returns names a column: a reader of the card has no schema to
 *  resolve `said_confidence` against, so the rendered sentence says what
 *  happened ("was voted on and the votes did not agree", "has a stored result
 *  this card cannot read") and this comment says which column establishes it.
 *  On screen THIS function calls a said ballot a "vote" throughout; "ballot"
 *  survives in this comment only where it names the `said_votes` rows
 *  themselves. Other lines on this card still say "ballots" for the three `did`
 *  verdicts — a different column, and not this function's to rename.
 *
 *  `said_confidence` ALONE is not enough to resolve which state a null
 *  `said` means (verified against production: live rows in this branch all
 *  carry `said_confidence` null, and that value is shared by two of the
 *  three states below) — `said_evidence` is needed too:
 *    - `said_confidence = 'split'`: votes WERE cast and they did not agree.
 *    - `said_confidence` null AND `said_evidence` is an engaged value
 *      (`hasEngagedEvidence`, the same test `computeReviewValue`'s engagement
 *      computation applies, ~stats.ts:1930): there is a reply on the thread or
 *      in the PR discussion, but the sweep has not checked it yet for `said`.
 *    - `said_confidence` null AND `said_evidence` is not engaged: no vote was
 *      ever cast, because a said ballot is only spent where there is a
 *      reply to read. `'none'`, `'stale-signal'`, and unset are folded
 *      together here — none of the three is a reply on record, which is the
 *      only thing this bucket claims. It says "no reply ON RECORD", never "no
 *      reply": what is absent is the record, and the card cannot see past it.
 *  Every bucket is a POSITIVE test on `saidConfidence` (`=== 'split'` or
 *  `== null`), never a complement — `findings.length - tied` would only
 *  prove "not split", and this file already has one doc comment (on
 *  `unanimous`'s domain, ~stats.ts:1630 — documenting `did_confidence`, which
 *  `said_confidence` mirrors, not this column directly) that was corrected
 *  for exactly that over-read once the fuller domain was written down. Any
 *  row that matches neither positive test lands in an explicit, honestly-worded
 *  residual bucket (`unrecognized`, below — see the comment there for why
 *  this is defensive rather than speculative) rather than being silently
 *  absorbed into "no answer was ever recorded for them", which it would not earn.
 *  Names every bucket that is non-empty (there can be more than one — e.g. a
 *  window with both a tie and an unchecked reply) rather than picking one.
 *  Live at 2026-08-08, every not-yet-measured row in the table sits in the
 *  "no vote" bucket (63 of 63 carry `said_confidence` null and
 *  `said_evidence = 'none'`) — the other two of the three states above have no
 *  live row to read today and are pinned by forced fixtures in the test suite
 *  instead. That is the table's PRESENT contents, not its history: the
 *  `unrecognized` residual below records a combination production HAS
 *  produced, on rows since repaired. */
function buildDisputedNotMeasuredReason(findings: ReviewValueFindingRow[]): string {
  if (findings.length === 0) {
    // "a finding", not the "these" the four tails below use: over an empty
    // window a demonstrative points at nothing the reader has been told
    // exists. The plural elsewhere has antecedents — the buckets named in the
    // sentence before it.
    return (
      'No finding was traced in this window at all, so there is nothing to count. Reported as not measured ' +
      'rather than as zero: counting this as zero would say nobody disputed a finding, and nothing here ' +
      'recorded an answer on whether anyone did.'
    );
  }

  const tied = findings.filter((f) => f.saidConfidence === 'split').length;
  const noBallotAtAll = findings.filter((f) => f.saidConfidence == null);
  const notYetClassified = noBallotAtAll.filter(hasEngagedEvidence).length;
  const noEngagedEvidence = noBallotAtAll.length - notYetClassified;
  // Defensive, not speculative. The current writer cannot leave `saidConfidence`
  // outside {null, 'split'} on a null-`said` row, so in normal operation this
  // bucket is expected to stay empty. It exists because a writer running code
  // older than the said-guard HAS produced exactly that combination in
  // production — `said` null beside a non-`split` confidence, on rows whose
  // ballots were still recorded in `said_votes` — and folding those into "no
  // reply on record" would have been false: a reply IS on record for a row
  // with that signature, even though it was never classified into `said`.
  // Nobody has verified this column's domain beyond what the current writer
  // can produce.
  const unrecognized = findings.length - tied - noBallotAtAll.length;

  // Bare numerals after the first fragment — repeating "finding(s)" once per
  // clause reads as three separate counts rather than one window's breakdown.
  let namedFinding = false;
  const subject = (n: number): string => {
    if (namedFinding) return `${n}`;
    namedFinding = true;
    return countOf(n, 'finding');
  };

  const parts: string[] = [];
  if (tied > 0) {
    parts.push(`${subject(tied)} ${agree(tied, 'was voted on and the votes did not agree', 'were voted on and the votes did not agree')}`);
  }
  if (notYetClassified > 0) {
    parts.push(
      `${subject(notYetClassified)} ${agree(notYetClassified, 'has', 'have')} a reply on the thread or in the ` +
      `pull request discussion, but ${agree(notYetClassified, 'has', 'have')} not had an answer recorded yet`,
    );
  }
  if (noEngagedEvidence > 0) {
    parts.push(
      `${subject(noEngagedEvidence)} ${agree(noEngagedEvidence, 'has', 'have')} no reply on record, so no answer ` +
      `was ever recorded for ${itThem(noEngagedEvidence)}`,
    );
  }
  if (unrecognized > 0) {
    parts.push(`${subject(unrecognized)} ${agree(unrecognized, 'has', 'have')} a stored result this card cannot read`);
  }

  // `parts` cannot be empty here: tied + noBallotAtAll.length + unrecognized
  // === findings.length, and findings.length > 0 is checked above.
  const state =
    parts.length === 1
      ? parts[0]!
      : parts.length === 2
        ? `${parts[0]} and ${parts[1]}`
        : `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;

  // The reason NOT to print zero differs by state, and only the pair (`tied`,
  // `unrecognized`) selects which tail renders. `notYetClassified` and
  // `noEngagedEvidence` cannot change it: both carry `saidConfidence` null,
  // which is no vote cast, so they answer "was anything ever recorded here"
  // the same way. Each branch asserts only what its own gate establishes —
  // partial is fine here, false is not.
  //
  // ALL FOUR open with the SUBJUNCTIVE "counting this as zero WOULD say nobody
  // disputed these". That is a caution about how a zero would be read, NOT the
  // claim "nobody disputed these" — which this data cannot support and which
  // the `notYetClassified` bucket can outright falsify, since a reply is on
  // record there and nothing has read it yet. Flattening the subjunctive into
  // an assertion is the defect this whole clause exists to avoid; it is
  // invisible to the type system and every test here would go green on it.
  //
  // Two of the four then scope a claim to the whole window rather than staying
  // silent about the buckets they do not gate on: the fall-through's "nothing
  // HERE recorded an answer on whether anyone did" (reached only when `tied`
  // and `unrecognized` are both 0, i.e. every row carries `saidConfidence`
  // null) and the `unrecognized`-only branch's "cannot tell whether the team
  // EVER gave an answer" — an EPISTEMIC claim about what this card knows, not
  // a record-state one.
  //
  // The fall-through's claim does not turn on tied/unrecognized for its
  // TRUTH — `said` is null for every row this function is ever called with
  // (its own precondition, ~stats.ts:1740), so "no answer was recorded" holds
  // in every bucket, tied rows included: a tied vote records no `said` value
  // either. What a tie changes is what this card can additionally CONFIRM:
  // three votes ran and did not agree, and the `state` clause immediately
  // before this one already says so. Falling through to the generic claim
  // there would not be false, but it would go silent about the one thing
  // this card positively knows — the implicature RULE 4 exists to catch, not
  // a falsehood. That is why a tie still earns its own tail below.
  //
  // `tied === 0` alone is not enough to license the fall-through either: an
  // earlier version of this gate used it as sufficient and let the generic
  // claim leak into windows containing an `unrecognized` row too. A row
  // lands in `unrecognized` because its `saidConfidence` is neither `'split'`
  // nor null — per the comment on `unrecognized` above, exactly the
  // signature a stale pre-guard writer leaves on a row it graded three votes
  // for. This card cannot confirm whether that row's vote ran, so — the same
  // reasoning as the tie, not a truth violation — it must not go silent
  // about that uncertainty either.
  //
  // The `unrecognized`-only tail is scoped away from a tie for the same KIND
  // of reason as the fall-through, not a different one — this is not a truth
  // violation either. "Cannot tell whether the team EVER gave an answer"
  // stays TRUE even where a tie is present: a split vote is the graders
  // failing to agree what answer the reply constitutes, so this card
  // genuinely cannot tell whether an answer resulted there either — the same
  // uncertainty as an `unrecognized` row, not a confirmed negative the way
  // `noEngagedEvidence` is. What a tie changes is, again, what this card can
  // additionally CONFIRM: `said_confidence = 'split'` IS a check this card
  // can confirm ran, stated in the sentence immediately before this one in
  // the rendered string. Leaving "EVER" unscoped over a window containing a
  // tie would spread that same undifferentiated doubt over rows the card can
  // positively confirm were checked — the implicature RULE 4 exists to
  // catch, same failure mode as the fall-through. So that mix gets its own
  // tail, naming the tie AND scoping the residual doubt to the rows it
  // actually covers: neither fact is dropped, neither is stretched over rows
  // it does not hold for.
  //
  // WHICH IS WHY THE TWO TIE CLAUSES ARE WORDED DIFFERENTLY, and it is not
  // drift. The standalone tie tail says "the votes that ran did not agree on an
  // answer" — sound there, because that branch requires `unrecognized === 0`,
  // so every other row carries `saidConfidence` null and ran no votes at all.
  // The combined tail says "the votes THIS CARD CAN READ did not agree", the
  // narrower claim, because it renders only where `unrecognized > 0` — and an
  // `unrecognized` row CAN carry `'unanimous'`/`'majority'`/`'single-vote'`
  // (see the domain note on `saidConfidence`, ~stats.ts:1367-1370), each of
  // which is votes that ran AND agreed. "Can", not "does": `unrecognized` is a
  // residual by complement, and the comment on it above declines to assert this
  // column's domain at all. One such row is enough — over that window "the
  // votes that ran" is a definite description whose extension would include it,
  // so the universal risks denying votes the window actually holds: the exact
  // mirror of the older defect above, over-claiming the tie at the residual's
  // expense instead of denying the tie to protect it.
  //
  // Note what the narrower form does NOT do, and why it should survive where
  // three previous versions of this clause did not: it restricts to the votes
  // this card can read rather than asserting anything about the residual, so
  // it stays true whatever that bucket turns out to hold. Every previous break
  // here was a claim whose truth depended on a bucket's membership.
  //
  // Neither form says "the three checks": three is the PER-FINDING vote count,
  // and a window holding two tied findings ran six.
  const zeroWouldMisstate =
    tied > 0 && unrecognized > 0
      ? 'counting this as zero would say nobody disputed these; the votes this card can read did not agree on ' +
        `an answer, and this card cannot tell what answer the team gave for the ${agree(unrecognized, 'one', 'ones')} ` +
        'whose stored result it cannot read'
      : unrecognized > 0
        ? 'counting this as zero would say nobody disputed these, and this card cannot tell whether the team ever gave an answer'
        : tied > 0
          ? 'counting this as zero would say nobody disputed these, and the votes that ran did not agree on an answer'
          : 'counting this as zero would say nobody disputed these, and nothing here recorded an answer on whether anyone did';

  return (
    'No problem here has a recorded answer for what the team said about it, so there is nothing to count. ' +
    state +
    `. Reported as not measured rather than as zero: ${zeroWouldMisstate}.`
  );
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Pure — no SQL, no `sql` handle, no clock. Takes the finding rows and the
 * already-aggregated spend, returns everything the card renders.
 *
 * Every rate returns `null` rather than `NaN` or a stand-in `0` when its
 * denominator is empty, matching `computeCostPerReadBandItem`/
 * `computeReadBandCoverage`'s convention on this tab: `formatPct` renders a
 * null as `'n/a'`, and "n/a" is a true statement where "0%" is a false one.
 */
export function computeReviewValue(
  findings: ReviewValueFindingRow[],
  spend: ReviewValueSpendInput,
  raised: ReviewValueRaisedInput,
): ReviewValueOutcome {
  // "Raised" comes from `findings_list`, NOT from `findings.length`. A finding
  // with no file anchor gets no inline thread and therefore no
  // `finding_outcomes` row, so counting rows silently undercounts what review
  // actually raised — and every rate over "raised" would be overstated by
  // exactly that gap. Floored at the traced count so a substantially-reworded
  // re-review (which forks the identity key and can push the findings_list
  // count either way) can never render a negative untraceable count.
  const traced = findings.length;
  const findingsRaised = Math.max(raised.readBandRaised, traced);
  const untraceable = findingsRaised - traced;

  const judgedRows = findings.filter((f) => f.did != null);
  const judged = judgedRows.length;
  const addressed = findings.filter((f) => f.did === 'ADDRESSED').length;

  const didBreakdown: Record<string, number> = {};
  // `DID_LABELS`, in the order the card lists them — imported from the core mapper, the single
  // hand-maintained copy of this list; see the comment on that export. `SPLIT` (ballots reached
  // no majority) is listed even at zero: its absence from a breakdown would read as "splits
  // cannot happen", which is not what a zero count means.
  for (const label of DID_LABELS) didBreakdown[label] = 0;
  for (const f of judgedRows) didBreakdown[f.did!] = (didBreakdown[f.did!] ?? 0) + 1;

  const unanimous = judgedRows.filter((f) => f.didConfidence === 'unanimous').length;
  const silentlyFixed = findings.filter((f) => f.did === 'ADDRESSED' && f.saidEvidence === 'none').length;

  // --- engagement ---
  const evidenceBreakdown: Record<string, number> = {};
  for (const f of findings) {
    const key = f.saidEvidence ?? '(unrecorded)';
    evidenceBreakdown[key] = (evidenceBreakdown[key] ?? 0) + 1;
  }
  // `hasEngagedEvidence`, not an inlined copy of its body: the not-measured
  // reason above documents itself as applying "the same test" this line does,
  // and two copies of a null-check are how that stops being true.
  const engaged = findings.filter((f) => hasEngagedEvidence(f)).length;
  const silent = findings.filter((f) => f.saidEvidence === 'none').length;
  const engagementDenominator = engaged + silent;

  // --- disputed (needs `said`, which most rows will never carry) ---
  // `saidRecorded` is the denominator, and it is deliberately NOT `traced`: a
  // said ballot is only cast where there is human text to read, so a row with
  // `said` null is not a row where nobody disputed anything — it is a row with
  // no reading either way. Computed once here and carried on the payload so the
  // card cannot quietly divide by something else.
  const saidRecorded = findings.filter((f) => f.said != null).length;
  const disputed = findings.filter((f) => f.said === 'rejected-wrong');

  // --- lead time ---
  const withLeadTime = findings.filter((f) => f.leadTimeMins != null);
  const beforeSettle = withLeadTime.filter((f) => f.leadTimeMins! >= 0).map((f) => f.leadTimeMins!);
  const afterSettle = withLeadTime.filter((f) => f.leadTimeMins! < 0);

  const numeratorState: NumeratorState = spend.reviewsMissingCost > 0 ? 'floor' : 'exact';
  // 'settled' means NOTHING is left to judge — which requires the untraceable
  // findings to be zero too, not merely that every ROW has a verdict. A window
  // where all 135 rows are judged but 4 raised findings have no row is not
  // settled: those 4 are permanently outside the denominator.
  const denominatorState: DenominatorState = judged >= findingsRaised ? 'settled' : 'will-grow';

  return {
    findingsRaised,
    traceability: {
      raised: findingsRaised,
      traced,
      untraceable,
      untraceableRate: findingsRaised > 0 ? untraceable / findingsRaised : null,
      // The gap is understood exactly when it equals the count of raised
      // findings with no file anchor. Anything else means the two sources
      // disagree for a reason this code has not accounted for.
      reconciled: untraceable === raised.noFileAnchor,
      noFileAnchor: raised.noFileAnchor,
    },
    judged,
    unjudgeable: findingsRaised - judged,
    // Only TRACED rows can ever acquire a verdict; the untraceable ones never
    // will. Floored at 0 for the same reason findingsRaised is.
    awaitingDiff: Math.max(0, traced - judged),
    judgedCoverage: findingsRaised > 0 ? judged / findingsRaised : null,
    addressed,
    addressedRateOfJudged: judged > 0 ? addressed / judged : null,
    addressedRateOfRaised: findingsRaised > 0 ? addressed / findingsRaised : null,
    didBreakdown,
    unanimous,
    silentlyFixed,
    engagement: {
      engaged,
      silent,
      // Over TRACED rows: engagement is read off a finding's thread, and an
      // untraceable finding has no thread to read. Using findingsRaised here
      // would silently reclassify "we cannot see" as "carries no signal".
      unrecorded: traced - engaged - silent,
      engagedRate: engagementDenominator > 0 ? engaged / engagementDenominator : null,
      breakdown: evidenceBreakdown,
    },
    disputedAsWrong: {
      measured: saidRecorded > 0,
      count: saidRecorded > 0 ? disputed.length : null,
      saidRecorded,
      unjudged: saidRecorded > 0 ? disputed.filter((f) => f.did == null).length : null,
      // Null once measured — the clauses below are scoped to `saidRecorded ===
      // 0` and are false on any other payload, so the scope is in the type
      // rather than left to the card returning before it reads this.
      //
      // Every clause is scoped to what `saidRecorded === 0` establishes: that
      // no finding here carries a label. `said_confidence` alone only
      // resolves ONE of the three states that share that null (a tie); the
      // other two — "sweep hasn't classified this yet" vs "nobody wrote
      // anything to read" — both leave `said_confidence` null and are told
      // apart only by `said_evidence`, which is why that column is read here
      // too (see `buildDisputedNotMeasuredReason`). The reason names every
      // state the window actually shows instead of listing all three as
      // equally possible. It must not say WHY beyond what those two columns
      // establish, or it makes the same unestablished-cause claim the
      // coverage line was corrected for. It must not say the said phase is
      // unbuilt: it is built and it has run. And it must NOT say this
      // computation cannot tell the three states apart — it can, now that
      // both columns are selected, and saying otherwise would be the exact
      // stale claim this comment exists to keep from recurring.
      //
      // Nor may the closing "why not print zero" clause deny that anything was
      // checked while a tie is part of the mix: votes WERE cast and asked
      // exactly this question — the check ran, it just did not agree on an
      // answer. So whenever `tied > 0` the clause names those votes, in one of
      // two forms: a window can ALSO hold a row whose `said_confidence` this
      // computation does not recognize, and that residual doubt gets scoped to
      // those rows rather than phrased as doubt about the whole window, which
      // would deny the tie the preceding sentence just asserted. And that
      // clause stays SUBJUNCTIVE throughout — it says what counting this as
      // zero WOULD claim, never that nobody disputed anything. See the branch
      // comment in `buildDisputedNotMeasuredReason`.
      reason: saidRecorded > 0 ? null : buildDisputedNotMeasuredReason(findings),
    },
    leadTime: {
      beforeSettleCount: beforeSettle.length,
      afterSettleCount: afterSettle.length,
      medianMinsBeforeSettle: median([...beforeSettle].sort((a, b) => a - b)),
      // Over TRACED rows — an untraceable finding has no row and therefore no
      // lead time to be missing.
      unrecordedCount: traced - withLeadTime.length,
    },
    spend: {
      ...spend,
      // Null when the numerator is entirely UNRECORDED, not merely zero.
      // Dividing an unknown sum yields "$0.00 per acted-on", which asserts the
      // reviews were free — the same error as reporting an unmeasured dispute
      // count as 0. A genuine zero (reviews that really cost nothing) is not
      // distinguishable here, and the safe reading is the one that claims less.
      costPerAddressed:
        addressed > 0 && !(spend.reviewCount > 0 && spend.reviewsMissingCost === spend.reviewCount)
          ? spend.totalCostUsd / addressed
          : null,
      numeratorState,
      denominatorState,
      // Derived from the two states above, never hand-written per case — an
      // earlier version asserted a fixed "numerator is exact / can only fall"
      // that BOTH a window with missing cost and a fully-judged window
      // falsified while it was being rendered.
      note: buildSpendNote(numeratorState, denominatorState, spend.reviewsMissingCost, spend.reviewCount),
    },
    traceabilityNote: buildTraceabilityNote(findingsRaised, untraceable, raised.noFileAnchor),
    reproducibilityNote:
      'A single finding\'s verdict is not reproducible: one ballot flipped on 33% of identical re-runs, which is ' +
      'why each finding is judged by 3 ballots, and why the verdict can only land on one of three outcomes. The ' +
      'totals on this card are usable; any one finding\'s verdict is not.',
    scopeNote:
      'Findings flagged as critical or major, on pull requests that have been merged or closed. A finding on a ' +
      'still-open pull request is excluded entirely, never counted as ignored: the team may still act on it.',
  };
}

export interface ReviewValueStats extends WindowMeta, PopulationMeta {
  outcome: ReviewValueOutcome;
}

/**
 * Windowed on `first_raised_at` — "findings RAISED in the last N days" — not on
 * `computed_at` (when the batch job happened to classify them, which says
 * nothing about the review) and not on `pr_settled_at` (which would make the
 * window a property of the team's merge cadence).
 *
 * Population: `finding_outcomes` has no `is_test` column of its own, so a
 * finding inherits the population of its PR's reviews. A PR reviewed in BOTH
 * populations therefore appears under both — which is why `sampleSize` and
 * `otherPopulationCount` need not sum to the table's window total.
 */
export async function getReviewValueStats(sql: postgres.Sql, window: StatsWindow, population: Population): Promise<ReviewValueStats> {
  const days = getWindowDays(window);
  const testFlag = isTestFlag(population);

  const rows = await sql<Array<{
    did: string | null;
    did_confidence: string | null;
    said: string | null;
    said_confidence: string | null;
    said_evidence: string | null;
    lead_time_mins: number | null;
  }>>`
    SELECT f.did, f.did_confidence, f.said, f.said_confidence, f.said_evidence, f.lead_time_mins
    FROM finding_outcomes f
    WHERE f.first_raised_at > now() - (${days}::int * interval '1 day')
      AND EXISTS (
        SELECT 1 FROM pr_reviews r
        WHERE r.pr_id = f.pr_id AND r.repo_key = f.repo_key AND r.is_test = ${testFlag}
      )
  `;

  const [other] = await sql<Array<{ n: string }>>`
    SELECT count(*)::text AS n
    FROM finding_outcomes f
    WHERE f.first_raised_at > now() - (${days}::int * interval '1 day')
      AND EXISTS (
        SELECT 1 FROM pr_reviews r
        WHERE r.pr_id = f.pr_id AND r.repo_key = f.repo_key AND r.is_test = ${!testFlag}
      )
  `;

  // What review actually RAISED, from `findings_list` — the spec's source for
  // this line, and NOT the same as `rows.length` above. `finding_outcomes`
  // only holds findings the sweep could trace, and tracing needs an inline
  // thread, which needs a file to anchor to.
  //
  // WINDOWED PER FINDING, not per PR. The window predicate is on each
  // identity's OWN `min(created_at)` — the first review that carried it —
  // which is the same quantity `finding_outcomes.first_raised_at` holds
  // (verified over the live table: 135/135 rows match the earliest carrying
  // review's `created_at` to the second). Scoping the window on the PR
  // instead, via the EXISTS alone, made this "raised on ANY review ever, of a
  // PR that happened to have one finding first-raised in the window" — a
  // different and larger population than `traced`, which every rate over
  // "raised" then inherited. The EXISTS is still here, but it now only means
  // "this PR has been swept at all", which is the scope the card claims.
  //
  // The normalisations reproduce `findingKey` (src/sdk/ado/finding-key.ts):
  // backslashes to forward slashes, leading slashes stripped, title lowercased
  // with every non-alphanumeric run collapsed to a single space. Note `'\\'`,
  // not `'\'` — inside a TS template literal `\'` is an escape producing a
  // bare quote, which silently made this `replace(..., '', '/')`, a no-op
  // Postgres accepts without complaint. Plain `replace`, not `regexp_replace`:
  // a lone backslash is an invalid regex escape, and `findingKey` does a plain
  // string replace anyway.
  //
  // Verified against the REAL `findingKey` (not a count-equality proxy — two
  // normalisations can agree on cardinality while partitioning differently):
  // computing `findingKey` over `findings_list` and diffing the resulting key
  // set against `finding_outcomes.finding_key` gives 0 in each direction.
  const [raised] = await sql<Array<{ n: string; no_file: string }>>`
    WITH read_band AS (
      SELECT
        r.pr_id,
        r.repo_key,
        btrim(regexp_replace(replace(btrim(f->>'file'), '\\', '/'), '^/+', '')) AS norm_file,
        btrim(regexp_replace(lower(f->>'title'), '[^a-z0-9]+', ' ', 'g')) AS norm_title,
        (f->>'file' IS NULL OR btrim(f->>'file') = '') AS no_file,
        r.created_at
      FROM pr_reviews r
      CROSS JOIN LATERAL jsonb_array_elements(r.findings_list) AS f
      WHERE r.findings_list IS NOT NULL
        AND r.is_test = ${testFlag}
        AND f->>'severity' IN ('critical', 'major')
        AND EXISTS (
          SELECT 1 FROM finding_outcomes fo
          WHERE fo.pr_id = r.pr_id AND fo.repo_key = r.repo_key
        )
    ),
    identified AS (
      SELECT
        bool_or(no_file) AS no_file,
        min(created_at) AS first_raised_at
      FROM read_band
      GROUP BY pr_id, repo_key, norm_file, norm_title
    )
    SELECT count(*)::text AS n,
      count(*) FILTER (WHERE no_file)::text AS no_file
    FROM identified
    WHERE first_raised_at > now() - (${days}::int * interval '1 day')
  `;

  // Spend over the REVIEWS that produced these findings, joined on
  // (pr_id, repo_key) — pr_id alone is not unique across repos. `sum` skips
  // nulls silently, so `missing_cost` is reported beside it rather than left
  // to make the total quietly incomplete.
  const [spend] = await sql<Array<{ total: number | null; n: string; missing: string }>>`
    SELECT sum(r.cost_usd) AS total,
      count(*)::text AS n,
      count(*) FILTER (WHERE r.cost_usd IS NULL)::text AS missing
    FROM pr_reviews r
    WHERE r.is_test = ${testFlag}
      AND EXISTS (
        SELECT 1 FROM finding_outcomes f
        WHERE f.pr_id = r.pr_id AND f.repo_key = r.repo_key
          AND f.first_raised_at > now() - (${days}::int * interval '1 day')
      )
  `;

  return {
    // sampleSize is FINDINGS here, not pr_reviews rows as on the other four
    // endpoints — this card's subject is the finding, and `classifyWindowedResponse`
    // must route a window with reviews but no classified findings to 'empty'.
    ...buildWindowMeta(window, rows.length),
    population,
    otherPopulationCount: Number(other?.n ?? 0),
    outcome: computeReviewValue(
      rows.map((r) => ({
        did: r.did,
        didConfidence: r.did_confidence,
        said: r.said,
        saidConfidence: r.said_confidence,
        saidEvidence: r.said_evidence,
        leadTimeMins: r.lead_time_mins == null ? null : Number(r.lead_time_mins),
      })),
      {
        totalCostUsd: Number(spend?.total ?? 0),
        reviewCount: Number(spend?.n ?? 0),
        reviewsMissingCost: Number(spend?.missing ?? 0),
      },
      {
        readBandRaised: Number(raised?.n ?? 0),
        noFileAnchor: Number(raised?.no_file ?? 0),
      },
    ),
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
