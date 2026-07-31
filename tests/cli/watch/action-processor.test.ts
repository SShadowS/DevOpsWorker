import { describe, test, expect } from 'bun:test';
import { applyRerun, type ApplyRerunOptions } from '../../../src/cli/watch/work-detector.ts';
import { ensurePat } from '../../../src/cli/watch/env-actions.ts';
import { buildReviewPrExtraArgs } from '../../../src/cli/watch/action-processor.ts';
import { parseWebhookPayload } from '../../../src/webhook-server/parse.ts';
import { buildReviewPrActionFeedback } from '../../../src/webhook-server/index.ts';
import { parseReviewPrArgs } from '../../../src/cli/review-pr.ts';
import type { PipelineConfig, PipelineState, TestCaseFailure } from '../../../src/types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// applyRerun — the rerun state-delta block, previously pasted independently
// in the pure work-detector's decideCheckpointScan (comment path) AND in the
// dashboard's rerun-plan/fix/fix-test action arms (watch.ts). Both now build
// their delta through this one function: the work-detector calls it with an
// empty accumulator to get a `stateDelta` object; the dashboard action arm
// calls it with the loaded `state` to mutate it directly before saving.
// ---------------------------------------------------------------------------

describe('applyRerun', () => {
  test('rerun-plan: clears error/checkpoint, strips the command, targets planning, no rerunMode key', () => {
    const result = applyRerun({}, {
      mode: 'rerun-plan',
      feedback: '/rerun-plan tighten the spec',
      source: 'work-item-comment',
      targetStage: 'planning',
    });
    expect(result).toEqual({
      error: undefined,
      checkpoint: undefined,
      revisionFeedback: { source: 'work-item-comment', feedback: '/rerun-plan tighten the spec', targetStage: 'planning' },
      humanFeedback: { rerunComment: 'tighten the spec', source: 'work-item-comment' },
    });
    expect('rerunMode' in result).toBe(false);
    expect('testCaseFailures' in (result.humanFeedback ?? {})).toBe(false);
  });

  test('rerun-plan: falls back to raw feedback when nothing follows the command', () => {
    const result = applyRerun({}, {
      mode: 'rerun-plan',
      feedback: '/rerun-plan',
      source: 'work-item-comment',
      targetStage: 'planning',
    });
    expect(result.humanFeedback!.rerunComment).toBe('/rerun-plan');
  });

  test('fix: sets rerunMode "fix", targets coding, strips the command', () => {
    const result = applyRerun({}, {
      mode: 'fix',
      feedback: '/fix null-ref in codeunit',
      source: 'work-item-comment',
      targetStage: 'coding',
    });
    expect(result).toEqual({
      error: undefined,
      checkpoint: undefined,
      rerunMode: 'fix',
      revisionFeedback: { source: 'work-item-comment', feedback: '/fix null-ref in codeunit', targetStage: 'coding' },
      humanFeedback: { rerunComment: 'null-ref in codeunit', source: 'work-item-comment' },
    });
  });

  test('fix-test: sets rerunMode "fix-test" and carries testCaseFailures through', () => {
    const failures: TestCaseFailure[] = [{ testCaseId: 1, title: 'T', outcome: 'Failed', failedSteps: [] }];
    const result = applyRerun({}, {
      mode: 'fix-test',
      feedback: '/fix-test see failing steps',
      source: 'work-item-comment',
      targetStage: 'coding',
      testCaseFailures: failures,
    });
    expect(result).toEqual({
      error: undefined,
      checkpoint: undefined,
      rerunMode: 'fix-test',
      revisionFeedback: { source: 'work-item-comment', feedback: '/fix-test see failing steps', targetStage: 'coding' },
      humanFeedback: { rerunComment: 'see failing steps', source: 'work-item-comment', testCaseFailures: failures },
    });
  });

  test('fix-test: pr-comment source propagates to both revisionFeedback and humanFeedback', () => {
    const result = applyRerun({}, {
      mode: 'fix-test',
      feedback: '/fix-test',
      source: 'pr-comment',
      targetStage: 'coding',
    });
    expect(result.revisionFeedback!.source).toBe('pr-comment');
    expect(result.humanFeedback!.source).toBe('pr-comment');
    expect(result.humanFeedback!.testCaseFailures).toBeUndefined();
  });

  test('dashboard source: revisionFeedback.source is "dashboard" but humanFeedback.source is "work-item-comment"', () => {
    // humanFeedback.source's type only accepts 'work-item-comment' | 'pr-comment' —
    // there is no dashboard-authored comment to attribute, so a 'dashboard'
    // revisionFeedback source maps to 'work-item-comment' on humanFeedback,
    // matching what the original dashboard action arms hardcoded.
    const opts: ApplyRerunOptions = {
      mode: 'fix',
      feedback: '/fix from the dashboard button',
      source: 'dashboard',
      targetStage: 'coding',
    };
    const result = applyRerun({}, opts);
    expect(result.revisionFeedback!.source).toBe('dashboard');
    expect(result.humanFeedback!.source).toBe('work-item-comment');
  });

  test('mutates a live PipelineState object in place and returns it (dashboard call shape)', () => {
    const state = {
      currentStage: 'x',
      telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
      startedAt: '2026-01-01T00:00:00.000Z',
      error: { type: 'E', stage: 'coding', message: 'boom', timestamp: 't' },
      checkpoint: { name: 'pr-published', enteredAt: 't' },
    } as unknown as PipelineState;

    const returned = applyRerun(state, {
      mode: 'fix',
      feedback: '/fix retry',
      source: 'dashboard',
      targetStage: 'coding',
    });

    expect(returned).toBe(state); // same reference — mutated in place
    expect(state.error).toBeUndefined();
    expect(state.checkpoint).toBeUndefined();
    expect(state.rerunMode).toBe('fix');
    expect(state.humanFeedback!.rerunComment).toBe('retry');
  });
});

