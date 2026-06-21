import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { PipelineState, PipelineContext, PipelineConfig, CheckpointConfig } from '../../src/types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// We mock the azure-devops-client at the globalThis.fetch level rather than
// using mock.module (which contaminates other test files in Bun's runner).
// The checkpoint module calls the azure-devops-client which calls fetch().
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

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
    },
  };
}

function setMockFetch(body: unknown, status = 200) {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  ) as unknown as typeof fetch;
}

// Import checkpoint after helpers are defined
import { checkpoint } from '../../src/pipeline/checkpoint.ts';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkpoint', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('tag found -> satisfied, checkpoint cleared', async () => {
    // checkWorkItemTag calls fetchWorkItem which calls fetch
    setMockFetch({
      id: 42,
      fields: {
        'System.Title': 'Test',
        'System.WorkItemType': 'Bug',
        'System.State': 'Active',
        'System.Tags': 'plan-approved',
        'System.AreaPath': 'Test',
        'System.IterationPath': 'Test',
      },
    });

    const cp = checkpoint({
      name: 'plan-approved',
      detect: { type: 'tag', tag: 'plan-approved' },
    });

    const result = await cp.execute(freshState(), mockContext());

    expect(result.checkpoint).toBeUndefined();
  });

  test('tag not found -> checkpoint recorded', async () => {
    setMockFetch({
      id: 42,
      fields: {
        'System.Title': 'Test',
        'System.WorkItemType': 'Bug',
        'System.State': 'Active',
        'System.Tags': '',
        'System.AreaPath': 'Test',
        'System.IterationPath': 'Test',
      },
    });

    const cp = checkpoint({
      name: 'plan-approved',
      detect: { type: 'tag', tag: 'plan-approved' },
    });

    const result = await cp.execute(freshState(), mockContext());

    expect(result.checkpoint).toBeDefined();
    expect(result.checkpoint!.name).toBe('plan-approved');
  });

  test('PR published -> satisfied', async () => {
    setMockFetch({ pullRequestId: 100, isDraft: false });

    const cp = checkpoint({
      name: 'pr-published',
      detect: { type: 'draft-pr' },
    });

    const state = freshState({
      draftPR: { id: 100, url: 'http://test', isDraft: true, sourceBranch: 'b', targetBranch: 'master', title: 'T', description: 'D', linkedWorkItemId: 42 },
    });

    const result = await cp.execute(state, mockContext());

    expect(result.checkpoint).toBeUndefined();
  });

  test('PR still draft -> checkpoint recorded', async () => {
    setMockFetch({ pullRequestId: 100, isDraft: true });

    const cp = checkpoint({
      name: 'pr-published',
      detect: { type: 'draft-pr' },
    });

    const state = freshState({
      draftPR: { id: 100, url: 'http://test', isDraft: true, sourceBranch: 'b', targetBranch: 'master', title: 'T', description: 'D', linkedWorkItemId: 42 },
    });

    const result = await cp.execute(state, mockContext());

    expect(result.checkpoint).toBeDefined();
    expect(result.checkpoint!.name).toBe('pr-published');
  });

  test('no PR ID in state -> not satisfied', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response('{}', { status: 200 })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const cp = checkpoint({
      name: 'pr-published',
      detect: { type: 'draft-pr' },
    });

    const result = await cp.execute(freshState(), mockContext());

    expect(result.checkpoint).toBeDefined();
    // fetch should NOT have been called since there's no PR ID
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rerun command NOT checked on first entry (no checkpoint state)', async () => {
    // On first entry, state.checkpoint is undefined — rerun check should be skipped.
    // Tag check still runs (tag not found → checkpoint recorded).
    setMockFetch({
      id: 42,
      fields: {
        'System.Title': 'Test', 'System.WorkItemType': 'Bug', 'System.State': 'Active',
        'System.Tags': '', 'System.AreaPath': 'Test', 'System.IterationPath': 'Test',
      },
    });

    const cp = checkpoint({
      name: 'plan-approved',
      detect: { type: 'tag', tag: 'plan-approved' },
      rerunCommands: [
        { command: '/rerun-plan', rewindToStage: 'planning' },
      ],
    });

    // No checkpoint in state — first entry
    const result = await cp.execute(freshState(), mockContext());

    // Should NOT have revision feedback — rerun check was skipped
    expect(result.revisionFeedback).toBeUndefined();
    // Should record checkpoint (tag not found)
    expect(result.checkpoint).toBeDefined();
  });

  test('rerun command found -> revisionFeedback with correct targetStage', async () => {
    // findRerunCommandInComments calls fetch to get work item comments
    setMockFetch({
      comments: [
        { id: 1, text: '/rerun-plan please fix the naming', createdDate: new Date().toISOString() },
      ],
    });

    const cp = checkpoint({
      name: 'plan-approved',
      detect: { type: 'tag', tag: 'plan-approved' },
      rerunCommands: [
        { command: '/rerun-plan', rewindToStage: 'planning' },
      ],
    });

    const state = freshState({
      checkpoint: { name: 'plan-approved', enteredAt: '2020-01-01T00:00:00Z' },
    });

    const result = await cp.execute(state, mockContext());

    expect(result.revisionFeedback).toBeDefined();
    expect(result.revisionFeedback!.targetStage).toBe('planning');
    expect(result.revisionFeedback!.feedback).toContain('/rerun-plan');
    expect(result.checkpoint).toBeUndefined();
  });

  test('rerun command populates humanFeedback with rerun comment', async () => {
    setMockFetch({
      comments: [
        { id: 1, text: '/rerun-plan focus on error handling', createdDate: new Date().toISOString() },
      ],
    });

    const cp = checkpoint({
      name: 'plan-approved',
      detect: { type: 'tag', tag: 'plan-approved' },
      rerunCommands: [
        { command: '/rerun-plan', rewindToStage: 'planning' },
      ],
    });

    const state = freshState({
      checkpoint: { name: 'plan-approved', enteredAt: '2020-01-01T00:00:00Z' },
    });

    const result = await cp.execute(state, mockContext());

    expect(result.humanFeedback).toBeDefined();
    expect(result.humanFeedback!.rerunComment).toContain('/rerun-plan focus on error handling');
    expect(result.humanFeedback!.source).toBe('work-item-comment');
  });

  test('rerun fetches PR review comments when PR exists', async () => {
    // First call: findRerunCommandInComments (work item comments)
    // Second call: fetchPRReviewComments (PR threads)
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      if (callCount === 1) {
        // findRerunCommandInComments
        return Promise.resolve(new Response(JSON.stringify({
          comments: [
            { id: 1, text: '/fix fix the review comments', createdDate: new Date().toISOString() },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      // fetchPRReviewComments
      return Promise.resolve(new Response(JSON.stringify({
        value: [
          {
            id: 10,
            comments: [
              {
                id: 100,
                content: 'Fix this logic',
                publishedDate: '2025-01-01T12:00:00Z',
                author: { displayName: 'Alice', uniqueName: 'alice@test.com' },
                commentType: 'text',
              },
            ],
            publishedDate: '2025-01-01T12:00:00Z',
            threadContext: { filePath: '/Cloud/AL/src/Codeunit.al', rightFileStart: { line: 42, offset: 1 } },
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }) as unknown as typeof fetch;

    const cp = checkpoint({
      name: 'pr-published',
      detect: { type: 'draft-pr' },
      rerunCommands: [
        { command: '/fix', rewindToStage: 'coding', rerunMode: 'fix' },
      ],
    });

    const state = freshState({
      checkpoint: { name: 'pr-published', enteredAt: '2020-01-01T00:00:00Z' },
      draftPR: { id: 100, url: 'http://test', isDraft: true, sourceBranch: 'b', targetBranch: 'master', title: 'T', description: 'D', linkedWorkItemId: 42 },
    });

    const result = await cp.execute(state, mockContext());

    expect(result.humanFeedback).toBeDefined();
    expect(result.humanFeedback!.prReviewComments).toBeDefined();
    expect(result.humanFeedback!.prReviewComments!.length).toBe(1);
    expect(result.humanFeedback!.prReviewComments![0]!.author).toBe('Alice');
  });

  test('rerun filters PR comments by checkpoint enteredAt timestamp', async () => {
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response(JSON.stringify({
          comments: [
            { id: 1, text: '/fix', createdDate: new Date().toISOString() },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        value: [
          {
            id: 10,
            comments: [
              {
                id: 100, content: 'Old comment', publishedDate: '2019-01-01T00:00:00Z',
                author: { displayName: 'Old', uniqueName: 'old@test.com' }, commentType: 'text',
              },
            ],
            publishedDate: '2019-01-01T00:00:00Z',
          },
          {
            id: 11,
            comments: [
              {
                id: 101, content: 'New comment', publishedDate: '2025-06-01T00:00:00Z',
                author: { displayName: 'New', uniqueName: 'new@test.com' }, commentType: 'text',
              },
            ],
            publishedDate: '2025-06-01T00:00:00Z',
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }) as unknown as typeof fetch;

    const cp = checkpoint({
      name: 'pr-published',
      detect: { type: 'draft-pr' },
      rerunCommands: [
        { command: '/fix', rewindToStage: 'coding', rerunMode: 'fix' },
      ],
    });

    const state = freshState({
      checkpoint: { name: 'pr-published', enteredAt: '2020-01-01T00:00:00Z' },
      draftPR: { id: 100, url: 'http://test', isDraft: true, sourceBranch: 'b', targetBranch: 'master', title: 'T', description: 'D', linkedWorkItemId: 42 },
    });

    const result = await cp.execute(state, mockContext());

    // Only the "New comment" should pass the timestamp filter
    expect(result.humanFeedback!.prReviewComments).toBeDefined();
    expect(result.humanFeedback!.prReviewComments!.length).toBe(1);
    expect(result.humanFeedback!.prReviewComments![0]!.content).toBe('New comment');
  });

  test('rerun without PR sets humanFeedback without prReviewComments', async () => {
    setMockFetch({
      comments: [
        { id: 1, text: '/rerun-plan', createdDate: new Date().toISOString() },
      ],
    });

    const cp = checkpoint({
      name: 'plan-approved',
      detect: { type: 'tag', tag: 'plan-approved' },
      rerunCommands: [
        { command: '/rerun-plan', rewindToStage: 'planning' },
      ],
    });

    const state = freshState({
      checkpoint: { name: 'plan-approved', enteredAt: '2020-01-01T00:00:00Z' },
      // No draftPR
    });

    const result = await cp.execute(state, mockContext());

    expect(result.humanFeedback).toBeDefined();
    expect(result.humanFeedback!.prReviewComments).toBeUndefined();
  });

  test('rerun gracefully handles fetchPRReviewComments failure', async () => {
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response(JSON.stringify({
          comments: [
            { id: 1, text: '/fix', createdDate: new Date().toISOString() },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      // fetchPRReviewComments fails
      return Promise.resolve(new Response('Internal Server Error', { status: 500 }));
    }) as unknown as typeof fetch;

    const cp = checkpoint({
      name: 'pr-published',
      detect: { type: 'draft-pr' },
      rerunCommands: [
        { command: '/fix', rewindToStage: 'coding', rerunMode: 'fix' },
      ],
    });

    const state = freshState({
      checkpoint: { name: 'pr-published', enteredAt: '2020-01-01T00:00:00Z' },
      draftPR: { id: 100, url: 'http://test', isDraft: true, sourceBranch: 'b', targetBranch: 'master', title: 'T', description: 'D', linkedWorkItemId: 42 },
    });

    // Should not throw
    const result = await cp.execute(state, mockContext());

    expect(result.humanFeedback).toBeDefined();
    expect(result.humanFeedback!.rerunComment).toContain('/fix');
    // PR comments should be undefined due to failure
    expect(result.humanFeedback!.prReviewComments).toBeUndefined();
  });

  // ── Multiple rerun commands ──────────────────────────────────────────

  test('multiple rerun commands: first match wins', async () => {
    // /fix is the first command, so it should match
    setMockFetch({
      comments: [
        { id: 1, text: '/fix fix it', createdDate: new Date().toISOString() },
      ],
    });

    const cp = checkpoint({
      name: 'pr-published',
      detect: { type: 'draft-pr' },
      rerunCommands: [
        { command: '/fix', rewindToStage: 'coding', rerunMode: 'fix' },
        { command: '/rerun-plan', rewindToStage: 'planning', removeTag: 'plan-approved' },
      ],
    });

    const state = freshState({
      checkpoint: { name: 'pr-published', enteredAt: '2020-01-01T00:00:00Z' },
    });

    const result = await cp.execute(state, mockContext());

    expect(result.revisionFeedback).toBeDefined();
    expect(result.revisionFeedback!.targetStage).toBe('coding');
  });

  test('multiple rerun commands: second command matches when first does not', async () => {
    // Two fetch calls: first for /fix (no match in WI comments), second for /rerun-plan (match)
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      if (callCount === 1) {
        // /fix check: no match
        return Promise.resolve(new Response(JSON.stringify({
          comments: [],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (callCount === 2) {
        // /rerun-plan check: match
        return Promise.resolve(new Response(JSON.stringify({
          comments: [
            { id: 2, text: '/rerun-plan rethink approach', createdDate: new Date().toISOString() },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      // removeWorkItemTags: fetchWorkItem + PATCH
      if (callCount === 3) {
        return Promise.resolve(new Response(JSON.stringify({
          id: 42,
          fields: {
            'System.Title': 'Test', 'System.WorkItemType': 'Bug', 'System.State': 'Active',
            'System.Tags': 'plan-approved', 'System.AreaPath': 'Test', 'System.IterationPath': 'Test',
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      // PATCH response
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }) as unknown as typeof fetch;

    const cp = checkpoint({
      name: 'pr-published',
      detect: { type: 'draft-pr' },
      rerunCommands: [
        { command: '/fix', rewindToStage: 'coding', rerunMode: 'fix' },
        { command: '/rerun-plan', rewindToStage: 'planning', removeTag: 'plan-approved' },
      ],
    });

    const state = freshState({
      checkpoint: { name: 'pr-published', enteredAt: '2020-01-01T00:00:00Z' },
    });

    const result = await cp.execute(state, mockContext());

    expect(result.revisionFeedback).toBeDefined();
    expect(result.revisionFeedback!.targetStage).toBe('planning');
  });

  test('rerun command with removeTag calls removeWorkItemTags', async () => {
    // Sequence: findRerunCommandInComments → removeWorkItemTags (fetchWorkItem + PATCH)
    let callCount = 0;
    const fetchCalls: string[] = [];
    globalThis.fetch = mock((input: string | URL | Request) => {
      callCount++;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      fetchCalls.push(url);

      if (callCount === 1) {
        // findRerunCommandInComments
        return Promise.resolve(new Response(JSON.stringify({
          comments: [
            { id: 1, text: '/rerun-plan', createdDate: new Date().toISOString() },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (callCount === 2) {
        // removeWorkItemTags → fetchWorkItem
        return Promise.resolve(new Response(JSON.stringify({
          id: 42,
          fields: {
            'System.Title': 'Test', 'System.WorkItemType': 'Bug', 'System.State': 'Active',
            'System.Tags': 'plan-approved; other-tag', 'System.AreaPath': 'Test', 'System.IterationPath': 'Test',
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (callCount === 3) {
        // removeWorkItemTags → PATCH
        return Promise.resolve(new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }) as unknown as typeof fetch;

    const cp = checkpoint({
      name: 'plan-approved',
      detect: { type: 'tag', tag: 'plan-approved' },
      rerunCommands: [
        { command: '/rerun-plan', rewindToStage: 'planning', removeTag: 'plan-approved' },
      ],
    });

    const state = freshState({
      checkpoint: { name: 'plan-approved', enteredAt: '2020-01-01T00:00:00Z' },
    });

    const result = await cp.execute(state, mockContext());

    expect(result.revisionFeedback).toBeDefined();
    expect(result.revisionFeedback!.targetStage).toBe('planning');
    // Verify removeWorkItemTags was called (fetch call 2 = GET work item, call 3 = PATCH)
    expect(callCount).toBeGreaterThanOrEqual(3);
    expect(fetchCalls[2]).toContain('workitems/42');
  });

  test('removeTag failure is non-fatal', async () => {
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response(JSON.stringify({
          comments: [
            { id: 1, text: '/rerun-plan', createdDate: new Date().toISOString() },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      // removeWorkItemTags fails
      return Promise.resolve(new Response('Server Error', { status: 500 }));
    }) as unknown as typeof fetch;

    const cp = checkpoint({
      name: 'plan-approved',
      detect: { type: 'tag', tag: 'plan-approved' },
      rerunCommands: [
        { command: '/rerun-plan', rewindToStage: 'planning', removeTag: 'plan-approved' },
      ],
    });

    const state = freshState({
      checkpoint: { name: 'plan-approved', enteredAt: '2020-01-01T00:00:00Z' },
    });

    // Should not throw
    const result = await cp.execute(state, mockContext());

    // Rewind still happens despite tag removal failure
    expect(result.revisionFeedback).toBeDefined();
    expect(result.revisionFeedback!.targetStage).toBe('planning');
  });

  // ── Backward compatibility ───────────────────────────────────────────

  test('deprecated rerunCommand/rewindToStage still works', async () => {
    setMockFetch({
      comments: [
        { id: 1, text: '/rerun-plan fix it', createdDate: new Date().toISOString() },
      ],
    });

    const cp = checkpoint({
      name: 'plan-approved',
      detect: { type: 'tag', tag: 'plan-approved' },
      rerunCommand: '/rerun-plan',
      rewindToStage: 'planning',
    });

    const state = freshState({
      checkpoint: { name: 'plan-approved', enteredAt: '2020-01-01T00:00:00Z' },
    });

    const result = await cp.execute(state, mockContext());

    expect(result.revisionFeedback).toBeDefined();
    expect(result.revisionFeedback!.targetStage).toBe('planning');
  });

  test('rerun command with rerunMode sets state.rerunMode', async () => {
    // findRerunCommandInComments: WI comments contain /fix
    setMockFetch({
      comments: [
        { id: 1, text: '/fix overlapping object IDs', createdDate: '2026-01-02T00:00:00Z' },
      ],
    });

    const cp = checkpoint({
      name: 'test-cp',
      detect: { type: 'tag', tag: 'done' },
      rerunCommands: [
        { command: '/fix', rewindToStage: 'coding', rerunMode: 'fix' },
      ],
    });

    const state = freshState({
      checkpoint: { name: 'test-cp', enteredAt: '2026-01-01T00:00:00Z' },
    });

    const result = await cp.execute(state, mockContext());
    expect(result.rerunMode).toBe('fix');
    expect(result.revisionFeedback?.targetStage).toBe('coding');
  });

  test('rerun command without rerunMode leaves state.rerunMode undefined', async () => {
    // findRerunCommandInComments: WI comments contain /rerun-plan
    setMockFetch({
      comments: [
        { id: 1, text: '/rerun-plan rethink approach', createdDate: '2026-01-02T00:00:00Z' },
      ],
    });

    const cp = checkpoint({
      name: 'test-cp',
      detect: { type: 'tag', tag: 'done' },
      rerunCommands: [
        { command: '/rerun-plan', rewindToStage: 'planning' },
      ],
    });

    const state = freshState({
      checkpoint: { name: 'test-cp', enteredAt: '2026-01-01T00:00:00Z' },
    });

    const result = await cp.execute(state, mockContext());
    expect(result.rerunMode).toBeUndefined();
    expect(result.revisionFeedback?.targetStage).toBe('planning');
  });

  test('deprecated rerunCommand without rewindToStage defaults to checkpoint name', async () => {
    setMockFetch({
      comments: [
        { id: 1, text: '/rerun-plan', createdDate: new Date().toISOString() },
      ],
    });

    const cp = checkpoint({
      name: 'plan-approved',
      detect: { type: 'tag', tag: 'plan-approved' },
      rerunCommand: '/rerun-plan',
    });

    const state = freshState({
      checkpoint: { name: 'plan-approved', enteredAt: '2020-01-01T00:00:00Z' },
    });

    const result = await cp.execute(state, mockContext());

    expect(result.revisionFeedback).toBeDefined();
    expect(result.revisionFeedback!.targetStage).toBe('plan-approved');
  });

  test('/fix-test rerun command sets rerunMode to fix-test', async () => {
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      if (callCount === 1) {
        // checkRerunCommand — WI comments, no match
        return Promise.resolve(new Response(JSON.stringify({ comments: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (callCount === 2) {
        // checkRerunCommand — PR comments for /fix (no match)
        return Promise.resolve(new Response(JSON.stringify({ value: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (callCount === 3) {
        // checkRerunCommand — WI comments for /fix-test (no match)
        return Promise.resolve(new Response(JSON.stringify({ comments: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (callCount === 4) {
        // checkRerunCommand — PR comments for /fix-test (match!)
        return Promise.resolve(new Response(JSON.stringify({
          value: [{
            id: 1,
            comments: [{
              id: 1, content: '/fix-test', publishedDate: new Date().toISOString(),
              author: { displayName: 'Tester' }, commentType: 'text',
            }],
            publishedDate: new Date().toISOString(),
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      // fetchPRReviewComments + fetchWorkItemCommentsSince
      return Promise.resolve(new Response(JSON.stringify({ value: [] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }) as unknown as typeof fetch;

    const cp = checkpoint({
      name: 'pr-completed',
      detect: { type: 'pr-completed' },
      rerunCommands: [
        { command: '/fix', rewindToStage: 'coding', rerunMode: 'fix' },
        { command: '/fix-test', rewindToStage: 'coding', rerunMode: 'fix-test' },
      ],
    });

    const state = freshState({
      checkpoint: { name: 'pr-completed', enteredAt: '2020-01-01T00:00:00Z' },
      draftPR: { id: 100, url: 'http://test', isDraft: false, sourceBranch: 'b', targetBranch: 'master', title: 'T', description: 'D', linkedWorkItemId: 42 },
    });

    const result = await cp.execute(state, mockContext());

    expect(result.rerunMode).toBe('fix-test');
    expect(result.revisionFeedback).toBeDefined();
    expect(result.revisionFeedback!.targetStage).toBe('coding');
    expect(result.checkpoint).toBeUndefined();
  });

  test('/fix-test fetches test case failures and attaches to humanFeedback', async () => {
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;

      // Call 1: WI comments for /fix — no match
      if (callCount === 1) {
        return Promise.resolve(new Response(JSON.stringify({ comments: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      // Call 2: PR comments for /fix — no match
      if (callCount === 2) {
        return Promise.resolve(new Response(JSON.stringify({ value: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      // Call 3: WI comments for /fix-test — no match
      if (callCount === 3) {
        return Promise.resolve(new Response(JSON.stringify({ comments: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      // Call 4: PR comments for /fix-test — match!
      if (callCount === 4) {
        return Promise.resolve(new Response(JSON.stringify({
          value: [{
            id: 1,
            comments: [{
              id: 1, content: '/fix-test', publishedDate: new Date().toISOString(),
              author: { displayName: 'Tester' }, commentType: 'text',
            }],
            publishedDate: new Date().toISOString(),
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      // Call 5: fetchPRReviewComments
      if (callCount === 5) {
        return Promise.resolve(new Response(JSON.stringify({ value: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      // Call 6: fetchWorkItemCommentsSince
      if (callCount === 6) {
        return Promise.resolve(new Response(JSON.stringify({ comments: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      // Call 7: fetchTestCaseFailures → parent WI
      if (callCount === 7) {
        return Promise.resolve(new Response(JSON.stringify({
          id: 42, fields: {
            'System.Title': 'Bug', 'System.WorkItemType': 'Bug',
            'System.State': 'Active', 'System.Tags': '',
            'System.AreaPath': 'Test', 'System.IterationPath': 'Test',
          },
          relations: [{
            rel: 'Microsoft.VSTS.Common.TestedBy-Forward',
            url: 'https://dev.azure.com/test/proj/_apis/wit/workItems/300',
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      // Call 8: test case WI
      if (callCount === 8) {
        return Promise.resolve(new Response(JSON.stringify({
          id: 300, fields: {
            'System.Title': 'TC: Verify output', 'System.WorkItemType': 'Test Case',
            'System.State': 'Ready', 'System.Tags': '',
            'System.AreaPath': 'Test', 'System.IterationPath': 'Test',
            'Microsoft.VSTS.TCM.Steps': '<steps><step id="1" type="ValidateStep"><parameterizedString>Check result</parameterizedString><parameterizedString>Correct</parameterizedString></step></steps>',
          },
          relations: [],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      // Call 9: queryLatestTestResult
      if (callCount === 9) {
        return Promise.resolve(new Response(JSON.stringify({
          resultsForGroup: [{ results: [{ id: 500, outcome: 'Failed', testRun: { id: '1000' } }] }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      // Call 10: fetchTestIterations
      if (callCount === 10) {
        return Promise.resolve(new Response(JSON.stringify({
          value: [{ id: 1, actionResults: [
            { stepIdentifier: '1', outcome: 'Failed', errorMessage: 'Wrong value' },
          ] }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }) as unknown as typeof fetch;

    const cp = checkpoint({
      name: 'pr-completed',
      detect: { type: 'pr-completed' },
      rerunCommands: [
        { command: '/fix', rewindToStage: 'coding', rerunMode: 'fix' },
        { command: '/fix-test', rewindToStage: 'coding', rerunMode: 'fix-test' },
      ],
    });

    const state = freshState({
      checkpoint: { name: 'pr-completed', enteredAt: '2020-01-01T00:00:00Z' },
      draftPR: { id: 100, url: 'http://test', isDraft: false, sourceBranch: 'b', targetBranch: 'master', title: 'T', description: 'D', linkedWorkItemId: 42 },
    });

    const result = await cp.execute(state, mockContext());

    expect(result.rerunMode).toBe('fix-test');
    expect(result.humanFeedback).toBeDefined();
    expect(result.humanFeedback!.testCaseFailures).toBeDefined();
    expect(result.humanFeedback!.testCaseFailures!).toHaveLength(1);
    expect(result.humanFeedback!.testCaseFailures![0]!.testCaseId).toBe(300);
    expect(result.humanFeedback!.testCaseFailures![0]!.failedSteps[0]!.comment).toBe('Wrong value');
  });

  // ── PR completed checkpoint ─────────────────────────────────────────

  test('PR completed -> satisfied', async () => {
    setMockFetch({ pullRequestId: 100, status: 'completed', isDraft: false });

    const cp = checkpoint({
      name: 'pr-completed',
      detect: { type: 'pr-completed' },
    });

    const state = freshState({
      draftPR: { id: 100, url: 'http://test', isDraft: false, sourceBranch: 'b', targetBranch: 'master', title: 'T', description: 'D', linkedWorkItemId: 42 },
    });

    const result = await cp.execute(state, mockContext());

    expect(result.checkpoint).toBeUndefined();
  });

  test('PR still active -> pr-completed checkpoint recorded', async () => {
    setMockFetch({ pullRequestId: 100, status: 'active', isDraft: false });

    const cp = checkpoint({
      name: 'pr-completed',
      detect: { type: 'pr-completed' },
    });

    const state = freshState({
      draftPR: { id: 100, url: 'http://test', isDraft: false, sourceBranch: 'b', targetBranch: 'master', title: 'T', description: 'D', linkedWorkItemId: 42 },
    });

    const result = await cp.execute(state, mockContext());

    expect(result.checkpoint).toBeDefined();
    expect(result.checkpoint!.name).toBe('pr-completed');
  });

  test('no PR ID in state -> pr-completed not satisfied', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response('{}', { status: 200 })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const cp = checkpoint({
      name: 'pr-completed',
      detect: { type: 'pr-completed' },
    });

    const result = await cp.execute(freshState(), mockContext());

    expect(result.checkpoint).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
