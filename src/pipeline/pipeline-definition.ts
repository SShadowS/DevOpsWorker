import type { PipelineDefinition, PipelineConfig, PipelineState, PipelineContext } from '../types/pipeline.types.ts';
import type { RepoConfig } from '../config/repo-config.ts';
import { revisionLoop } from './revision-loop.ts';
import { checkpoint } from './checkpoint.ts';
import { verifyCIResult } from './ci-verification.ts';
import { resolvePipeline } from '../overlay/index.ts';

// Agent stage imports (will be implemented per-agent)
import { analyzerStage } from '../agents/analyzer/config.ts';
import { plannerStage } from '../agents/planner/config.ts';
import { planReviewerStage } from '../agents/plan-reviewer/config.ts';
import { coderStage } from '../agents/coder/config.ts';
import { codeReviewerStage } from '../agents/code-reviewer/config.ts';
import { draftPRStage } from '../agents/draft-pr/config.ts';
import { testCasesStage } from '../agents/test-cases/config.ts';
import { testCaseReviewerStage } from '../agents/test-case-reviewer/config.ts';
import { testCaseActivation } from './test-case-activation.ts';
import { documenterStage } from '../agents/documenter/config.ts';
import { docsWriterStage } from '../agents/docs-writer/config.ts';

// ---------------------------------------------------------------------------
// Reset state callbacks (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Coding revision loop gate. Requires reviewer approval AND CI success, plus — when a BC
 * test environment was provisioned — successful env-publish AND passing env tests, OR a
 * declared skip (`envSkipReason`) when the env was genuinely unusable. The env conditions
 * are waived entirely only when no environment exists.
 */
export function codingIsApproved(state: PipelineState): boolean {
  const lastReview = state.codeReviews?.at(-1);
  const reviewerApproved = lastReview?.verdict === 'approve';
  const ciPassed = state.changeset?.ciResult === 'passed';

  const envExists = state.environment?.envId != null;
  // A DECLARED skip (envSkipReason non-empty) satisfies the env conjunct: the
  // coder's prompt documents a CI-only fallback for an unreachable env, and a
  // gate that forbade the documented fallback made every post-fallback round
  // unapprovable regardless of code quality (WI 81098: env auto-stopped during
  // the LSP outage, fallback taken at 14:50, budget exhausted at 19:28 on a
  // gate no round could pass). The skip is visible — formatChangesetSummary
  // renders it — so the human approving the PR sees env validation was skipped.
  const envSkipDeclared = Boolean(state.changeset?.envSkipReason?.trim());
  const envValidated =
    !envExists ||
    envSkipDeclared ||
    (state.changeset?.envPublished === true && state.changeset?.envTestsPassed === true);

  return reviewerApproved && ciPassed && envValidated;
}

/**
 * Name the conjunct that refused an otherwise-approved coding round.
 *
 * Only speaks when the reviewer approved — a `revise` verdict carries its own
 * revisionInstructions and this would be noise beside them. Feeds the loop's
 * `explainGate` hook, which stores it as `state.gateFailure` for the next
 * round's coder prompt.
 */
export function explainCodingGate(state: PipelineState): string | undefined {
  const lastReview = state.codeReviews?.at(-1);
  if (lastReview?.verdict !== 'approve') return undefined;
  if (codingIsApproved(state)) return undefined;

  const failed: string[] = [];
  if (state.changeset?.ciResult !== 'passed') {
    failed.push(`ciResult=${state.changeset?.ciResult ?? 'undefined'} (must be 'passed')`);
  }
  const envExists = state.environment?.envId != null;
  const envSkipDeclared = Boolean(state.changeset?.envSkipReason?.trim());
  if (envExists && !envSkipDeclared) {
    if (state.changeset?.envPublished !== true) failed.push('envPublished is not true');
    if (state.changeset?.envTestsPassed !== true) failed.push('envTestsPassed is not true');
  }
  if (failed.length === 0) return undefined;
  return (
    `The reviewer APPROVED this round, but the coding gate refused it: ${failed.join('; ')}. `
    + `Fix these conditions — the review feedback is not what is blocking you. `
    + `If the BC environment is genuinely unusable, start it (env start), and only after a `
    + `bounded wait declare the skip via envSkipReason.`
  );
}

/**
 * Findings the code reviewer reported in its most recent round.
 *
 * `state.codeReviews` is typed `ReviewVerdict[]` (the shared minimum; core must
 * not import agent schemas), so read the count structurally. Returns undefined
 * when no review has landed yet — the convergence trigger then has nothing to
 * measure and simply does not fire.
 */
export function countCodeReviewIssues(state: PipelineState): number | undefined {
  const last = state.codeReviews?.at(-1) as { issues?: unknown[] } | undefined;
  return Array.isArray(last?.issues) ? last.issues.length : undefined;
}