// ---------------------------------------------------------------------------
// ensurePat — the PAT-fallback injection previously pasted at ~4 call sites
// in 2 spellings (`config.azureDevOps.pat === ''` in container-dispatcher.ts,
// `!prConfig.azureDevOps.pat` / `!config.azureDevOps.pat` elsewhere in
// watch.ts). `azureDevOps.pat` is a required `string` field (never null /
// undefined per the type), so in the values actually in play both spellings
// only ever distinguish '' from a real token — one falsy-check spelling
// covers both.
// ---------------------------------------------------------------------------

function mockConfig(pat: string): PipelineConfig {
  return {
    azureDevOps: {
      organization: 'org', orgUrl: 'https://dev.azure.com/org', project: 'proj',
      repositoryId: 'r', repositoryName: 'R', ciPipelineId: 1, cdPipelineId: 2,
      areaPath: 'A', iterationPath: 'I', pat,
    },
    paths: { sessionRoot: '/tmp', targetRepo: '/tmp/doc', stateDir: '/tmp/state' },
    checkpoints: {
      planApproval: { tag: 'plan-approved', rerunCommand: '/rerun-plan', timeoutHours: 1 },
      prPublished: { fixCommand: '/fix', timeoutHours: 1 },
      pollIntervalMinutes: 1,
    },
    revisionLoops: { maxAttempts: 3 },
    models: { default: 'test' },
    costs: {},
    repoKey: 'DocumentOutput',
    layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
  };
}

// ---------------------------------------------------------------------------
// buildReviewPrExtraArgs — the webhook forceFull -> --full bridge.
//
// This is the exact bridge that let `prTitle` go missing before: threaded into
// the action payload correctly, but never read back out here into an argv
// flag, so cherry-pick detection silently never saw it. Pinned directly
// (not via a source-text regex) so a field dropped from the array below fails
// this test rather than a weaker "does the string 'forceFull' appear anywhere".
// ---------------------------------------------------------------------------

describe('buildReviewPrExtraArgs', () => {
  test('appends --full when the payload carries forceFull (a /review-full comment or --full CLI call)', () => {
    const args = buildReviewPrExtraArgs({ prId: 1, repositoryId: 'repo-guid', forceFull: true }, 42);
    expect(args).toContain('--full');
  });

  test('omits --full for a plain /review — forceFull absent, not just falsy', () => {
    const args = buildReviewPrExtraArgs({ prId: 1, repositoryId: 'repo-guid' }, 42);
    expect(args).not.toContain('--full');
  });

  test('omits --full when forceFull is explicitly false', () => {
    const args = buildReviewPrExtraArgs({ prId: 1, repositoryId: 'repo-guid', forceFull: false }, 42);
    expect(args).not.toContain('--full');
  });

  test('every other flag still forwards unchanged, in the same shape as before', () => {
    const args = buildReviewPrExtraArgs(
      { prId: 7, repositoryId: 'r', sourceBranch: 'refs/heads/x', targetBranch: 'refs/heads/y', prUrl: 'https://example/pr/7' },
      3,
    );
    expect(args).toEqual([
      '--pr-id', '7',
      '--repo-id', 'r',
      '--source-branch', 'refs/heads/x',
      '--target-branch', 'refs/heads/y',
      '--pr-url', 'https://example/pr/7',
      '--action-id', '3',
    ]);
  });

  test('missing sourceBranch/targetBranch/prUrl degrade the same way as before (empty string / omitted)', () => {
    const args = buildReviewPrExtraArgs({ prId: 1, repositoryId: 'r' }, undefined);
    expect(args).toEqual([
      '--pr-id', '1',
      '--repo-id', 'r',
      '--source-branch', '',
      '--target-branch', '',
      '--action-id', 'undefined',
    ]);
  });
});

