import { describe, test, expect } from 'bun:test';
import { assertRealAdoConfig } from '../../src/sdk/config-sanity.ts';
import type { PipelineConfig } from '../../src/types/pipeline.types.ts';

function cfg(ado: Partial<PipelineConfig['azureDevOps']>): PipelineConfig {
  return {
    azureDevOps: {
      organization: 'real-org', orgUrl: 'https://dev.azure.com/real-org', project: 'Real Project',
      repositoryId: 'real-guid', repositoryName: 'Real Repo', ciPipelineId: 1, cdPipelineId: 2,
      areaPath: 'Real Area', iterationPath: 'Real Area', pat: 'p', ...ado,
    },
    paths: { sessionRoot: '/tmp', targetRepo: '/tmp/r', stateDir: '/tmp/s' },
    checkpoints: {
      planApproval: { tag: 'plan-approved', rerunCommand: '/rerun-plan', timeoutHours: 1 },
      prPublished: { fixCommand: '/fix', timeoutHours: 1 }, pollIntervalMinutes: 1,
    },
    revisionLoops: { maxAttempts: 3 }, models: { default: 'm' }, costs: {},
    repoKey: 'R', layout: { appRoot: 'Cloud', source: 'Cloud', testAppRoot: 'Test', test: 'Test/Src' },
  };
}

describe('assertRealAdoConfig', () => {
  test('passes for a fully real config', () => {
    expect(() => assertRealAdoConfig(cfg({}))).not.toThrow();
  });

  test('throws on placeholder organization', () => {
    expect(() => assertRealAdoConfig(cfg({ organization: 'your-org' }))).toThrow(/placeholder.*organization='your-org'/i);
  });

  test('throws on placeholder project', () => {
    expect(() => assertRealAdoConfig(cfg({ project: 'Your Project' }))).toThrow(/project='Your Project'/);
  });

  test('throws on placeholder repositoryId (all-zeros GUID)', () => {
    expect(() => assertRealAdoConfig(cfg({ repositoryId: '00000000-0000-0000-0000-000000000000' }))).toThrow(/repositoryId=/);
  });

  test('reports multiple placeholders at once', () => {
    try {
      assertRealAdoConfig(cfg({ organization: 'your-org', project: 'Your Project' }), 'watcher');
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('watcher');
      expect(msg).toContain("organization='your-org'");
      expect(msg).toContain("project='Your Project'");
    }
  });

  test('context label appears in the error', () => {
    expect(() => assertRealAdoConfig(cfg({ organization: 'your-org' }), 'pr-review')).toThrow(/\(pr-review\)/);
  });
});
