import { describe, test, expect, mock, afterEach } from 'bun:test';
import { verifyCIResult } from '../../src/pipeline/ci-verification.ts';
import { buildCIVerificationHook } from '../../src/pipeline/pipeline-definition.ts';
import type { PipelineConfig, PipelineState, PipelineContext } from '../../src/types/pipeline.types.ts';

function mockConfig(): PipelineConfig {
  return {
    azureDevOps: {
      organization: 'test-org',
      orgUrl: 'https://dev.azure.com/test-org',
      project: 'Test Project',
      repositoryId: 'repo-id',
      repositoryName: 'Test Repo',
      ciPipelineId: 1,
      cdPipelineId: 2,
      areaPath: 'Test',
      iterationPath: 'Test',
      pat: 'test-pat',
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

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('verifyCIResult', () => {
  test('returns passed when no tasks have errors', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      records: [
        { name: 'Compile', type: 'Task', state: 'completed', result: 'succeeded', errorCount: 0, warningCount: 0, issues: [] },
      ],
    })))) as unknown as typeof fetch;

    const result = await verifyCIResult(123, mockConfig());

    expect(result.ciResult).toBe('passed');
    expect(result.errors).toHaveLength(0);
    expect(result.tasksFailed).toHaveLength(0);
  });

  test('returns failed with error messages when AppSourceCop has errors', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      records: [
        { name: 'Compile', type: 'Task', state: 'completed', result: 'succeeded', errorCount: 0, warningCount: 0, issues: [] },
        {
          name: 'AppSourceCop validation', type: 'Task', state: 'completed',
          result: 'succeededWithIssues', errorCount: 2, warningCount: 10, issues: [
            { type: 'warning', message: 'AL0432: deprecated' },
            { type: 'error', message: 'AS0032: cuegroup removed' },
            { type: 'error', message: 'AS0064: interface deleted' },
          ],
        },
      ],
    })))) as unknown as typeof fetch;

    const result = await verifyCIResult(456, mockConfig());

    expect(result.ciResult).toBe('failed');
    expect(result.tasksFailed).toEqual(['AppSourceCop validation']);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toBe('[AppSourceCop validation] AS0032: cuegroup removed');
    expect(result.errors[1]).toBe('[AppSourceCop validation] AS0064: interface deleted');
  });

  test('collects errors from multiple failing tasks', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      records: [
        {
          name: 'Compile', type: 'Task', state: 'completed', result: 'failed',
          errorCount: 1, warningCount: 0, issues: [
            { type: 'error', message: 'AL0001: syntax error' },
          ],
        },
        {
          name: 'AppSourceCop validation', type: 'Task', state: 'completed',
          result: 'succeededWithIssues', errorCount: 1, warningCount: 0, issues: [
            { type: 'error', message: 'AS0032: breaking change' },
          ],
        },
      ],
    })))) as unknown as typeof fetch;

    const result = await verifyCIResult(789, mockConfig());

    expect(result.ciResult).toBe('failed');
    expect(result.tasksFailed).toEqual(['Compile', 'AppSourceCop validation']);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toBe('[Compile] AL0001: syntax error');
    expect(result.errors[1]).toBe('[AppSourceCop validation] AS0032: breaking change');
  });

  test('returns passed when tasks have warnings but no errors', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      records: [
        {
          name: 'Compile', type: 'Task', state: 'completed', result: 'succeededWithIssues',
          errorCount: 0, warningCount: 15, issues: [
            { type: 'warning', message: 'AL0432: deprecated codeunit' },
            { type: 'warning', message: 'AL0432: deprecated table' },
          ],
        },
        {
          name: 'Send to Translation', type: 'Task', state: 'completed', result: 'failed',
          errorCount: 0, warningCount: 0, issues: [],
        },
      ],
    })))) as unknown as typeof fetch;

    const result = await verifyCIResult(999, mockConfig());

    expect(result.ciResult).toBe('passed');
    expect(result.errors).toHaveLength(0);
    expect(result.tasksFailed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildCIVerificationHook tests
// ---------------------------------------------------------------------------

function freshState(): PipelineState {
  return {
    currentStage: 'test',
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: new Date().toISOString(),
  };
}

function mockContext(): PipelineContext {
  return {
    workItemId: 1,
    workItem: {
      id: 1, title: 'Test', type: 'Bug', state: 'Active',
      areaPath: 'Test', iterationPath: 'Test', fields: {},
    },
    workItemType: 'Bug',
    config: mockConfig(),
  };
}

describe('buildCIVerificationHook', () => {
  test('no-op when changeset has no ciRunId', async () => {
    const hook = buildCIVerificationHook(mockConfig());
    const state: PipelineState = {
      ...freshState(),
      changeset: { branchName: 'test', branchUrl: '', filesCreated: [], filesModified: [], commitMessage: 'test', summary: 'test' } as any,
    };

    const result = await hook(state, mockContext());

    expect(result).toEqual(state);
  });

  test('appends errors to existing compilationErrors', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      records: [
        {
          name: 'AppSourceCop validation', type: 'Task', state: 'completed',
          result: 'succeededWithIssues', errorCount: 1, warningCount: 0, issues: [
            { type: 'error', message: 'AS0032: breaking change' },
          ],
        },
      ],
    })))) as unknown as typeof fetch;

    const hook = buildCIVerificationHook(mockConfig());
    const state: PipelineState = {
      ...freshState(),
      changeset: {
        branchName: 'test', branchUrl: '', filesCreated: [], filesModified: [],
        commitMessage: 'test', summary: 'test', ciRunId: 100, ciResult: 'passed',
        compilationErrors: ['existing error from agent'],
      } as any,
    };

    const result = await hook(state, mockContext());

    expect(result.changeset!.ciResult).toBe('failed');
    expect(result.changeset!.compilationErrors).toEqual([
      'existing error from agent',
      '[AppSourceCop validation] AS0032: breaking change',
    ]);
  });

  test('does not modify state when CI verification passes', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      records: [
        { name: 'Compile', type: 'Task', state: 'completed', result: 'succeeded', errorCount: 0, warningCount: 0, issues: [] },
      ],
    })))) as unknown as typeof fetch;

    const hook = buildCIVerificationHook(mockConfig());
    const state: PipelineState = {
      ...freshState(),
      changeset: {
        branchName: 'test', branchUrl: '', filesCreated: [], filesModified: [],
        commitMessage: 'test', summary: 'test', ciRunId: 200, ciResult: 'passed',
      } as any,
    };

    const result = await hook(state, mockContext());

    expect(result.changeset!.ciResult).toBe('passed');
  });
});