/** Issue count of the newest plan review — feeds the planning convergence trigger. */
export function countPlanReviewIssues(state: PipelineState): number | undefined {
  const last = state.planReviews?.at(-1) as { issues?: unknown[] } | undefined;
  return Array.isArray(last?.issues) ? last.issues.length : undefined;
}

/** Finding texts per plan-review round, oldest first. Plan-review issues carry
 *  `description` where code-review issues carry `comment` — same information,
 *  different spelling (see REVIEWS_BY_LOOP's normaliser for the third variant). */
export function collectPlanReviewFindings(state: PipelineState): string[][] {
  return (state.planReviews ?? []).map((r) => {
    const issues = (r as { issues?: Array<{ description?: string }> }).issues ?? [];
    return issues.map((i) => i.description ?? '').filter(Boolean);
  });
}

/** Convergence config for the planning loop — shared by both pipeline builders.
 *
 *  Extended beyond coding on 2026-08-20: work items 81098 and 81493 each
 *  exhausted five planning rounds. Honestly noted: their counts wobbled
 *  downward (13→9→12→10→8), which the strict non-decreasing plateau test does
 *  NOT catch — those two runs were cured by the deferred-AC mechanism instead.
 *  This trigger is the backstop for the genuinely flat case, where asking a
 *  human one round earlier is strictly cheaper than burning the budget. */
const PLANNING_CONVERGENCE = {
  window: 3,
  question:
    'The plan review has run several rounds without the finding count going down, '
    + 'so it is not converging on its own. Please look at the recurring findings above '
    + 'and reply with a decision: which of them should actually be fixed, which are '
    + 'wrong or out of scope, and anything the reviewers are missing. '
    + 'Reply with `/rerun-plan <your answer>` to resume the planner with that direction.',
};

/** Finding texts per code-review round, oldest first. */
export function collectCodeReviewFindings(state: PipelineState): string[][] {
  return (state.codeReviews ?? []).map((r) => {
    const issues = (r as { issues?: Array<{ comment?: string }> }).issues ?? [];
    return issues.map((i) => i.comment ?? '').filter(Boolean);
  });
}

/** Build a postProducer hook that verifies CI results server-side. */
export function buildCIVerificationHook(config: PipelineConfig) {
  return async (state: PipelineState, context: PipelineContext): Promise<PipelineState> => {
    const ciRunId = state.changeset?.ciRunId;
    if (!ciRunId) return state;

    const result = await verifyCIResult(ciRunId, config);
    if (result.ciResult === 'failed') {
      context.logger?.log(
        `CI verification backstop: errors found in ${result.tasksFailed.join(', ')}`,
      );
      return {
        ...state,
        changeset: {
          ...state.changeset!,
          ciResult: 'failed',
          compilationErrors: [
            ...(state.changeset!.compilationErrors ?? []),
            ...result.errors,
          ],
        },
      };
    }
    return state;
  };
}

/** Reset planning state: clears plan reviews + all downstream outputs AND
 *  downstream loop bookkeeping.
 *
 *  The bookkeeping half exists because of WI 79748: coding had exhausted its
 *  5 attempts against an old plan on Aug 5; a /rerun-plan sixteen days later
 *  produced a new approved plan, but only the OUTPUTS were reset — the spent
 *  budget survived, and the coding loop's fail-fast threw RevisionExhaustedError
 *  before the coder ran even once against the plan it had never seen. A new
 *  plan is a new starting condition for every loop downstream of it: budget,
 *  convergence history, and any stale gate-failure banner all describe rounds
 *  against a plan that no longer exists.
 *
 *  Planning's own budget is deliberately untouched — the loop manages it, and
 *  zeroing it here would let a rewind refill the very budget the loop is
 *  spending. */
export function planningResetState(state: PipelineState): PipelineState {
  return {
    ...state,
    planReviews: [],
    changeset: undefined,
    codeReviews: [],
    draftPR: undefined,
    testCases: undefined,
    testCaseReviews: [],
    docsWriterDrafts: undefined,
    workItemUpdate: undefined,
    learnedRules: undefined,
    revisionAttempts: { ...state.revisionAttempts, coding: 0, 'test-cases': 0 },
    revisionIssueCounts: { ...state.revisionIssueCounts, coding: [], 'test-cases': [] },
    gateFailure: undefined,
  };
}

// ---------------------------------------------------------------------------
// Default pipeline definition
// ---------------------------------------------------------------------------

