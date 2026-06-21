import { describe, test, expect, mock, afterEach } from 'bun:test';
import { getBuildTimeline } from '../../src/sdk/azure-devops-client.ts';
import type { PipelineConfig } from '../../src/types/pipeline.types.ts';

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

describe('getBuildTimeline', () => {
  test('returns tasks with errorCount > 0, extracting error issues', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      records: [
        {
          name: 'Compile', type: 'Task', state: 'completed', result: 'succeeded',
          errorCount: 0, warningCount: 2, issues: [
            { type: 'warning', message: 'some warning' },
          ],
        },
        {
          name: 'AppSourceCop validation', type: 'Task', state: 'completed',
          result: 'succeededWithIssues', errorCount: 2, warningCount: 5, issues: [
            { type: 'warning', message: 'AL0432: deprecated' },
            { type: 'error', message: 'AS0032: breaking change on Page' },
            { type: 'error', message: 'AS0064: interface deleted' },
          ],
        },
        {
          name: 'Build Stage', type: 'Stage', state: 'completed',
          result: 'succeededWithIssues', errorCount: 2, warningCount: 7, issues: [],
        },
      ],
    })))) as unknown as typeof fetch;

    const result = await getBuildTimeline(12345, mockConfig());

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('AppSourceCop validation');
    expect(result[0]!.errorCount).toBe(2);
    expect(result[0]!.issues).toHaveLength(2);
    expect(result[0]!.issues[0]!.type).toBe('error');
    expect(result[0]!.issues[0]!.message).toBe('AS0032: breaking change on Page');
    expect(result[0]!.issues[1]!.message).toBe('AS0064: interface deleted');
  });

  test('returns empty array when no tasks have errors', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      records: [
        { name: 'Compile', type: 'Task', state: 'completed', result: 'succeeded', errorCount: 0, warningCount: 0, issues: [] },
        { name: 'Test', type: 'Task', state: 'completed', result: 'succeeded', errorCount: 0, warningCount: 1, issues: [] },
      ],
    })))) as unknown as typeof fetch;

    const result = await getBuildTimeline(12345, mockConfig());
    expect(result).toHaveLength(0);
  });

  test('filters to Task type only, ignoring Job and Stage records', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      records: [
        { name: 'Build Job', type: 'Job', state: 'completed', result: 'failed', errorCount: 3, warningCount: 0, issues: [{ type: 'error', message: 'job error' }] },
        { name: 'Build Stage', type: 'Stage', state: 'completed', result: 'failed', errorCount: 3, warningCount: 0, issues: [{ type: 'error', message: 'stage error' }] },
        { name: 'Failing Task', type: 'Task', state: 'completed', result: 'failed', errorCount: 1, warningCount: 0, issues: [{ type: 'error', message: 'task error' }] },
      ],
    })))) as unknown as typeof fetch;

    const result = await getBuildTimeline(12345, mockConfig());
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Failing Task');
  });

  test('calls correct API URL with build ID', async () => {
    const mockFn = mock(() => Promise.resolve(new Response(JSON.stringify({ records: [] }))));
    globalThis.fetch = mockFn as unknown as typeof fetch;

    await getBuildTimeline(636783, mockConfig());

    const url = (mockFn.mock.calls[0] as unknown[])[0] as string;
    expect(url).toContain('/build/builds/636783/timeline');
    expect(url).toContain('api-version=7.1');
  });
});
