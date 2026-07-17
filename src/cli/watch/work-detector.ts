import type { PipelineState, TestCaseFailure } from '../../types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// Pure work detector
//
// This module is the DECISION half of the watcher's polling. It takes
// ALREADY-GATHERED per-item facts (WIQL buckets, loaded state, matched
// comments, PR status) and returns the intended actions as DATA — no store,
// no fetch, no tag writes, no side effects. The effectful gather + apply
// layers live in `../watch.ts`.
//
// A `DetectedAction` carries the intended state-delta and tag-ops rather than
// performing them, so the dispatcher can apply them deterministically and this
// decision stays unit-testable with plain fixtures.
// ---------------------------------------------------------------------------

/** Reason an item was selected — also determines dispatch (start-fresh vs continue). */
export type WatchActionKind = 'start-fresh' | 'continue' | 'rerun' | 'pr-completed' | 'reprovision';

export interface DetectedAction {
  kind: WatchActionKind;
  workItemId: number;
  /** Intended mutation to merge into the loaded state before dispatch. */
  stateDelta?: Partial<PipelineState>;
  /** Intended work-item tag mutations. */
  tagOps?: { add?: string[]; remove?: string[] };
  /** Operator-facing log line the dispatcher should emit (keeps watcher logs faithful). */
  log?: string;
}

// ---------------------------------------------------------------------------
// Gathered inputs — one field per detection path
// ---------------------------------------------------------------------------

export interface PlanApprovedItem {
  id: number;
  /** State loaded for the plan-approved-tagged item (null if none persisted). */
  state: PipelineState | null;
}

/** Comment-scan facts for one paused item. At most one feedback is set when the
 *  gather layer short-circuits (rerun-plan > fix > fix-test), but the decision
 *  applies that precedence independently, so multiple may be set in tests. */
export interface CheckpointScan {
  id: number;
  rerunPlanFeedback: string | null;
  fixFeedback: string | null;
  fixTestFeedback: string | null;
  fixTestSource: 'work-item-comment' | 'pr-comment' | null;
  /** Fetched only when /fix-test matched; undefined if the fetch failed. */
  testCaseFailures?: TestCaseFailure[];
}

export interface PrCompletedItem {
  id: number;
  /** Result of getPullRequestStatus; null when the PR could not be fetched. */
  prStatus: { status: string; isDraft: boolean } | null;
}

export interface ReprovisionItem {
  id: number;
  /** Whether a /reprovision-env PR comment was found since the pause point. */
  commentFound: boolean;
}

export interface WorkDetectionInputs {
  /** Items already running — excluded from every path. */
  skipIds: Set<number>;
  /** Items tagged need-input — blocks the plan-approved error-resume auto-retry. */
  needInputIds: Set<number>;
  analyseIds: number[];
  planApproved: PlanApprovedItem[];
  checkpointScans: CheckpointScan[];
  prCompleted: PrCompletedItem[];
  reprovision: ReprovisionItem[];
}

// ---------------------------------------------------------------------------
// Shared pure predicates — used by BOTH this decision and the gather layer's
// I/O gating (so the two never diverge on which items are candidates).
// ---------------------------------------------------------------------------

/** Checkpoints whose paused items are scanned for /rerun-plan | /fix | /fix-test. */
export const SCANNABLE_CHECKPOINTS = new Set(['plan-approved', 'pr-published']);

/** True when an item is paused at a scannable checkpoint or sitting in error state. */
export function isCheckpointScannable(s: PipelineState): boolean {
  if (s.completedAt) return false;
  if (s.error) return true;
  return !!(s.checkpoint && SCANNABLE_CHECKPOINTS.has(s.checkpoint.name));
}

/** True when an item paused at a PR checkpoint (with a PR, no error) can auto-continue. */
export function isPrCompletedCandidate(s: PipelineState): boolean {
  if (s.completedAt) return false;
  if (s.error) return false;
  return (s.checkpoint?.name === 'pr-completed' || s.checkpoint?.name === 'pr-published') && !!s.draftPR?.id;
}

/** True when an item with a PR, paused at any checkpoint or in error, may be reprovisioned. */
export function isReprovisionCandidate(s: PipelineState): boolean {
  if (s.completedAt || !s.draftPR?.id) return false;
  return s.checkpoint != null || s.error != null;
}