/**
 * Build the default pipeline stage list.
 *
 * This is the standard pipeline as described in the design doc:
 * 1. Analyzer → ReadinessReport
 * 2. Planning + Plan Review (revision loop, max 3)
 * 3. CHECKPOINT: Human approves plan
 * 4. Provision BC test environment (fire-and-forget)
 * 5. Coding + Code Review (revision loop, max 3)
 * 6. Test Cases + Test Case Review (revision loop, max 3)
 * 7. Draft PR Agent
 * 8. CHECKPOINT: Human publishes draft PR
 * 9. Activate test cases (Design → Ready)
 * 10. CHECKPOINT: PR completed/merged (auto-detected by watcher)
 * 11. Documentation Agent
 * 12. Docs Writer — drafts documentation pages for docs site
 */
export function buildDefaultPipeline(config: PipelineConfig): PipelineDefinition {
  const stages: PipelineDefinition = [
    // 1. Analyze work item readiness
    analyzerStage(config),

    // 2. Planning + Plan Review revision loop
    revisionLoop({
      name: 'planning',
      producer: plannerStage(config),
      reviewer: planReviewerStage(config),
      maxAttempts: config.revisionLoops.maxAttempts,
      isApproved: (state) => {
        const lastReview = state.planReviews?.at(-1);
        return lastReview?.verdict === 'approve';
      },
      resetState: planningResetState,
      countIssues: countPlanReviewIssues,
      collectFindingTexts: collectPlanReviewFindings,
      convergence: PLANNING_CONVERGENCE,
    }),

    // 3. CHECKPOINT: Human approves plan
    checkpoint({
      name: 'plan-approved',
      detect: { type: 'tag', tag: config.checkpoints.planApproval.tag },
      rerunCommands: [
        { command: config.checkpoints.planApproval.rerunCommand, rewindToStage: 'planning' },
      ],
      timeoutHours: config.checkpoints.planApproval.timeoutHours,
    }),

    // 4. (BC env provisioning is injected here by the private overlay, anchored
    //     after 'checkpoint:plan-approved' — see OverlayManifest.pipeline.)

    // 5. Coding + Code Review revision loop
    revisionLoop({
      name: 'coding',
      producer: coderStage(config),
      reviewer: codeReviewerStage(config),
      maxAttempts: config.revisionLoops.maxAttempts,
      isApproved: codingIsApproved,
      explainGate: explainCodingGate,
      resetState: (state) => ({ ...state, codeReviews: [] }),
      postProducer: buildCIVerificationHook(config),
      countIssues: countCodeReviewIssues,
      collectFindingTexts: collectCodeReviewFindings,
      // Planning gained the same trigger on 2026-08-20 (see PLANNING_CONVERGENCE);
      // test-cases keeps budget-exhaustion as its sole non-approval exit until a
      // stall is actually observed there.
      convergence: {
        window: 3,
        question:
          'The code review has run several rounds without the finding count going down, '
          + 'so it is not converging on its own. Please look at the recurring findings above '
          + 'and reply with a decision: which of them should actually be fixed, which are '
          + 'wrong or out of scope, and anything the reviewers are missing. '
          + 'Reply with `/fix <your answer>` to resume the coder with that direction.',
      },
    }),

    // 6. Test Cases + Test Case Review (revision loop, max 3)
    revisionLoop({
      name: 'test-cases',
      producer: testCasesStage(config),
      reviewer: testCaseReviewerStage(config),
      maxAttempts: config.revisionLoops.maxAttempts,
      isApproved: (state) => {
        const lastReview = state.testCaseReviews?.at(-1);
        return lastReview?.verdict === 'approve';
      },
      resetState: (state) => ({ ...state, testCaseReviews: [] }),
    }),

    // 7. Create draft PR
    draftPRStage(config),

    // 8. CHECKPOINT: Human publishes draft PR
    checkpoint({
      name: 'pr-published',
      detect: { type: 'draft-pr' },
      rerunCommands: [
        { command: config.checkpoints.prPublished.fixCommand,
          rewindToStage: 'coding', rerunMode: 'fix' },
        { command: config.checkpoints.planApproval.rerunCommand, rewindToStage: 'planning',
          removeTag: config.checkpoints.planApproval.tag, summarizeComments: true },
      ],
      timeoutHours: config.checkpoints.prPublished.timeoutHours,
    }),

    // 9. Activate test cases (Design → Ready) after PR approval
    testCaseActivation(),

    // 10. CHECKPOINT: PR completed/merged (auto-detected by watcher)
    checkpoint({
      name: 'pr-completed',
      detect: { type: 'pr-completed' },
      rerunCommands: [
        { command: config.checkpoints.prPublished.fixCommand, rewindToStage: 'coding', rerunMode: 'fix' },
        { command: '/fix-test', rewindToStage: 'coding', rerunMode: 'fix-test' },
      ],
    }),

    // 11. Documentation
    documenterStage(config),

    // 12. Documentation drafts for docs site
    docsWriterStage(config),
  ];

  return resolvePipeline(stages, config.overlay ?? {}, { config });
}

