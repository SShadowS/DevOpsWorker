import { describe, test, expect } from 'bun:test';
import type { PipelineState } from '../../../src/types/pipeline.types.ts';
import { buildCodeRevisionSection, buildFixPrompt, buildFixTestPrompt, createCoderConfig, ciWaiterGuard, fileOpGuard } from '../../../src/agents/coder/config.ts';
import { buildHumanFeedbackSection } from '../../../src/pipeline/human-feedback.ts';
import type { CodeReview } from '../../../src/agents/code-reviewer/schema.ts';
import type { PipelineConfig, PipelineContext } from '../../../src/types/pipeline.types.ts';

function mockPipelineConfig(): PipelineConfig {
  return {
    azureDevOps: {
      organization: 'test', orgUrl: 'https://test', project: 'Test',
      repositoryId: 'r', repositoryName: 'R', ciPipelineId: 973, cdPipelineId: 2,
      areaPath: 'T', iterationPath: 'T', pat: 'p',
    },
    paths: { sessionRoot: '/tmp', targetRepo: '/tmp/doc', stateDir: '/tmp/state' },
    checkpoints: {
      planApproval: { tag: 't', rerunCommand: '/r', timeoutHours: 1 },
      prPublished: { fixCommand: '/f', timeoutHours: 1 },
      pollIntervalMinutes: 1,
    },
    revisionLoops: { maxAttempts: 5 },
    models: { default: 'claude-sonnet-4-6' },
    costs: {},
    repoKey: 'DocumentOutput',
    layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
  } as unknown as PipelineConfig;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshState(overrides?: Partial<PipelineState>): PipelineState {
  return {
    currentStage: 'coder',
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCodeReview(overrides?: Partial<CodeReview>): CodeReview {
  return {
    verdict: 'revise',
    feedback: 'Needs changes',
    issues: [],
    strengths: [],
    implementsPlannedChanges: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildCodeRevisionSection', () => {
  test('returns empty when no reviews exist', () => {
    const state = freshState();
    expect(buildCodeRevisionSection(state)).toEqual([]);
  });

  test('returns empty when last review approved', () => {
    const state = freshState({
      codeReviews: [makeCodeReview({ verdict: 'approve' })] as any,
    });
    expect(buildCodeRevisionSection(state)).toEqual([]);
  });

  test('includes suggestion and file location for each issue', () => {
    const state = freshState({
      codeReviews: [
        makeCodeReview({
          issues: [
            {
              filePath: 'Cloud/AL/src/Codeunit.Merge.al',
              line: 129,
              severity: 'critical',
              category: 'logic-error',
              comment: 'Infinite recursion when all files exceed threshold',
              suggestion: 'Add base case: if batch size equals input size, return error',
            },
          ],
        }),
      ] as any,
    });
    const result = buildCodeRevisionSection(state).join('\n');

    expect(result).toContain('[critical] Cloud/AL/src/Codeunit.Merge.al:129: Infinite recursion');
    expect(result).toContain('→ Fix: Add base case: if batch size equals input size, return error');
  });

  test('uses filePath without line when line is absent', () => {
    const state = freshState({
      codeReviews: [
        makeCodeReview({
          issues: [
            {
              filePath: 'Cloud/AL/src/Table.Settings.al',
              severity: 'major',
              category: 'missing-implementation',
              comment: 'Missing permission set update',
            },
          ],
        }),
      ] as any,
    });
    const result = buildCodeRevisionSection(state).join('\n');

    expect(result).toContain('[major] Cloud/AL/src/Table.Settings.al: Missing permission set');
    expect(result).not.toContain(':undefined');
  });

  test('includes revisionInstructions from latest review', () => {
    const state = freshState({
      codeReviews: [
        makeCodeReview({
          revisionInstructions: 'Fix the infinite recursion first, then address test coverage.',
        }),
      ] as any,
    });
    const result = buildCodeRevisionSection(state).join('\n');

    expect(result).toContain('**Revision Instructions:**');
    expect(result).toContain('Fix the infinite recursion first');
  });

  test('shows all reviews with older ones compact and latest detailed', () => {
    const review1 = makeCodeReview({
      feedback: 'Missing translations',
      issues: [
        { filePath: 'Cloud/AL/src/Page.al', severity: 'major', category: 'missing-implementation', comment: 'Missing .xlf translations' },
      ],
    });
    const review2 = makeCodeReview({
      feedback: 'HTTPS validation missing',
      issues: [
        { filePath: 'Cloud/AL/src/Codeunit.Validate.al', severity: 'major', category: 'security', comment: 'No HTTPS scheme validation' },
      ],
      revisionInstructions: 'Add URL scheme validation.',
    });

    const state = freshState({
      codeReviews: [review1, review2] as any,
    });
    const result = buildCodeRevisionSection(state).join('\n');

    // Older review compact
    expect(result).toContain('### Review History');
    expect(result).toContain('**Review 1 issues (now resolved — do not regress):**');
    expect(result).toContain('Missing .xlf translations');

    // Latest review detailed
    expect(result).toContain('### Latest Review (Review 2)');
    expect(result).toContain('**Feedback:** HTTPS validation missing');
    expect(result).toContain('No HTTPS scheme validation');
    expect(result).toContain('Add URL scheme validation.');

    // Attempt count
    expect(result).toContain('attempt 3');
  });

  test('flags recurring issues by filePath + category', () => {
    const review1 = makeCodeReview({
      issues: [
        { filePath: 'Cloud/AL/src/Codeunit.Merge.al', severity: 'critical', category: 'logic-error', comment: 'Infinite recursion in batch merge' },
      ],
    });
    const review2 = makeCodeReview({
      issues: [
        { filePath: 'Cloud/AL/src/Codeunit.Merge.al', severity: 'critical', category: 'logic-error', comment: 'Infinite recursion still present' },
        { filePath: 'Test/AL/src/Test.Merge.al', severity: 'minor', category: 'best-practice', comment: 'Missing test assertion' },
      ],
    });

    const state = freshState({
      codeReviews: [review1, review2] as any,
    });
    const result = buildCodeRevisionSection(state).join('\n');

    expect(result).toContain('**⚠️ RECURRING ISSUES (fix these permanently):**');
    expect(result).toContain('(reviews 1, 2)');
    expect(result).toContain('Infinite recursion still present');

    // Non-recurring issue should not be in recurring section
    const recurringSection = result.split('RECURRING ISSUES')[1]!;
    expect(recurringSection).not.toContain('Missing test assertion');
  });

  test('no recurring section when no issues recur', () => {
    const review1 = makeCodeReview({
      issues: [
        { filePath: 'file1.al', severity: 'major', category: 'logic-error', comment: 'Issue A' },
      ],
    });
    const review2 = makeCodeReview({
      issues: [
        { filePath: 'file2.al', severity: 'major', category: 'security', comment: 'Issue B' },
      ],
    });

    const state = freshState({
      codeReviews: [review1, review2] as any,
    });
    const result = buildCodeRevisionSection(state).join('\n');

    expect(result).not.toContain('RECURRING ISSUES');
  });

  test('ends with instruction not to regress', () => {
    const state = freshState({
      codeReviews: [makeCodeReview()] as any,
    });
    const result = buildCodeRevisionSection(state).join('\n');

    expect(result).toContain('Do NOT re-introduce problems from earlier reviews');
  });
});

describe('ci-waiter subagent registration', () => {
  const cfg = createCoderConfig(mockPipelineConfig());

  test('coder has the Task tool (required to spawn subagents)', () => {
    expect(cfg.allowedTools).toContain('Task');
  });

  test('registers a ci-waiter subagent', () => {
    expect(cfg.agents).toBeDefined();
    expect(cfg.agents!['ci-waiter']).toBeDefined();
  });

  test('ci-waiter runs on a Haiku model (cheap poller)', () => {
    expect(cfg.agents!['ci-waiter']!.model).toMatch(/haiku/i);
  });

  test('ci-waiter is restricted to Bash only (no code/LSP/MCP tools)', () => {
    expect(cfg.agents!['ci-waiter']!.tools).toEqual(['Bash']);
  });

  test('ci-waiter prompt defines the PASSED/FAILED result contract and forbids --branch', () => {
    const prompt = cfg.agents!['ci-waiter']!.prompt;
    expect(prompt).toContain('RESULT: PASSED');
    expect(prompt).toContain('RESULT: FAILED');
    expect(prompt).toContain('--attach');
    expect(prompt).toMatch(/--branch/);
  });

  test('coder CI instructions delegate the wait via --trigger-only + Task', () => {
    const state = freshState({ devPlan: { summary: 'x' } as any });
    const ctx = { workItemId: 42, workItemType: 'Bug', config: mockPipelineConfig() } as unknown as PipelineContext;
    const prompt = cfg.buildPrompt(state, ctx);
    expect(prompt).toContain('--trigger-only');
    expect(prompt).toContain('ci-waiter');
  });

  test('registers a PreToolUse guard hook on Bash', () => {
    expect(cfg.hooks?.PreToolUse?.[0]?.matcher).toBe('Bash');
    expect(cfg.hooks!.PreToolUse![0]!.hooks.length).toBeGreaterThan(0);
  });
});

describe('ciWaiterGuard (inline CI-poll guard)', () => {
  test('denies inline --attach without the --waiter sentinel', () => {
    const v = ciWaiterGuard('bun scripts/await-pipeline.ts --attach 691974 --timeout 100');
    expect(v.deny).toBe(true);
    if (v.deny) expect(v.reason).toContain('ci-waiter');
  });

  test('allows --attach that carries the --waiter sentinel (the subagent)', () => {
    expect(ciWaiterGuard('bun /app/scripts/await-pipeline.ts --attach 691974 --timeout 100 --waiter').deny).toBe(false);
  });

  test('denies --branch without --trigger-only (inline trigger-and-wait)', () => {
    const v = ciWaiterGuard("bun scripts/await-pipeline.ts --branch 'bug/#1-x'");
    expect(v.deny).toBe(true);
  });

  test('allows --branch --trigger-only (the sanctioned trigger)', () => {
    expect(ciWaiterGuard("bun scripts/await-pipeline.ts --branch 'bug/#1-x' --trigger-only").deny).toBe(false);
  });

  test('ignores unrelated Bash commands', () => {
    expect(ciWaiterGuard('git commit -m x').deny).toBe(false);
    expect(ciWaiterGuard('bun scripts/parse-mcp.ts file errors').deny).toBe(false);
  });
});

describe('fileOpGuard (bash file-op redirect guard)', () => {
  // --- primary command denies (bash reading/searching the repo) ---
  test('denies primary `ls`', () => {
    const v = fileOpGuard('ls Cloud/AL');
    expect(v.deny).toBe(true);
    if (v.deny) expect(v.reason).toContain('Glob');
  });

  test('denies bare `ls` with no trailing space', () => {
    expect(fileOpGuard('ls').deny).toBe(true);
  });

  test('denies primary `cat`/`head`/`tail` → Read', () => {
    for (const u of ['cat app.json', 'head -5 file.al', 'tail -n 20 log.txt']) {
      const v = fileOpGuard(u);
      expect(v.deny).toBe(true);
      if (v.deny) expect(v.reason).toContain('Read');
    }
  });

  test('denies primary `grep`/`rg`/`egrep` → Grep', () => {
    for (const u of ['grep -r foo Cloud', 'rg pattern src', 'egrep x file']) {
      const v = fileOpGuard(u);
      expect(v.deny).toBe(true);
      if (v.deny) expect(v.reason).toContain('Grep');
    }
  });

  test('denies `grep` with input redirect (still reading a file)', () => {
    expect(fileOpGuard('grep needle < data.txt').deny).toBe(true);
  });

  // --- find: search denied, action allowed ---
  test('denies `find -name` search → Glob', () => {
    const v = fileOpGuard("find . -name '*.al'");
    expect(v.deny).toBe(true);
    if (v.deny) expect(v.reason).toContain('Glob');
  });

  test('allows `find -exec`/`-delete` (action, not search)', () => {
    expect(fileOpGuard("find . -name '*.tmp' -delete").deny).toBe(false);
    expect(fileOpGuard("find . -name '*.al' -exec wc -l {} ;").deny).toBe(false);
  });

  // --- inline python json ---
  test('denies inline python reading JSON → jq', () => {
    const v = fileOpGuard('python3 -c "import json,sys;print(json.load(open(\'app.json\')))"');
    expect(v.deny).toBe(true);
    if (v.deny) expect(v.reason).toContain('jq');
  });

  test('allows python without -c / without json', () => {
    expect(fileOpGuard('python3 scripts/build.py').deny).toBe(false);
  });

  // --- git diff helper ---
  test('denies `git diff master...` → branch-diff helper', () => {
    const v = fileOpGuard('git diff master...userstory/#73961-x');
    expect(v.deny).toBe(true);
    if (v.deny) expect(v.reason).toContain('branch-diff');
  });

  test('allows ordinary `git diff` (no triple-dot ref)', () => {
    expect(fileOpGuard('git diff --stat').deny).toBe(false);
  });

  // --- PRIMARY-vs-PIPE: filters after `|` are allowed ---
  test('allows read-utils AFTER a pipe (filtering command output)', () => {
    expect(fileOpGuard('git log --oneline | head -20').deny).toBe(false);
    expect(fileOpGuard('az pipelines list | grep CI').deny).toBe(false);
    expect(fileOpGuard('git status | cat').deny).toBe(false);
  });

  // --- chain handling: cd && cat, env prefixes ---
  test('denies `cat` even when preceded by `cd &&`, and warns about lost cd', () => {
    const v = fileOpGuard('cd DocumentOutput/Cloud && cat app.json');
    expect(v.deny).toBe(true);
    if (v.deny) {
      expect(v.reason).toContain('Read');
      expect(v.reason).toContain('cd');
    }
  });

  test('denies `grep` behind an env-var prefix', () => {
    expect(fileOpGuard('LC_ALL=C grep -r foo src').deny).toBe(true);
  });

  test('denies a file-op in any segment of a `;` chain', () => {
    expect(fileOpGuard('git fetch ; cat README.md').deny).toBe(true);
  });

  // --- xargs pass-through ---
  test('denies `xargs cat` / `xargs grep`', () => {
    expect(fileOpGuard('git ls-files | xargs grep TODO').deny).toBe(true);
    expect(fileOpGuard('cat list | xargs cat').deny).toBe(true);
  });

  test('allows `xargs rm` (not a read-util)', () => {
    expect(fileOpGuard('echo x | xargs rm').deny).toBe(false);
  });

  // --- quote-awareness: operators inside strings must NOT split ---
  test('does not split on quoted operators', () => {
    expect(fileOpGuard('git commit -m "fix; cat and grep stuff"').deny).toBe(false);
    expect(fileOpGuard('git commit -m "a && b"').deny).toBe(false);
  });

  test('allows util name appearing only inside an echo string', () => {
    expect(fileOpGuard('echo "use cat or grep here"').deny).toBe(false);
  });

  // --- never touches ci-poll commands (ciWaiterGuard owns them) ---
  test('ignores await-pipeline commands entirely', () => {
    expect(fileOpGuard('bun scripts/await-pipeline.ts --attach 1 --waiter').deny).toBe(false);
  });

  // --- unrelated commands pass ---
  test('allows unrelated bash (git/bun/az/jq)', () => {
    for (const c of ['git commit -m x', 'bun scripts/parse-mcp.ts f errors', 'jq -r .application app.json', 'az pipelines run --id 973']) {
      expect(fileOpGuard(c).deny).toBe(false);
    }
  });
});

describe('buildHumanFeedbackSection (coder integration)', () => {
  test('returns human feedback with PR comments when present', () => {
    const state = freshState({
      humanFeedback: {
        rerunComment: '/fix fix review comments',
        source: 'pr-comment',
        prReviewComments: [
          {
            threadId: 1, commentId: 1,
            author: 'Alice',
            content: 'Fix this logic',
            publishedDate: '2025-01-01T00:00:00Z',
            filePath: '/Cloud/AL/src/Codeunit.al',
            line: 42,
          },
        ],
      },
    });
    const result = buildHumanFeedbackSection(state, 'coding').join('\n');

    expect(result).toContain('## Human Feedback');
    expect(result).toContain('/fix fix review comments');
    expect(result).toContain('Alice (line 42): Fix this logic');
  });

  test('returns empty when no humanFeedback', () => {
    const state = freshState();
    expect(buildHumanFeedbackSection(state, 'coding')).toEqual([]);
  });

  test('coding mode renders raw comments even when commentSummary exists', () => {
    const state = freshState({
      humanFeedback: {
        rerunComment: '/fix',
        source: 'pr-comment',
        prReviewComments: [
          {
            threadId: 1, commentId: 1,
            author: 'Alice', content: 'Fix this logic',
            publishedDate: '2025-01-01T00:00:00Z',
            filePath: '/Cloud/AL/src/Codeunit.al', line: 42,
          },
        ],
        commentSummary: 'Some summary that should be ignored in coding mode.',
      },
    });
    const result = buildHumanFeedbackSection(state, 'coding').join('\n');

    // Should render raw comments, not the summary
    expect(result).toContain('### PR Review Comments');
    expect(result).toContain('Alice (line 42): Fix this logic');
    expect(result).not.toContain('### PR Review Summary');
    expect(result).not.toContain('Some summary that should be ignored');
  });
});

describe('buildFixPrompt', () => {
  test('returns fix-mode prompt referencing existing branch', () => {
    const state = freshState({
      rerunMode: 'fix',
      changeset: {
        branchName: 'bug/#123-fix-thing',
        filesCreated: ['Test/file.al'],
        filesModified: ['Cloud/file.al'],
        ciRunId: 100,
        ciResult: 'succeeded',
      } as any,
      humanFeedback: {
        rerunComment: 'overlapping object IDs - 68952 conflicts with existing',
        source: 'pr-comment' as const,
      },
    });

    const result = buildFixPrompt(state, 123);
    expect(result).toContain('bug/#123-fix-thing');
    expect(result).toContain('overlapping object IDs');
    expect(result).toContain('MINIMAL');
    expect(result).not.toContain('Implement ALL changes');
    expect(result).not.toContain('Create the feature branch');
  });

  test('includes code review history when present with revise verdict', () => {
    const state = freshState({
      rerunMode: 'fix',
      changeset: { branchName: 'bug/#1-x', filesCreated: [], filesModified: [] } as any,
      humanFeedback: { rerunComment: 'fix it', source: 'pr-comment' as const },
      codeReviews: [
        makeCodeReview({ verdict: 'revise', feedback: 'needs work', issues: [
          { severity: 'major', filePath: 'Cloud/f.al', comment: 'wrong ID', category: 'logic-error' },
        ] }),
      ] as any,
    });

    const result = buildFixPrompt(state, 1);
    expect(result).toContain('Code Review Feedback');
    expect(result).toContain('wrong ID');
  });

  test('omits code review section when last review was approve', () => {
    const state = freshState({
      rerunMode: 'fix',
      changeset: { branchName: 'bug/#1-x', filesCreated: [], filesModified: [] } as any,
      humanFeedback: { rerunComment: 'fix it', source: 'pr-comment' as const },
      codeReviews: [
        makeCodeReview({ verdict: 'approve', feedback: 'looks good' }),
      ] as any,
    });

    const result = buildFixPrompt(state, 1);
    expect(result).not.toContain('Code Review Feedback');
  });
});

describe('buildFixTestPrompt', () => {
  test('formats test case failures with WI IDs and step details', () => {
    const state = freshState({
      rerunMode: 'fix-test' as PipelineState['rerunMode'],
      changeset: {
        branchName: 'bug/#66858-merge-fields',
        filesCreated: [],
        filesModified: ['Cloud/AL/src/Codeunit.MergeField.al'],
        ciRunId: 100,
        ciResult: 'succeeded',
      } as any,
      humanFeedback: {
        rerunComment: '/fix-test',
        source: 'pr-comment' as const,
        testCaseFailures: [
          {
            testCaseId: 75863,
            title: 'TC: Merge fields %4 and %7 consistent',
            outcome: 'Failed',
            failedSteps: [
              {
                stepNumber: 4,
                action: 'Inspect the generated PDF filename',
                expectedResult: 'Filename contains resolved values for %4 and %7',
                comment: 'The count for "Next Statement" is 1 too low.',
              },
            ],
          },
        ],
      },
    });

    const result = buildFixTestPrompt(state, 66858);

    expect(result).toContain('bug/#66858-merge-fields');
    expect(result).toContain('WI #75863 (Test Case)');
    expect(result).toContain('Merge fields %4 and %7 consistent');
    expect(result).toContain('Step 4 FAILED');
    expect(result).toContain('Inspect the generated PDF filename');
    expect(result).toContain('Filename contains resolved values');
    expect(result).toContain('The count for "Next Statement" is 1 too low.');
    expect(result).toContain('MINIMAL');
  });

  test('aggregates multiple test cases', () => {
    const state = freshState({
      rerunMode: 'fix-test' as PipelineState['rerunMode'],
      changeset: { branchName: 'bug/#1-x', filesCreated: [], filesModified: [] } as any,
      humanFeedback: {
        rerunComment: '/fix-test',
        source: 'pr-comment' as const,
        testCaseFailures: [
          {
            testCaseId: 100, title: 'TC: First', outcome: 'Failed',
            failedSteps: [{ stepNumber: 1, action: 'Step A', expectedResult: 'Result A', comment: 'Wrong' }],
          },
          {
            testCaseId: 200, title: 'TC: Second', outcome: 'Failed',
            failedSteps: [{ stepNumber: 2, action: 'Step B', expectedResult: 'Result B', comment: null }],
          },
        ],
      },
    });

    const result = buildFixTestPrompt(state, 1);

    expect(result).toContain('WI #100 (Test Case)');
    expect(result).toContain('WI #200 (Test Case)');
    expect(result).toContain('Step A');
    expect(result).toContain('Step B');
  });

  test('includes Test Case Failures to Fix heading', () => {
    const state = freshState({
      rerunMode: 'fix-test' as PipelineState['rerunMode'],
      changeset: { branchName: 'bug/#1-x', filesCreated: [], filesModified: [] } as any,
      humanFeedback: {
        rerunComment: '/fix-test',
        source: 'pr-comment' as const,
        testCaseFailures: [{
          testCaseId: 100, title: 'TC: Test', outcome: 'Failed',
          failedSteps: [{ stepNumber: 1, action: 'Do thing', expectedResult: 'Thing done', comment: 'Nope' }],
        }],
      },
    });

    const result = buildFixTestPrompt(state, 1);
    expect(result).toContain('Test Case Failures to Fix');
  });
});
