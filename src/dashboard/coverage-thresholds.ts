/**
 * Coverage threshold shared across the server (`stats.ts`) and the browser
 * bundle (`client/components/stats-costquality.tsx`). A tiny leaf module
 * with ZERO server-only imports (no `node:fs`, no `Bun.spawn`, nothing
 * `stats.ts` itself needs) — that is the whole reason it exists apart from
 * `stats.ts`: `stats.ts` is server-only, so no client file may import a
 * VALUE from it (only `import type`, erased at bundle time — see
 * stats-costquality.tsx's module doc comment). Splitting the constant out
 * to its own zero-dependency file lets BOTH sides import the real value,
 * the same reasoning `client/model-contamination.ts` already established
 * for a client-to-client sharing case (there, two components; here, a
 * server module and a client module).
 *
 * Below this coverage fraction, a statistic computed over a population is
 * more instrumentation-shaped than data-shaped: a majority of the rows have
 * no data for the column in question at all, so the statistic is dominated
 * by absence of capture rather than by a measured signal. 50% (a plain
 * majority) is a round, easily-explained bar — not tuned to any observed
 * reading.
 *
 * Used by TWO independently-added, structurally analogous columns that
 * happen to share this exact question ("how much of this population
 * actually has the data this statistic needs?"), not because one column's
 * answer must equal the other's by definition:
 *  - `stats.ts`'s `computeSubAgentCoverage` — the cost split's `sub_agents`
 *    coverage (`orchestratorSubAgentSplit.coverage`).
 *  - `stats-costquality.tsx`'s `computeReadBandCoverage` — the read-band
 *    gauge's `findings_list` coverage.
 * If either column's coverage bar should ever need to move independently of
 * the other, give it its OWN named constant at that point — don't bend this
 * one to fit two different bars silently.
 */
export const MIN_RELIABLE_COVERAGE_PCT = 50;
