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
 * test environment was provisioned — successful env-publish AND passing env tests. The
 * env conditions are skipped only when no environment exists (so env-less pipelines aren't
 * permanently blocked); when an env is present, publishing + testing on a real BC env are
 * hard approval conditions.
 */
export function codingIsApproved(state: PipelineState): boolean {
  const lastReview = state.codeReviews?.at(-1);
  const reviewerApproved = lastReview?.verdict === 'approve';
  const ciPassed = state.changeset?.ciResult === 'passed';

  const envExists = state.environment?.envId != null;
  const envValidated =
    !envExists ||
    (state.changeset?.envPublished === true && state.changeset?.envTestsPassed === true);

  return reviewerApproved && ciPassed && envValidated;
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

/** Reset planning state: clears plan reviews + all downstream outputs */
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
      resetState: (state) => ({ ...state, codeReviews: [] }),
      postProducer: buildCIVerificationHook(config),
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
