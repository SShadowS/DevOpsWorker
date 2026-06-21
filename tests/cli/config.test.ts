import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { loadConfig, loadConfigFromState, buildConfigFromRepo } from '../../src/cli/config.ts';
import type { RepoConfig } from '../../src/config/repo-config.ts';
import { openDatabase } from '../../src/db/database.ts';
import { SqliteStateStore } from '../../src/db/sqlite-state-store.ts';
import type { Database } from 'bun:sqlite';
import type { PipelineConfig } from '../../src/types/pipeline.types.ts';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined) {
  savedEnv[key] = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function restoreEnv() {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

let tempDir: string;
let currentDb: Database | null = null;

function setupTempDir(): { dir: string; store: SqliteStateStore } {
  tempDir = mkdtempSync(join(tmpdir(), 'config-test-'));
  currentDb = openDatabase(tempDir);
  return { dir: tempDir, store: new SqliteStateStore(currentDb) };
}

function cleanupTempDir(): void {
  if (currentDb) { currentDb.close(); currentDb = null; }
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// These tests assert loadConfig's DEFAULTS, which only hold when the AZURE_DEVOPS_*
// env vars are unset. A real deployment .env (auto-loaded by Bun) sets them, which
// would pollute the assertions — so snapshot + clear them before each test and
// restore after. This top-level afterEach runs AFTER the describe-level restoreEnv,
// making it authoritative for these keys.
const ADO_ENV_KEYS = [
  'AZURE_DEVOPS_ORG', 'AZURE_DEVOPS_ORG_URL', 'AZURE_DEVOPS_PROJECT',
  'AZURE_DEVOPS_REPO_ID', 'AZURE_DEVOPS_REPO_NAME', 'AZURE_DEVOPS_CI_PIPELINE',
  'AZURE_DEVOPS_CD_PIPELINE', 'AZURE_DEVOPS_AREA_PATH', 'AZURE_DEVOPS_ITERATION',
  'ENV_PROFILE_ID', 'ENV_APP_PATHS', 'ENV_CLI',
];
const adoEnvSnapshot: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ADO_ENV_KEYS) { adoEnvSnapshot[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ADO_ENV_KEYS) {
    if (adoEnvSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = adoEnvSnapshot[k];
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  afterEach(restoreEnv);

  test('reads PAT from env', () => {
    setEnv('AZURE_DEVOPS_PAT', 'my-secret-pat');
    const config = loadConfig('/tmp/session');
    expect(config.azureDevOps.pat).toBe('my-secret-pat');
  });

  test('reads org values from env with defaults', () => {
    setEnv('AZURE_DEVOPS_ORG', 'my-org');
    setEnv('AZURE_DEVOPS_PROJECT', 'My Project');
    setEnv('AZURE_DEVOPS_CI_PIPELINE', '999');

    const config = loadConfig('/tmp/session');
    expect(config.azureDevOps.organization).toBe('my-org');
    expect(config.azureDevOps.orgUrl).toBe('https://dev.azure.com/my-org');
    expect(config.azureDevOps.project).toBe('My Project');
    expect(config.azureDevOps.ciPipelineId).toBe(999);
    // Defaults should be preserved for unset vars
    expect(config.azureDevOps.repositoryName).toBe('Your Repository');
  });

  test('uses defaults when env vars not set', () => {
    setEnv('AZURE_DEVOPS_ORG', undefined);
    setEnv('AZURE_DEVOPS_PROJECT', undefined);
    setEnv('AZURE_DEVOPS_CI_PIPELINE', undefined);
    setEnv('AZURE_DEVOPS_PAT', '');

    const config = loadConfig('/tmp/session');
    expect(config.azureDevOps.organization).toBe('your-org');
    expect(config.azureDevOps.project).toBe('Your Project');
    expect(config.azureDevOps.ciPipelineId).toBe(0);
  });
});

describe('loadConfigFromState', () => {
  afterEach(() => {
    restoreEnv();
    cleanupTempDir();
  });

  test('loads persisted config', async () => {
    const { dir, store } = setupTempDir();

    const config: PipelineConfig = {
      azureDevOps: {
        organization: 'persisted-org', orgUrl: 'https://dev.azure.com/persisted-org',
        project: 'Persisted', repositoryId: 'r', repositoryName: 'R',
        ciPipelineId: 1, cdPipelineId: 2, areaPath: 'T', iterationPath: 'T', pat: 'old-pat',
      },
      paths: { sessionRoot: '/tmp', targetRepo: '/tmp/doc', stateDir: dir },
      checkpoints: {
        planApproval: { tag: 't', rerunCommand: '/r', timeoutHours: 1 },
        prPublished: { fixCommand: '/f', timeoutHours: 1 },
        pollIntervalMinutes: 1,
      },
      revisionLoops: { maxAttempts: 3 },
      models: { default: 'test' },
      costs: {},
      repoKey: 'DocumentOutput',
      layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
    };

    store.saveConfig(42, config);
    setEnv('AZURE_DEVOPS_PAT', '');

    const loaded = await loadConfigFromState(store, 42);
    expect(loaded.azureDevOps.organization).toBe('persisted-org');
  });

  test('falls back to defaults if no persisted config', async () => {
    const { store } = setupTempDir();
    setEnv('AZURE_DEVOPS_PAT', 'env-pat');

    const loaded = await loadConfigFromState(store, 999);
    // Falls back to loadConfig defaults
    expect(loaded.azureDevOps.organization).toBe('your-org');
  });

  test('overrides PAT from env', async () => {
    const { dir, store } = setupTempDir();

    const config: PipelineConfig = {
      azureDevOps: {
        organization: 'test', orgUrl: 'https://test', project: 'Test',
        repositoryId: 'r', repositoryName: 'R', ciPipelineId: 1, cdPipelineId: 2,
        areaPath: 'T', iterationPath: 'T', pat: 'old-pat',
      },
      paths: { sessionRoot: '/tmp', targetRepo: '/tmp/doc', stateDir: dir },
      checkpoints: {
        planApproval: { tag: 't', rerunCommand: '/r', timeoutHours: 1 },
        prPublished: { fixCommand: '/f', timeoutHours: 1 },
        pollIntervalMinutes: 1,
      },
      revisionLoops: { maxAttempts: 3 },
      models: { default: 'test' },
      costs: {},
      repoKey: 'DocumentOutput',
      layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
    };

    store.saveConfig(42, config);
    setEnv('AZURE_DEVOPS_PAT', 'new-env-pat');

    const loaded = await loadConfigFromState(store, 42);
    expect(loaded.azureDevOps.pat).toBe('new-env-pat');
  });
});

// ---------------------------------------------------------------------------
// buildConfigFromRepo tests
// ---------------------------------------------------------------------------

const testRepo: RepoConfig = {
  url: 'https://dev.azure.com/test/_git/TestRepo',
  branch: 'main',
  azureDevOps: {
    project: 'Test Project',
    repositoryId: 'test-repo-id',
    repositoryName: 'TestRepo',
    ciPipelineId: 100,
    areaPath: 'Test\\Area',
  },
  repoKey: 'TestRepo',
  companions: {},
  layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
};

describe('buildConfigFromRepo', () => {
  test('maps repo config to PipelineConfig', () => {
    const config = buildConfigFromRepo(testRepo, {
      AZURE_DEVOPS_PAT: 'test-pat',
    });

    expect(config.azureDevOps.project).toBe('Test Project');
    expect(config.azureDevOps.repositoryId).toBe('test-repo-id');
    expect(config.azureDevOps.pat).toBe('test-pat');
    expect(config.paths.sessionRoot).toBe('/workspace/session');
    expect(config.paths.targetRepo).toBe('/workspace/session/TestRepo');
  });

  test('derives paths from SESSION_ROOT env var', () => {
    const config = buildConfigFromRepo(testRepo, {
      AZURE_DEVOPS_PAT: 'test-pat',
      SESSION_ROOT: '/custom/session',
    });

    expect(config.paths.sessionRoot).toBe('/custom/session');
    expect(config.paths.targetRepo).toBe('/custom/session/TestRepo');
  });

  test('omits environment config when repo has no envProvision', () => {
    const config = buildConfigFromRepo(testRepo, {
      AZURE_DEVOPS_PAT: 'test-pat',
    });

    expect(config.environment).toBeUndefined();
  });

  test('includes environment config when repo has envProvision', () => {
    const repoWithEnv: RepoConfig = {
      ...testRepo,
      envProvision: { profileId: 'test-profile' },
    };

    const config = buildConfigFromRepo(repoWithEnv, {
      AZURE_DEVOPS_PAT: 'test-pat',
    });

    expect(config.environment).toBeDefined();
    expect(config.environment!.profileId).toBe('test-profile');
  });

  test('auto-generates appPaths from companions when ENV_APP_PATHS not set', () => {
    const repoWithCompanions: RepoConfig = {
      ...testRepo,
      envProvision: { profileId: 'test-profile' },
      companions: {
        'Core': { readOnly: true },
        'DeliveryNetwork': { readOnly: true },
        'BC': { readOnly: true },
        'TestRepo': {},
      },
    };

    const config = buildConfigFromRepo(repoWithCompanions, {
      AZURE_DEVOPS_PAT: 'test-pat',
    });

    expect(config.environment!.appPaths).toEqual([
      'Core/Cloud',
      'DeliveryNetwork/Cloud',
      'TestRepo/Cloud',
      'TestRepo/Test',
    ]);
  });

  test('uses ENV_APP_PATHS when set', () => {
    const repoWithCompanions: RepoConfig = {
      ...testRepo,
      envProvision: { profileId: 'test-profile' },
      companions: { 'Core': { readOnly: true } },
    };

    const config = buildConfigFromRepo(repoWithCompanions, {
      AZURE_DEVOPS_PAT: 'test-pat',
      ENV_APP_PATHS: 'Custom/Path1,Custom/Path2',
    });

    expect(config.environment!.appPaths).toEqual(['Custom/Path1', 'Custom/Path2']);
  });

  test('throws if PAT is not provided', () => {
    expect(() => buildConfigFromRepo(testRepo, {}))
      .toThrow();
  });
});