/** The timestamp comment scans use as their "since" lower bound. */
export function sinceFor(s: PipelineState): string | undefined {
  return s.error?.timestamp ?? s.checkpoint?.enteredAt;
}

// ---------------------------------------------------------------------------
// applyRerun — the shared rerun state-delta builder
//
// Both the comment-scan decision below (`decideCheckpointScan`, called with
// `{}` to build a `stateDelta`) and the dashboard's rerun-plan/fix/fix-test
// action arms (`action-processor.ts`, called with the loaded `PipelineState`
// to mutate it directly before saving) previously carried their own copy of
// this exact block. This is now the one definition both call.
// ---------------------------------------------------------------------------

export type RerunMode = 'rerun-plan' | 'fix' | 'fix-test';

export interface ApplyRerunOptions {
  mode: RerunMode;
  /** Raw feedback text, command prefix included (e.g. "/fix null-ref"). */
  feedback: string;
  source: 'work-item-comment' | 'pr-comment' | 'dashboard';
  targetStage: string;
  /** Only meaningful for mode 'fix-test'. */
  testCaseFailures?: TestCaseFailure[];
}

const RERUN_COMMAND_PREFIX: Record<RerunMode, RegExp> = {
  'rerun-plan': /^\s*\/rerun-plan\s*/i,
  'fix': /^\s*\/fix\s*/i,
  'fix-test': /^\s*\/fix-test\s*/i,
};

/**
 * Apply the rerun state-delta: clears error/checkpoint, records
 * revisionFeedback + humanFeedback (command prefix stripped from the
 * feedback text), and sets rerunMode for fix/fix-test (rerun-plan sets no
 * rerunMode key at all, matching the original per-mode behaviour).
 *
 * `humanFeedback.source` only accepts 'work-item-comment' | 'pr-comment' —
 * there is no dashboard-authored comment to attribute — so a 'dashboard'
 * revisionFeedback source maps to 'work-item-comment' here, matching what
 * the original dashboard action arms hardcoded.
 *
 * Pass `{}` to build a standalone delta (the pure decision below); pass a
 * loaded `PipelineState` to mutate it in place (the dashboard action arm).
 * Mutates and returns its first argument.
 */
export function applyRerun(state: Partial<PipelineState>, opts: ApplyRerunOptions): Partial<PipelineState> {
  const { mode, feedback, source, targetStage, testCaseFailures } = opts;

  state.error = undefined;
  state.checkpoint = undefined;
  if (mode !== 'rerun-plan') state.rerunMode = mode;
  state.revisionFeedback = { source, feedback, targetStage };

  const message = feedback.replace(RERUN_COMMAND_PREFIX[mode], '').trim();
  const humanFeedbackSource: 'work-item-comment' | 'pr-comment' = source === 'pr-comment' ? 'pr-comment' : 'work-item-comment';
  state.humanFeedback = mode === 'fix-test'
    ? { rerunComment: message || feedback, source: humanFeedbackSource, testCaseFailures }
    : { rerunComment: message || feedback, source: humanFeedbackSource };

  return state;
}

// ---------------------------------------------------------------------------
// Per-item decisions
// ---------------------------------------------------------------------------

