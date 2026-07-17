import { describe, test, expect, mock, afterEach } from 'bun:test';
import type { PipelineState, PipelineContext } from '../../src/types/pipeline.types.ts';

function freshState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    currentStage: 'test',
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockContext(): PipelineContext {
  return {
    workItemId: 42,
    workItem: {
      id: 42, title: 'Test', type: 'Bug', state: 'Active',
      areaPath: 'Test', iterationPath: 'Test', fields: {},
    },
    workItemType: 'Bug',
    config: {
      azureDevOps: {
        organization: 'test', orgUrl: 'https://test', project: 'Test',
        repositoryId: 'r', repositoryName: 'R', ciPipelineId: 1, cdPipelineId: 2,
        areaPath: 'T', iterationPath: 'T', pat: 'p',
      },
      paths: { sessionRoot: '/tmp/session', targetRepo: '/tmp/session/doc', stateDir: '/tmp/state' },
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
    },
  };
}

import { testCaseActivation } from '../../src/pipeline/test-case-activation.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('testCaseActivation', () => {
  test('canRun returns true when testCases exist', () => {
    const stage = testCaseActivation();
    const state = freshState({
      testCases: {
        testCases: [{ id: 100, title: 'T', stepCount: 2, derivedFrom: 'S1' }],
        summary: 'ok',
      },
    });
    expect(stage.canRun(state)).toBe(true);
  });

  test('canRun returns false when no testCases', () => {
    const stage = testCaseActivation();
    expect(stage.canRun(freshState())).toBe(false);
  });

  test('calls updateWorkItemFields for each test case with state=Ready', async () => {
    const patchCalls: { url: string; body: string }[] = [];
    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      patchCalls.push({ url: url.toString(), body: init?.body as string });
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    const stage = testCaseActivation();
    const state = freshState({
      testCases: {
        testCases: [
          { id: 100, title: 'Test A', stepCount: 3, derivedFrom: 'S1' },
          { id: 101, title: 'Test B', stepCount: 2, derivedFrom: 'S2' },
        ],
        summary: 'Two test cases',
      },
    });

    const { state: result } = await stage.execute(state, mockContext());

    // Should have called PATCH for each test case
    expect(patchCalls).toHaveLength(2);

    // Verify each call targets the correct work item ID and sets System.State to Ready
    expect(patchCalls[0]!.url).toContain('/wit/workitems/100');
    expect(patchCalls[1]!.url).toContain('/wit/workitems/101');
    for (const call of patchCalls) {
      const body = JSON.parse(call.body);
      expect(body).toEqual([
        { op: 'replace', path: '/fields/System.State', value: 'Ready' },
      ]);
    }

    // State should be unchanged (pass-through stage)
    expect(result.testCases).toEqual(state.testCases);
  });

  test('stage name is test-case-activation', () => {
    expect(testCaseActivation().name).toBe('test-case-activation');
  });

  test('posts PR comment advertising /fix-test after activating test cases', async () => {
    const fetchCalls: { url: string; method: string; body?: string }[] = [];
    globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      fetchCalls.push({ url, method: init?.method ?? 'GET', body: init?.body as string });
      return Promise.resolve(new Response(JSON.stringify({}), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }) as unknown as typeof fetch;

    const stage = testCaseActivation();
    const state = freshState({
      testCases: {
        testCases: [
          { id: 100, title: 'TC: First', stepCount: 3, derivedFrom: 'AC1' },
          { id: 101, title: 'TC: Second', stepCount: 2, derivedFrom: 'AC2' },
        ],
        summary: 'Two test cases',
      },
      draftPR: { id: 50, url: 'http://test', isDraft: false, sourceBranch: 'b', targetBranch: 'master', title: 'T', description: 'D', linkedWorkItemId: 42 },
    });

    await stage.execute(state, mockContext());

    // 2 PATCH calls (state updates) + 1 POST call (PR comment)
    const postCalls = fetchCalls.filter(c => c.method === 'POST');
    expect(postCalls.length).toBe(1);
    expect(postCalls[0]!.url).toContain('pullrequests/50/threads');
    expect(postCalls[0]!.body).toContain('/fix-test');
    expect(postCalls[0]!.body).toContain('2 test case');
  });

  test('skips PR comment when no draftPR in state', async () => {
    const fetchCalls: { url: string; method: string }[] = [];
    globalThis.fetch = mock((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      fetchCalls.push({ url, method: init?.method ?? 'GET' });
      return Promise.resolve(new Response(JSON.stringify({}), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    }) as unknown as typeof fetch;

    const stage = testCaseActivation();
    const state = freshState({
      testCases: {
        testCases: [
          { id: 100, title: 'TC: First', stepCount: 3, derivedFrom: 'AC1' },
        ],
        summary: 'One test case',
      },
      // No draftPR
    });

    await stage.execute(state, mockContext());

    const postCalls = fetchCalls.filter(c => c.method === 'POST');
    expect(postCalls.length).toBe(0);
  });

  test('sets testCaseActivation timestamp in state', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({}), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })),
    ) as unknown as typeof fetch;

    const stage = testCaseActivation();
    const state = freshState({
      testCases: {
        testCases: [{ id: 100, title: 'TC: Test', stepCount: 1, derivedFrom: 'AC1' }],
        summary: 'One test case',
      },
    });

    const { state: result } = await stage.execute(state, mockContext());

    expect(result.testCaseActivation).toBeDefined();
    expect(result.testCaseActivation!.activatedAt).toBeTruthy();
  });
});
