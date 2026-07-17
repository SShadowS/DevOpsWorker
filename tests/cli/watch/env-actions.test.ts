import { describe, test, expect, afterEach, mock } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetManifestCache } from '../../../src/overlay/loader.ts';
import { reprovisionEnv, executeReprovisionEnvAction } from '../../../src/cli/watch/env-actions.ts';
import type { PipelineConfig, PipelineState } from '../../../src/types/pipeline.types.ts';
import type { IStateStore } from '../../../src/pipeline/state-store.interface.ts';

// ---------------------------------------------------------------------------
// reprovisionEnv / executeReprovisionEnvAction — failure-escalation target
//
// Task 14 unified the poll path's and the dashboard's reprovision-or-escalate
// logic into one `reprovisionEnv`. The old dashboard arm escalated (comment +
// need-input tag) using the watcher's `pollingConfig`, while it already
// reprovisioned using the per-item `config` — an internal inconsistency. The
// unified helper deliberately converges both the reprovision call AND the
// escalation on the per-item config (matching the poll path's original
// precedent). This locks that choice in: it fails if a future change routes
// escalation back through `pollingConfig`, which would silently misdirect the
// error comment/tag to the wrong Azure DevOps project for any repo whose
// project differs from the watcher's default.
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
const tmpDirs: string[] = [];

function makeConfig(project: string, pat: string): PipelineConfig {
  return {
    azureDevOps: {
      organization: 'org',
      orgUrl: 'https://dev.azure.com/org',
      project,
      repositoryId: 'r',
      repositoryName: 'R',
      ciPipelineId: 1,
      cdPipelineId: 2,
      areaPath: 'A',
      iterationPath: 'I',
      pat,
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

/** A throwaway overlay dir whose envProvider's `reprovision` always throws,
 *  so `reprovisionEnv` always takes the escalation branch. */
function makeThrowingOverlayDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'env-actions-test-'));
  tmpDirs.push(dir);
  writeFileSync(
    join(dir, 'manifest.ts'),
    `export default {
      envProvider: () => ({
        startEnv: async () => {},
        stopEnv: async () => {},
        deleteEnv: async () => {},
        shareEnv: async () => {},
        reprovision: async () => { throw new Error('reprovision failed'); },
      }),
    };`,
  );
  return dir;
}

function setMockFetch(): { calledUrls: string[] } {
  const calledUrls: string[] = [];
  globalThis.fetch = mock((url: unknown) => {
    calledUrls.push(String(url));
    return Promise.resolve(
      new Response(JSON.stringify({ id: 1, fields: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { calledUrls };
}

function noopStateStore(config: PipelineConfig): IStateStore {
  return {
    exists: () => true,
    load: () => null,
    save: () => {},
    saveConfig: () => {},
    loadConfig: () => config,
    listAll: () => [],
  };
}

afterEach(() => {
  resetManifestCache();
  delete process.env['PRIVATE_DIR'];
  globalThis.fetch = originalFetch;
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe('reprovisionEnv — failure escalation target', () => {
  test('escalates (comment + tag) using the config it was called with, not some other config', async () => {
    process.env['PRIVATE_DIR'] = makeThrowingOverlayDir();
    resetManifestCache();
    const { calledUrls } = setMockFetch();

    const itemConfig = makeConfig('item-project', 'item-pat');
    const stateStore = noopStateStore(itemConfig);

    await reprovisionEnv(123, {} as unknown as PipelineState, itemConfig, stateStore);

    // postWorkItemComment (1 call) + addWorkItemTags (GET work item, then PATCH tags) = 3 calls.
    expect(calledUrls.length).toBe(3);
    for (const url of calledUrls) {
      expect(url).toContain('item-project');
    }
  });
});

describe('executeReprovisionEnvAction — dashboard arm escalation target', () => {
  test('escalates using the per-item config loaded from the state store, not the watcher pollingConfig', async () => {
    process.env['PRIVATE_DIR'] = makeThrowingOverlayDir();
    resetManifestCache();
    const { calledUrls } = setMockFetch();

    // Distinct projects: if escalation ever regresses to pollingConfig, the
    // asserted project below stops appearing in the fetched URLs.
    const itemConfig = makeConfig('item-project', ''); // persisted copy: PAT stripped
    const pollingConfig = makeConfig('polling-project', 'polling-pat');
    const stateStore = noopStateStore(itemConfig);

    await executeReprovisionEnvAction(123, {} as unknown as PipelineState, stateStore, pollingConfig);

    expect(calledUrls.length).toBe(3);
    for (const url of calledUrls) {
      expect(url).toContain('item-project');
      expect(url).not.toContain('polling-project');
    }
  });
});
