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
    orchestratorCostUsd: number;
    subAgentCostUsd: number;
    orchestratorSharePct: number | null;
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
      orchestratorCostUsd: orchestratorCost,
      subAgentCostUsd: subAgentCostTotal,
      orchestratorSharePct: totalCost > 0 ? (orchestratorCost / totalCost) * 100 : null,
      note:
        "subAgentCostUsd sums sub_agents[*].apportionedCostUsd (model cost shared out by measured token count). " +
        "sub_agents is a known undercount of actual dispatches relative to tool_calls->'Agent' (see /api/stats/integrity), " +
        'so this is a LOWER BOUND on sub-agent spend and an UPPER BOUND on orchestrator spend.',
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

  const [dispatchPercentiles] = await sql<Array<{ median: number | null; p90: number | null }>>`
    SELECT
      percentile_cont(0.5) WITHIN GROUP (ORDER BY (tool_calls->>'Agent')::numeric) AS median,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY (tool_calls->>'Agent')::numeric) AS p90
    FROM pr_reviews
    WHERE created_at > now() - (${days}::int * interval '1 day')
      AND tool_calls ? 'Agent'
  `;

  const dispatchCounts = rows.map((r) => dispatchCount(r.tool_calls));
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

  return {
    ...buildWindowMeta(window, totalN),
    modelUsage: {
      breakdown: modelBreakdown,
      flaggedKeys: modelBreakdown.filter((m) => m.flagged),
    },
    dispatch: {
      sampleSize: rows.length,
      medianDispatch: numOrNull(dispatchPercentiles?.median),
      p90Dispatch: numOrNull(dispatchPercentiles?.p90),
      avgRosterCount,
      mismatchCount,
      mismatchRate: rows.length > 0 ? mismatchCount / rows.length : null,
      note:
        "tool_calls->'Agent' is the authoritative dispatch count. sub_agents roster undercounts nondeterministically " +
        '— never report roster count alone as "how many agents ran".',
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
  head: { value: null; reason: 'not-observable-in-container' };
  composeService: { value: string | null; classification: ImageShaClass; source: string };
  spawnedImage: {
    mostRecentSha: { value: string | null; recordedAt: string | null };
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

  return {
    ...buildWindowMeta(window, totalN),
    head: { value: null, reason: 'not-observable-in-container' },
    composeService: {
      value: buildSha,
      classification: classifyImageSha(buildSha),
      source: "this dashboard process's BUILD_SHA env var",
    },
    spawnedImage: {
      mostRecentSha: mostRecent
        ? { value: mostRecent.image_sha, recordedAt: mostRecent.created_at }
        : { value: null, recordedAt: null },
      distribution: [...distribution.entries()].map(([classification, count]) => ({ classification, count })),
    },
    provenanceRecorded: (distribution.get('sha') ?? 0) > 0 || mostRecent != null,
  };
}