/** Translate a checkpoint comment scan into a rerun action, honouring precedence. */
function decideCheckpointScan(scan: CheckpointScan): DetectedAction | null {
  const { id, rerunPlanFeedback, fixFeedback, fixTestFeedback, fixTestSource, testCaseFailures } = scan;

  if (rerunPlanFeedback) {
    return {
      kind: 'rerun',
      workItemId: id,
      stateDelta: applyRerun({}, {
        mode: 'rerun-plan', feedback: rerunPlanFeedback, source: 'work-item-comment', targetStage: 'planning',
      }),
      tagOps: { remove: ['need-input', 'plan-approved'] },
      log: 'Found /rerun-plan comment — restarting planning',
    };
  }

  if (fixFeedback) {
    return {
      kind: 'rerun',
      workItemId: id,
      stateDelta: applyRerun({}, {
        mode: 'fix', feedback: fixFeedback, source: 'work-item-comment', targetStage: 'coding',
      }),
      tagOps: { remove: ['need-input'] },
      log: 'Found /fix comment — restarting coding',
    };
  }

  if (fixTestFeedback && fixTestSource) {
    return {
      kind: 'rerun',
      workItemId: id,
      stateDelta: applyRerun({}, {
        mode: 'fix-test', feedback: fixTestFeedback, source: fixTestSource, targetStage: 'coding', testCaseFailures,
      }),
      tagOps: { remove: ['need-input'] },
      log: 'Found /fix-test comment — fetching test case failures and restarting coding',
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// detectWork — the pure decision over all gathered facts
// ---------------------------------------------------------------------------

/**
 * Decide the watcher's actions for one poll cycle from already-gathered facts.
 * Pure: no store, no fetch, no writes. Precedence matches the legacy poll —
 *   1. analyse tag              → start-fresh (always honoured)
 *   2. plan-approved tag        → continue (checkpoint-ready OR error-resume)
 *   3/4/5. comment scans        → rerun (rerun-plan > fix > fix-test)
 *   6. completed PR             → pr-completed (auto-continue)
 *   7. /reprovision-env comment → reprovision (side effect)
 * Paths 3-7 skip ids already claimed by an earlier path; path 2 intentionally
 * does NOT dedup against path 1 (an item tagged both yields both actions).
 */
export function detectWork(inputs: WorkDetectionInputs): DetectedAction[] {
  const { skipIds, needInputIds, analyseIds, planApproved, checkpointScans, prCompleted, reprovision } = inputs;
  const actions: DetectedAction[] = [];
  const claimed = new Set<number>();

  // Path 1: 'analyse' tag → start fresh. Explicit restart signal; honoured even
  // when state already exists (user re-running after a previous attempt).
  for (const id of analyseIds) {
    if (skipIds.has(id)) continue;
    actions.push({ kind: 'start-fresh', workItemId: id });
    claimed.add(id);
  }

  // Path 2: 'plan-approved' tag → continue. NOTE: not deduped against path 1 —
  // preserves the legacy behaviour where an item tagged both gets both actions.
  for (const { id, state } of planApproved) {
    if (skipIds.has(id)) continue;
    if (state?.checkpoint?.name === 'plan-approved') {
      actions.push({ kind: 'continue', workItemId: id });
      claimed.add(id);
    } else if (state?.error && !needInputIds.has(id)) {
      // Pipeline failed after the plan-approved checkpoint (e.g. env-provision or
      // coding). plan-approved is still set and need-input was removed → the user
      // wants to retry. Gating on need-input's absence prevents infinite retry
      // loops (a failed container re-adds need-input).
      const stateDelta: Partial<PipelineState> = { error: undefined };
      if (state.error.type === 'revision-exhausted') stateDelta.skipResetState = true;
      actions.push({
        kind: 'continue',
        workItemId: id,
        stateDelta,
        log: `plan-approved tag present with error at "${state.error.stage}", need-input removed — resuming`,
      });
      claimed.add(id);
    }
  }

  // Paths 3/4/5: /rerun-plan, /fix, /fix-test on paused items.
  for (const scan of checkpointScans) {
    if (skipIds.has(scan.id) || claimed.has(scan.id)) continue;
    const action = decideCheckpointScan(scan);
    if (action) {
      actions.push(action);
      claimed.add(scan.id);
    }
  }

  // Path 6: completed PRs auto-continue.
  for (const { id, prStatus } of prCompleted) {
    if (skipIds.has(id) || claimed.has(id)) continue;
    if (prStatus?.status === 'completed') {
      actions.push({ kind: 'pr-completed', workItemId: id, log: 'PR completed — auto-continuing pipeline' });
      claimed.add(id);
    }
  }

  // Path 7: /reprovision-env PR comment → reprovision side effect.
  for (const { id, commentFound } of reprovision) {
    if (skipIds.has(id) || claimed.has(id)) continue;
    if (commentFound) {
      actions.push({ kind: 'reprovision', workItemId: id, log: 'Found /reprovision-env PR comment — scheduling environment reprovision' });
      claimed.add(id);
    }
  }

  return actions;
}