// ---------------------------------------------------------------------------
// forceFull composition: webhook payload -> action feedback -> argv -> parsed
// args, run through the four *real* functions end to end.
//
// Each hop already has its own unit test (parse.test.ts, webhook-server's
// index.test.ts, this file's buildReviewPrExtraArgs describe above,
// review-pr.test.ts's parseReviewPrArgs describe) but nothing runs them
// back-to-back. That gap is exactly how `prTitle` went missing before:
// correct at each hop in isolation, dropped at the boundary between them.
// The action-processor's `payload` is `JSON.parse(...)` typed `any` at the
// real `executeAction` call site, so a field lost at that boundary costs
// nothing at compile time — only a composition test like this one catches
// it. Nothing here is mocked; a fixed payload shape is fed through
// parseWebhookPayload -> buildReviewPrActionFeedback -> JSON.parse ->
// buildReviewPrExtraArgs -> parseReviewPrArgs exactly as watch.ts's
// action-processor and review-pr.ts's CLI entry point do.
// ---------------------------------------------------------------------------

describe('forceFull composition: webhook -> action -> argv -> parsed args', () => {
  // Same shape as commentEventPayload() in tests/webhook-server/parse.test.ts
  // (not exported from there, so reconstructed here rather than invented).
  function commentEventPayload(commentContent: string): Record<string, unknown> {
    return {
      eventType: 'ms.vss-code.git-pullrequest-comment-event',
      createdDate: new Date().toISOString(),
      resource: {
        comment: {
          id: 1,
          content: commentContent,
          _links: {
            self: {
              href: 'https://dev.azure.com/org/_apis/git/repositories/repo-id/pullRequests/100/threads/5001/comments/1',
            },
          },
        },
        pullRequest: {
          pullRequestId: 100,
          repository: {
            id: 'repo-guid-456',
            name: 'My Repo',
            project: { id: 'proj-id', name: 'My Project' },
          },
          sourceRefName: 'refs/heads/feature/review-me',
          targetRefName: 'refs/heads/master',
          status: 'active',
          createdBy: { displayName: 'Jane Doe' },
          url: 'https://dev.azure.com/org/proj/_apis/git/repositories/repo-id/pullRequests/100',
        },
      },
    };
  }

  function forceFullThroughTheChain(commentContent: string): boolean {
    const event = parseWebhookPayload(commentEventPayload(commentContent));
    if (!event) throw new Error(`expected a parsed event for comment ${JSON.stringify(commentContent)}`);
    const feedback = buildReviewPrActionFeedback(event, 'DocumentOutput');
    const payload = JSON.parse(feedback); // matches executeAction's own untyped JSON.parse
    const extraArgs = buildReviewPrExtraArgs(payload, 42);
    return parseReviewPrArgs(extraArgs).forceFull;
  }

  test('/review-full survives all four real hops as forceFull === true', () => {
    expect(forceFullThroughTheChain('/review-full')).toBe(true);
  });

  test('/review survives all four real hops as forceFull === false', () => {
    expect(forceFullThroughTheChain('/review')).toBe(false);
  });
});

describe('ensurePat', () => {
  test('injects the fallback when pat is the empty string (the "=== \'\'" call sites\' case)', () => {
    const cfg = mockConfig('');
    ensurePat(cfg, 'live-pat');
    expect(cfg.azureDevOps.pat).toBe('live-pat');
  });

  test('injects the fallback when pat is falsy (the "!pat" call sites\' case — same values)', () => {
    const cfg = mockConfig('' as string);
    ensurePat(cfg, 'live-pat');
    expect(cfg.azureDevOps.pat).toBe('live-pat');
  });

  test('leaves an existing pat untouched', () => {
    const cfg = mockConfig('persisted-pat');
    ensurePat(cfg, 'live-pat');
    expect(cfg.azureDevOps.pat).toBe('persisted-pat');
  });

  test('returns the same config reference (mutated in place)', () => {
    const cfg = mockConfig('');
    const result = ensurePat(cfg, 'live-pat');
    expect(result).toBe(cfg);
  });
});