// ---------------------------------------------------------------------------
// Dynamic pipeline — assembled from RepoConfig
// ---------------------------------------------------------------------------

/**
 * Build a pipeline from PipelineConfig + RepoConfig.
 * Optional stages are included only when the repo config enables them.
 *
 * Core stages (always present):
 *   analyzer → planning → checkpoint:plan-approved → coding → draft-pr
 *   → checkpoint:pr-published → checkpoint:pr-completed → documenter
 *
 * Optional stages (feature-gated by RepoConfig):
 *   env-provision (after plan checkpoint, before coding)
 *   test-cases    (after coding, before draft-pr)
 *   test-case-activation (after pr-published checkpoint)
 *   docs-writer   (after documenter)
 */
export function buildPipeline(config: PipelineConfig, repo: RepoConfig): PipelineDefinition {
  const stages: PipelineDefinition = [
    // 1. Always: Analyze work item readiness
    analyzerStage(config),

    // 2. Always: Planning + Plan Review revision loop
    revisionLoop({
      name: 'planning',
      producer: plannerStage(config),
      reviewer: planReviewerStage(config),
      maxAttempts: config.revisionLoops.maxAttempts,
      isApproved: (state) => state.planReviews?.at(-1)?.verdict === 'approve',
      resetState: planningResetState,
      countIssues: countPlanReviewIssues,
      collectFindingTexts: collectPlanReviewFindings,
      convergence: PLANNING_CONVERGENCE,
    }),

    // 3. Always: Plan approval checkpoint
    checkpoint({
      name: 'plan-approved',
      detect: { type: 'tag', tag: config.checkpoints.planApproval.tag },
      rerunCommands: [
        { command: config.checkpoints.planApproval.rerunCommand, rewindToStage: 'planning' },
      ],
      timeoutHours: config.checkpoints.planApproval.timeoutHours,
    }),
  ];

  // 4. Optional: BC environment provisioning is injected by the private overlay
  //    (gated on repo.envProvision), anchored after 'checkpoint:plan-approved'.
  //    See OverlayManifest.pipeline. The public core has no env-provision stage.

  // 5. Always: Coding + Code Review revision loop
  stages.push(
    revisionLoop({
      name: 'coding',
      producer: coderStage(config),
      reviewer: codeReviewerStage(config),
      maxAttempts: config.revisionLoops.maxAttempts,
      isApproved: codingIsApproved,
      explainGate: explainCodingGate,
      resetState: (state) => ({ ...state, codeReviews: [] }),
      postProducer: buildCIVerificationHook(config),
    }),
  );

  // 6. Optional: Test Cases + Test Case Review revision loop
  if (repo.testCases) {
    stages.push(
      revisionLoop({
        name: 'test-cases',
        producer: testCasesStage(config),
        reviewer: testCaseReviewerStage(config),
        maxAttempts: config.revisionLoops.maxAttempts,
        isApproved: (state) => state.testCaseReviews?.at(-1)?.verdict === 'approve',
        resetState: (state) => ({ ...state, testCaseReviews: [] }),
      }),
    );
  }

  // 7. Always: Create draft PR
  stages.push(draftPRStage(config));

  // 8. Always: PR published checkpoint
  stages.push(
    checkpoint({
      name: 'pr-published',
      detect: { type: 'draft-pr' },
      rerunCommands: [
        { command: config.checkpoints.prPublished.fixCommand,
          rewindToStage: 'coding', rerunMode: 'fix' },
        { command: config.checkpoints.planApproval.rerunCommand, rewindToStage: 'planning',
          removeTag: config.checkpoints.planApproval.tag, summarizeComments: true },
      ],
      timeoutHours: config.checkpoints.prPublished.timeoutHours,
    }),
  );

  // 9. Optional: Test case activation (Design → Ready) after PR approval
  if (repo.testCases) {
    stages.push(testCaseActivation());
  }

  // 10. Always: PR completed checkpoint (auto-detected by watcher)
  stages.push(
    checkpoint({
      name: 'pr-completed',
      detect: { type: 'pr-completed' },
      rerunCommands: [
        { command: config.checkpoints.prPublished.fixCommand, rewindToStage: 'coding', rerunMode: 'fix' },
        { command: '/fix-test', rewindToStage: 'coding', rerunMode: 'fix-test' },
      ],
    }),
  );

  // 11. Always: Documentation
  stages.push(documenterStage(config));

  // 12. Optional: Documentation drafts for docs site
  if (repo.docsWriter) {
    stages.push(docsWriterStage(config));
  }

  return resolvePipeline(stages, config.overlay ?? {}, { config, repo });
}
