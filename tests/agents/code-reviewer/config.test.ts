import { describe, test, expect } from 'bun:test';
import type { PipelineState, PipelineConfig } from '../../../src/types/pipeline.types.ts';
import { codeReviewerStage, createCodeReviewerConfig } from '../../../src/agents/code-reviewer/config.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshState(overrides?: Partial<PipelineState>): PipelineState {
  return {
    currentStage: 'code-reviewer',
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockConfig(): PipelineConfig {
  return {
    azureDevOps: { organization: 'org', orgUrl: 'https://dev.azure.com/org', project: 'Proj', repositoryId: 'repo-id', repositoryName: 'Repo', ciPipelineId: 1, cdPipelineId: 2, areaPath: 'Area', iterationPath: 'Iter', pat: 'pat' },
    paths: { sessionRoot: '/session', targetRepo: '/session/doc', stateDir: '/state' },
    checkpoints: { planApproval: { tag: 'plan-approved', rerunCommand: '/rerun-plan', timeoutHours: 48 }, prPublished: { fixCommand: '/fix', timeoutHours: 48 }, pollIntervalMinutes: 5 },
    revisionLoops: { maxAttempts: 3 },
    models: { default: 'sonnet' },
    costs: {},
    repoKey: 'DocumentOutput',
    layout: { appRoot: 'Cloud', source: 'Cloud/Al/Src', testAppRoot: 'Test', test: 'Test/Src' },
  } as PipelineConfig;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('codeReviewerStage', () => {
  const stage = codeReviewerStage(mockConfig());

  test('stage name is code-reviewer', () => {
    expect(stage.name).toBe('code-reviewer');
  });

  test('exposes canRun and execute', () => {
    expect(typeof stage.canRun).toBe('function');
    expect(typeof stage.execute).toBe('function');
  });

  test('canRun returns true when state.changeset exists', () => {
    const state = freshState({
      changeset: {
        branchName: 'bug/#123-fix',
        filesCreated: [],
        filesModified: ['Cloud/AL/src/File.al'],
      } as any,
    });
    expect(stage.canRun(state)).toBe(true);
  });

  test('canRun returns true even for a minimal changeset object', () => {
    // canRun only checks `changeset != null` — any object satisfies it.
    const state = freshState({ changeset: {} as any });
    expect(stage.canRun(state)).toBe(true);
  });

  test('canRun returns false when state.changeset is missing', () => {
    const state = freshState();
    expect(stage.canRun(state)).toBe(false);
  });

  test('canRun returns false when state.changeset is explicitly null', () => {
    const state = freshState({ changeset: null as any });
    expect(stage.canRun(state)).toBe(false);
  });

  test('canRun returns false when state.changeset is undefined', () => {
    const state = freshState({ changeset: undefined });
    expect(stage.canRun(state)).toBe(false);
  });

  test('canRun ignores unrelated populated state fields', () => {
    // Having devPlan / codeReviews but no changeset must still gate the stage off.
    const state = freshState({
      devPlan: { summary: 'plan' } as any,
      codeReviews: [{ verdict: 'approve' }] as any,
    });
    expect(stage.canRun(state)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Prior-findings forwarding (revision-loop convergence, §4.2)
//
// Before this, buildPrompt kept only `verdict` + `domainAnalyses` from prior
// reviews and discarded `issues`/`revisionInstructions` entirely. Round N+1's
// sub-agents therefore could not see what round N demanded, and reviewers
// contradicted each other across rounds without noticing — the loop could not
// converge. WI 63396: 8 rounds, $146, 0 merges.
// ---------------------------------------------------------------------------

function review(
  verdict: 'approve' | 'revise',
  issues: Array<{ severity: string; comment: string; filePath?: string; category?: string }>,
  revisionInstructions?: string,
  domainAnalyses?: unknown,
) {
  return {
    verdict,
    feedback: 'f',
    issues: issues.map(i => ({
      severity: i.severity,
      comment: i.comment,
      filePath: i.filePath ?? 'Cloud/Al/Src/X.al',
      category: i.category ?? 'logic-error',
    })),
    revisionInstructions,
    domainAnalyses,
  } as never;
}

function promptFor(codeReviews: unknown[]): string {
  const agent = createCodeReviewerConfig(mockConfig());
  const state = freshState({
    devPlan: { summary: 'p' } as never,
    changeset: {
      branchName: 'feature/x', filesCreated: ['A.al'], filesModified: [], ciResult: 'passed',
    } as never,
    codeReviews: codeReviews as never,
  });
  return agent.buildPrompt!(state, { workItemId: 63396, config: mockConfig() } as never);
}

describe('code-reviewer buildPrompt — prior findings', () => {
  test('forwards critical and major findings from every prior round', () => {
    const prompt = promptFor([
      review('revise', [{ severity: 'critical', comment: 'missing permission set' }], 'add the permission set'),
      review('revise', [{ severity: 'major', comment: 'wrap the call in a TryFunction' }], 'add Try wrapper'),
    ]);

    expect(prompt).toContain('missing permission set');
    expect(prompt).toContain('wrap the call in a TryFunction');
    expect(prompt).toContain('add the permission set');
    expect(prompt).toContain('"round": 1');
    expect(prompt).toContain('"round": 2');
  });

  test('drops minor and suggestion findings to keep the block small', () => {
    const prompt = promptFor([
      review('revise', [
        { severity: 'critical', comment: 'KEEP-THIS-CRITICAL' },
        { severity: 'minor', comment: 'DROP-THIS-MINOR' },
        { severity: 'suggestion', comment: 'DROP-THIS-SUGGESTION' },
      ]),
    ]);

    expect(prompt).toContain('KEEP-THIS-CRITICAL');
    expect(prompt).not.toContain('DROP-THIS-MINOR');
    expect(prompt).not.toContain('DROP-THIS-SUGGESTION');
  });

  test('carries the full history, not just the last two rounds', () => {
    // The observed oscillation spanned rounds 3–5, straddling the old slice(-2)
    // window edge — round 1 must still be visible at round 5.
    const prompt = promptFor([
      review('revise', [{ severity: 'critical', comment: 'ROUND-ONE-DEMAND' }]),
      review('revise', [{ severity: 'critical', comment: 'ROUND-TWO-DEMAND' }]),
      review('revise', [{ severity: 'critical', comment: 'ROUND-THREE-DEMAND' }]),
      review('revise', [{ severity: 'critical', comment: 'ROUND-FOUR-DEMAND' }]),
    ]);

    expect(prompt).toContain('ROUND-ONE-DEMAND');
    expect(prompt).toContain('ROUND-FOUR-DEMAND');
  });

  test('keeps the circuit-breaker window at two rounds', () => {
    // Widening that window would change what the breaker decides, so the two
    // histories are deliberately different sizes.
    const prompt = promptFor([
      review('revise', [], undefined, [{ domain: 'devils-advocate', tag: 'BREAKER-ROUND-1' }]),
      review('revise', [], undefined, [{ domain: 'devils-advocate', tag: 'BREAKER-ROUND-2' }]),
      review('revise', [], undefined, [{ domain: 'devils-advocate', tag: 'BREAKER-ROUND-3' }]),
    ]);

    const breakerBlock = prompt.slice(
      prompt.indexOf('## Prior Review History'),
      prompt.indexOf('## Prior Findings'),
    );
    expect(breakerBlock).not.toContain('BREAKER-ROUND-1');
    expect(breakerBlock).toContain('BREAKER-ROUND-2');
    expect(breakerBlock).toContain('BREAKER-ROUND-3');
  });

  test('frames prior findings as reconcilable, not settled — the anchoring guard', () => {
    const prompt = promptFor([review('revise', [{ severity: 'critical', comment: 'x' }])]);
    expect(prompt).toContain('not settled decisions');
    expect(prompt).toContain('may itself have been mistaken');
  });

  test('first iteration tells the orchestrator to pass "none" downstream', () => {
    const prompt = promptFor([]);
    expect(prompt).toContain('<PRIOR_FINDINGS>');
    expect(prompt).toContain('none — first iteration');
  });

  test('a round with only minor findings and no instructions is omitted entirely', () => {
    const prompt = promptFor([review('approve', [{ severity: 'minor', comment: 'nit' }])]);
    const block = prompt.slice(prompt.indexOf('## Prior Findings'));
    expect(block).toContain('none — first iteration');
  });
});
