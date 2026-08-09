import type { IntegrityStats } from '../stats.ts';
import type { LeverStatus } from '../config-report.ts';
import type { SettledContaminationAvailability } from './model-contamination.ts';

// ---------------------------------------------------------------------------
// Shared assessors (Task 3, follow-up) — pure severity/status logic consumed
// by more than one panel. The four ribbon assessors originally lived inside
// stats-ribbon.tsx, and the `FetchState` classification helpers below them
// originally lived inside stats-view.tsx; stats-integrity.tsx and
// stats-config.tsx already imported the ribbon versions, and a third
// consumer would have closed an import cycle (a component file exporting
// shared logic makes every additional consumer choose between a cycle and a
// copy — the same problem `model-contamination.ts` was extracted to solve
// earlier). This module holds NO component and NO JSX, so any number of
// panels can import from it without risk of a cycle — pinned by
// tests/dashboard/assessors.test.ts (fix round 1: the guard checks import
// syntax, not a bare `.tsx` substring, so this comment is free to name
// files without tripping it).
//
// `assessDrift` stays in stats-ribbon.tsx: only the ribbon uses it, and it
// returns a drift-specific shape, not `SimpleAssessment`.
// ---------------------------------------------------------------------------

export interface SimpleAssessment {
  severity: 'ok' | 'attention';
  text: string;
}

// ---------------------------------------------------------------------------
// Shared copy (Task 8) — two strings rendered identically in TWO files
// (stats-costquality.tsx's model table/tooltip and stats-integrity.tsx's
// model table/tooltip). "Keep them identical" is a promise a hand-copied
// literal can silently break; a shared constant makes it a guarantee.
// ---------------------------------------------------------------------------

/** The empty state for both `model_usage`-derived tables — the Cost card's
 *  "Cost by model" and the Integrity panel's "Model usage". Mirrors the "No
 *  tool activity recorded" phrase Task 6 already established for the
 *  equivalent `tool_calls` case — same shape, same reason: a DB field name
 *  does not belong in rendered prose. */
export const NO_MODEL_ACTIVITY_TEXT = 'No model activity recorded in this window.';

/** The `[1m]`-flagged-key tooltip, shown on the same chip in both the Cost
 *  card's model table and the Integrity panel's model table. */
export const FLAGGED_MODEL_KEY_TOOLTIP = 'Matches the [1m] premium long-context contamination pattern';

/** Flags contamination-pattern model keys (the specific `[1m]` long-context
 *  premium-tier suffix data-shapes.md calls out) — a real cost-attribution
 *  bug, not a stylistic nit, so any flagged key is 'attention'. Named
 *  precisely for what it checks (fix round 2) — it used to be called
 *  `assessModelIntegrity`, but "model integrity" now covers a SECOND signal
 *  (declared-pin contamination, below) this function knows nothing about;
 *  `stats-integrity.tsx`'s "Model usage" panel section still calls this one
 *  directly, since that section is deliberately scoped to the `[1m]` pattern
 *  only (contamination has its own dedicated panel section). */
export function assessFlaggedModelKeys(integrity: IntegrityStats): SimpleAssessment {
  const flagged = integrity.modelUsage.flaggedKeys;
  if (flagged.length === 0) {
    return { severity: 'ok', text: `n=${integrity.sampleSize} · no flagged model keys` };
  }
  return {
    severity: 'attention',
    text: `${flagged.length} flagged model key(s): ${flagged.map((m) => m.model).join(', ')}`,
  };
}

/**
 * The ribbon's combined "Model integrity" verdict (fix round 2) — folds
 * `assessFlaggedModelKeys`'s `[1m]` signal together with declared-pin
 * CONTAMINATION into one card, per the plan's four-indicator limit
 * (contamination is not a fifth indicator, it's a second cause of the same
 * one). Both signals are ALWAYS stated in the text, never just one, so a
 * genuine finding on either axis can't be silently masked by the other
 * being clean — this is the exact failure mode this function's own tests
 * pin ("combined-signal case").
 *
 * The contamination count is phrased as a FLOOR ("at least N/M runs"), never
 * an exact figure: `sub_agents` undercounts dispatches nondeterministically
 * (see the Dispatch section of the Integrity panel), so a deviating run
 * missing from the roster has no model recorded at all and cannot be
 * counted here. The true count can only be higher than what's shown, never
 * lower — the same direction stated in `IntegrityStats.subAgentModelAttribution.note`.
 *
 * `contamination.status === 'error'` (the declared-pin fetch failed) is
 * `'attention'` regardless of the flagged-key half, worded as "cannot
 * verify" — mirrors `assessDrift`'s established precedent in
 * stats-ribbon.tsx ("unverifiable is not probably-fine"), and stays
 * consistent with `stats-integrity.tsx`'s `ContaminationSection`'s own
 * "Cannot verify: " tag (fix round 2, Finding 1) even though the ribbon's
 * shared `SimpleCard` only has ONE generic "Needs attention: " prefix
 * across all four cards — the distinguishing words live in this function's
 * own `text`, not in new ribbon chrome.
 *
 * Takes `SettledContaminationAvailability`, not the full `ContaminationAvailability`
 * (fix round 3) — this function is never called while `configState` is still
 * loading. `buildModelIntegrityCard` (stats-ribbon.tsx) holds the WHOLE card
 * at the ribbon's own `'loading'` status until both fetches settle, same as
 * every other card on the ribbon; computing a provisional
 * `'ok'`/`'attention'`
 * from the flagged-key half alone (the round-2 behaviour) risked a
 * green-to-amber flip on the one card whose entire reason for existing is
 * model-cost drift — the exact "unverifiable is not probably-fine" lesson
 * `assessDrift` already encodes, just for a race instead of a permanent
 * failure. The type change makes "assessed while unsettled" impossible to
 * reintroduce by accident: there is no `'loading'` branch left to write here.
 */
