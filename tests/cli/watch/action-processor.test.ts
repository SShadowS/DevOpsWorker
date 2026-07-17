import { describe, test, expect } from 'bun:test';
import { applyRerun, type ApplyRerunOptions } from '../../../src/cli/watch/work-detector.ts';
import { ensurePat } from '../../../src/cli/watch/env-actions.ts';
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