export function assessModelIntegrity(integrity: IntegrityStats, contamination: SettledContaminationAvailability): SimpleAssessment {
  const flagged = integrity.modelUsage.flaggedKeys;
  const flaggedText = flagged.length === 0
    ? 'no flagged model keys'
    : `${flagged.length} flagged model key(s): ${flagged.map((m) => m.model).join(', ')}`;

  if (contamination.status === 'error') {
    return {
      severity: 'attention',
      text: `n=${integrity.sampleSize} · ${flaggedText} · cannot verify contamination — declared configuration failed to load: ${contamination.message}`,
    };
  }

  // 'not-observed' rows (I-4) are declared pins that never dispatched this
  // window — real pins, but not evaluated, so they must stay OUT of
  // `evaluatedRows` (never contamination) while still being counted in the
  // disclosure clause below. Without that clause, "no model contamination"
  // reads as an all-clear over the whole declared roster when it was only
  // ever computed over whichever pins happened to run.
  const evaluatedRows = contamination.rows.filter((r) => r.status === 'ok' || r.status === 'attention');
  const notObservedRows = contamination.rows.filter((r) => r.status === 'not-observed');
  const contaminatedRows = evaluatedRows.filter((r) => r.status === 'attention');
  const totalPins = evaluatedRows.length + notObservedRows.length;
  const notObservedText = notObservedRows.length > 0
    ? ` (${notObservedRows.length} of ${totalPins} declared pin(s) never observed this window)`
    : '';
  const contaminationText = contaminatedRows.length === 0
    ? `no model contamination${notObservedText}`
    : `at least ${contaminatedRows.reduce((s, r) => s + r.offPinRuns, 0)}/${evaluatedRows.reduce((s, r) => s + r.totalRuns, 0)} ` +
      `runs off declared pin across ${contaminatedRows.length} sub-agent(s) (floor — sub_agents undercounts, see Integrity panel)${notObservedText}`;

  return {
    severity: flagged.length > 0 || contaminatedRows.length > 0 ? 'attention' : 'ok',
    text: `n=${integrity.sampleSize} · ${flaggedText} · ${contaminationText}`,
  };
}

/** Eval-only levers (`PR_REVIEW_NO_POST` and friends) are not expected to be
 *  active in normal production operation — one left on by accident is a
 *  silent behaviour change (e.g. `NO_POST=1` would mean nothing gets
 *  posted). Any active lever is therefore 'attention', named explicitly. */
export function assessLevers(levers: LeverStatus[]): SimpleAssessment {
  const active = levers.filter((l) => l.state === 'active');
  if (active.length === 0) {
    return { severity: 'ok', text: `0/${levers.length} eval levers active` };
  }
  return {
    severity: 'attention',
    text: `${active.length}/${levers.length} eval levers active: ${active.map((l) => l.key).join(', ')}`,
  };
}

/** A round, documented bar — not tuned to any observed value — mirroring
 *  `MIN_RELIABLE_COVERAGE_PCT`'s precedent in stats.ts. */
export const ERROR_RATE_ATTENTION_THRESHOLD = 0.1;

/** Small samples say so: a 7d window can hold a handful of reviews, where a
 *  single error swings the rate wildly. `lowSample` (from the endpoint's own
 *  `WindowMeta`) gates the wording, never the number itself — the rate is
 *  still shown, just annotated as unreliable rather than omitted. */
export function assessErrorRate(errorRate: IntegrityStats['errorRate'], lowSample: boolean): SimpleAssessment {
  if (errorRate.total === 0) {
    return { severity: 'ok', text: 'no reviews recorded in this window' };
  }
  const pct = errorRate.rate == null ? 'n/a' : `${(errorRate.rate * 100).toFixed(1)}%`;
  const sampleNote = lowSample ? `small sample, n=${errorRate.total}` : `n=${errorRate.total}`;
  const attention = errorRate.rate != null && errorRate.rate > ERROR_RATE_ATTENTION_THRESHOLD;
  return { severity: attention ? 'attention' : 'ok', text: `${errorRate.count}/${errorRate.total} errored — ${pct} (${sampleNote})` };
}

// ---------------------------------------------------------------------------
// worstStatus and its supporting types (moved from stats-view.tsx).
// `describeFetchState`, which used to sit here too, was deleted rather than
// moved (fix round 1): it had zero production callers before the move and
// zero after — only its own test called it. `SlotSourceInfo`/`SlotStatus`
// stayed: they are `worstStatus`'s real parameter/return types, so they are
// load-bearing even though nothing imports them by name (every caller
// passes duck-typed object literals).
// ---------------------------------------------------------------------------

export type SlotStatus = 'loading' | 'error' | 'empty' | 'ready';

export interface SlotSourceInfo {
  label: string;
  status: SlotStatus;
  message: string;
}

const STATUS_RANK: Record<SlotStatus, number> = { error: 0, loading: 1, empty: 2, ready: 3 };

/** Combine multiple source statuses into the single worst one, for a slot's
 *  overall border colour — error beats loading beats empty beats ready.
 *  Pure — exported for unit testing. */
export function worstStatus(sources: SlotSourceInfo[]): SlotStatus {
  return sources.reduce<SlotStatus>((worst, s) => (STATUS_RANK[s.status] < STATUS_RANK[worst] ? s.status : worst), 'ready');
}
