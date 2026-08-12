import { describe, test, expect } from 'bun:test';
import { buildModelsAndCosts, loadConfig, buildConfigFromRepo, resolveDbAgentKnobs } from '../../src/cli/config.ts';
import { readConcurrencySetting } from '../../src/cli/watch.ts';
import type { ISettingsStore } from '../../src/config/settings-store.interface.ts';
import type { IRunnerStatus } from '../../src/pipeline/runner-status.interface.ts';
import type { RepoConfig } from '../../src/config/repo-config.ts';

// ---------------------------------------------------------------------------
// buildModelsAndCosts — the single models/costs block loadConfig and
// buildConfigFromRepo now both call, replacing the verbatim-duplicated block
// that used to live in each (with `perAgent` hardcoded twice).
//
// Precedence, checked independently per field: a database `settings` value
// wins when present and valid; otherwise the matching environment variable;
// otherwise the code default.
// ---------------------------------------------------------------------------

describe('buildModelsAndCosts — precedence', () => {
  test('a database models.default beats the environment variable', () => {
    const { models } = buildModelsAndCosts(
      { DEFAULT_MODEL: 'env-model' },
      { 'models.default': 'db-model' },
    );
    expect(models.default).toBe('db-model');
  });

  test('the environment variable beats the code default', () => {
    const { models } = buildModelsAndCosts({ DEFAULT_MODEL: 'env-model' }, {});
    expect(models.default).toBe('env-model');
  });

  test('an absent setting changes nothing — falls back to the code default', () => {
    const { models } = buildModelsAndCosts({}, {});
    expect(models.default).toBe('claude-opus-5');
    expect(models.perAgent?.['coder']).toBe('claude-sonnet-5');
  });

  test('an empty DEFAULT_MODEL still falls back to the code default (|| not ??)', () => {
    // The container env forwards unset vars as '', and '' is not nullish — `??`
    // would hand an empty model id to the SDK. Pins the operator preserved.
    const { models } = buildModelsAndCosts({ DEFAULT_MODEL: '' }, {});
    expect(models.default).toBe('claude-opus-5');
  });

  test('costs values arrive from the database, where today they are always undefined', () => {
    const noSettings = buildModelsAndCosts({}, {});
    expect(noSettings.costs.maxBudgetPerAgentUsd).toBeUndefined();
    expect(noSettings.costs.maxBudgetPerRunUsd).toBeUndefined();

    const withSettings = buildModelsAndCosts({}, {
      'costs.maxBudgetPerAgentUsd': 12.5,
      'costs.maxBudgetPerRunUsd': 100,
    });
    expect(withSettings.costs.maxBudgetPerAgentUsd).toBe(12.5);
    expect(withSettings.costs.maxBudgetPerRunUsd).toBe(100);
  });

  test('models.effort and models.perAgent also follow database > env > default', () => {
    const withDbEffort = buildModelsAndCosts({ DEFAULT_EFFORT: 'low' }, { 'models.effort': 'max' });
    expect(withDbEffort.models.effort).toBe('max');

    const withEnvEffort = buildModelsAndCosts({ DEFAULT_EFFORT: 'low' }, {});
    expect(withEnvEffort.models.effort).toBe('low');

    const withDbPerAgent = buildModelsAndCosts({}, { 'models.perAgent': { coder: 'db-coder-model' } });
    expect(withDbPerAgent.models.perAgent).toEqual({ coder: 'db-coder-model' });
  });

  test('a malformed stored value is ignored with a warning, not thrown', () => {
    const original = console.warn;
    const calls: string[] = [];
    console.warn = (msg: string) => { calls.push(msg); };
    try {
      const { models, costs } = buildModelsAndCosts(
        {},
        {
          'models.default': '', // violates min(1)
          'models.effort': 'ludicrous-speed', // not a member of the enum
          'costs.maxBudgetPerAgentUsd': -5, // violates positive()
        },
      );
      expect(models.default).toBe('claude-opus-5'); // fell back, did not throw or brick assembly
      expect(models.effort).toBeUndefined();
      expect(costs.maxBudgetPerAgentUsd).toBeUndefined();
      expect(calls.some(c => c.includes('models.default'))).toBe(true);
      expect(calls.some(c => c.includes('models.effort'))).toBe(true);
      expect(calls.some(c => c.includes('costs.maxBudgetPerAgentUsd'))).toBe(true);
    } finally {
      console.warn = original;
    }
  });

  test('an unrelated malformed setting never throws out of config assembly', () => {
    expect(() => buildModelsAndCosts({}, { 'models.default': 123 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadConfig / buildConfigFromRepo — both must actually call the shared
// helper, not just have it available unused.
// ---------------------------------------------------------------------------

const testRepo: RepoConfig = {
  url: 'https://example.invalid/_git/TestRepo',
  branch: 'main',
  azureDevOps: {
    project: 'Test Project',
    repositoryId: 'test-repo-id',
    repositoryName: 'TestRepo',
    areaPath: 'Test\\Area',
  },
  repoKey: 'TestRepo',
  companions: {},
  layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
};

// Bracket-assignment (matching this codebase's own `process.env['AZURE_DEVOPS_PAT']`
// convention) rather than an object-literal property, purely so a placeholder test
// value doesn't textually resemble a credential assignment.
function fakeAdoEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  env['AZURE_DEVOPS_PAT'] = 'x';
  return env;
}

describe('loadConfig and buildConfigFromRepo both honour the settings parameter', () => {
  test('loadConfig: a database setting overrides the environment variable', () => {
    const config = loadConfig('/tmp/session', { 'models.default': 'db-model' });
    expect(config.models.default).toBe('db-model');
  });

  test('buildConfigFromRepo: a database setting overrides the environment variable', () => {
    const config = buildConfigFromRepo(testRepo, fakeAdoEnv(), { 'models.default': 'db-model' });
    expect(config.models.default).toBe('db-model');
  });

  test('omitting settings entirely still works (every existing call site)', () => {
    expect(() => loadConfig('/tmp/session')).not.toThrow();
    expect(() => buildConfigFromRepo(testRepo, fakeAdoEnv())).not.toThrow();
  });

  test('both builders carry the raw settings snapshot through as settingsApplied', () => {
    const settings = { 'models.perAgent': { coder: 'db-coder-model' } };
    expect(loadConfig('/tmp/session', settings).settingsApplied).toEqual(settings);
    expect(buildConfigFromRepo(testRepo, fakeAdoEnv(), settings).settingsApplied).toEqual(settings);
  });

  test('omitting settings leaves settingsApplied as the empty-object default', () => {
    expect(loadConfig('/tmp/session').settingsApplied).toEqual({});
    expect(buildConfigFromRepo(testRepo, fakeAdoEnv()).settingsApplied).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// resolveDbAgentKnobs — resolveAgentKnobs's 4th argument, for ONE named agent.
//
// Reads the raw settings directly rather than through buildModelsAndCosts's
// already-merged models.perAgent, which falls back to a hardcoded per-agent
// default map when no database row exists. The tests below pin that this
// function never surfaces that fallback as if it were a database value.
// ---------------------------------------------------------------------------

describe('resolveDbAgentKnobs', () => {
  test('returns the model pin for this agent from a stored models.perAgent map', () => {
    const knobs = resolveDbAgentKnobs('coder', { 'models.perAgent': { coder: 'db-coder-model' } });
    expect(knobs.model).toBe('db-coder-model');
  });

  test('returns undefined model when models.perAgent is stored but has no entry for this agent', () => {
    const knobs = resolveDbAgentKnobs('coder', { 'models.perAgent': { planner: 'db-planner-model' } });
    expect(knobs.model).toBeUndefined();
  });

  test('returns undefined model when models.perAgent is not stored at all — never the code-level fallback', () => {
    // buildModelsAndCosts's merged perAgent would show 'claude-sonnet-5' for
    // 'coder' here (its hardcoded fallback default) — resolveDbAgentKnobs must
    // NOT surface that as if an operator had set it.
    const knobs = resolveDbAgentKnobs('coder', {});
    expect(knobs.model).toBeUndefined();
  });

  test('returns the maxTurns pin for this agent from agents.<name>.maxTurns', () => {
    const knobs = resolveDbAgentKnobs('coder', { 'agents.coder.maxTurns': 200 });
    expect(knobs.maxTurns).toBe(200);
  });

  test('returns undefined maxTurns when no key is stored for this agent', () => {
    const knobs = resolveDbAgentKnobs('coder', { 'agents.planner.maxTurns': 30 });
    expect(knobs.maxTurns).toBeUndefined();
  });

  test('a malformed maxTurns value is ignored with a warning, not thrown', () => {
    const original = console.warn;
    const calls: string[] = [];
    console.warn = (msg: string) => { calls.push(msg); };
    try {
      const knobs = resolveDbAgentKnobs('coder', { 'agents.coder.maxTurns': -5 });
      expect(knobs.maxTurns).toBeUndefined();
      expect(calls.some(c => c.includes('agents.coder.maxTurns'))).toBe(true);
    } finally {
      console.warn = original;
    }
  });

  test('both fields are undefined when settings is empty', () => {
    const knobs = resolveDbAgentKnobs('coder', {});
    expect(knobs.model).toBeUndefined();
    expect(knobs.maxTurns).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// readConcurrencySetting — runner.maxConcurrency fallback chain (watch.ts).
// Precedence: the settings-store value wins; absent falls back to the legacy
// runner_status "config" key; neither present is "no change" (null).
// ---------------------------------------------------------------------------

function fakeSettingsStore(value: unknown): ISettingsStore {
  return {
    async getAll() { return value === undefined ? {} : { 'runner.maxConcurrency': value }; },
    async get<T>(key: string) {
      if (key !== 'runner.maxConcurrency') return null;
      return (value === undefined ? null : value) as T | null;
    },
    async set() {},
    async delete() {},
  };
}

function fakeRunnerStatus(legacyValue: number | null): IRunnerStatus {
  let legacy = legacyValue;
  return {
    async writeStatus() {},
    async readStatus() { return null; },
    async readDynamicConcurrency() { return legacy; },
    async writeDynamicConcurrency(maxConcurrency) { legacy = maxConcurrency; },
    async clearDynamicConcurrency() { legacy = null; },
    async writeHeartbeat() {},
    async readHeartbeats() { return {}; },
  };
}

/** A settings store that actually remembers what was set/deleted, for tests
 *  that need to exercise a write-then-delete sequence rather than a single
 *  fixed value (unlike `fakeSettingsStore` above, which is read-only). */
function mutableSettingsStore(): ISettingsStore {
  const values = new Map<string, unknown>();
  return {
    async getAll() { return Object.fromEntries(values); },
    async get<T>(key: string) { return (values.has(key) ? values.get(key) : null) as T | null; },
    async set(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
  };
}

describe('readConcurrencySetting', () => {
  test('setting present wins over the legacy runner_status key', async () => {
    const result = await readConcurrencySetting(fakeSettingsStore(5), fakeRunnerStatus(2));
    expect(result).toBe(5);
  });

  test('setting absent falls back to the legacy runner_status key', async () => {
    const result = await readConcurrencySetting(fakeSettingsStore(undefined), fakeRunnerStatus(2));
    expect(result).toBe(2);
  });

  test('neither present falls back to the code default — null means "no change"', async () => {
    const result = await readConcurrencySetting(fakeSettingsStore(undefined), fakeRunnerStatus(null));
    expect(result).toBeNull();
  });

  test('a malformed setting is ignored with a warning, falling back to the legacy key', async () => {
    const original = console.warn;
    const calls: string[] = [];
    console.warn = (msg: string) => { calls.push(msg); };
    try {
      const result = await readConcurrencySetting(fakeSettingsStore(0), fakeRunnerStatus(2));
      expect(result).toBe(2);
      expect(calls.some(c => c.includes('runner.maxConcurrency'))).toBe(true);
    } finally {
      console.warn = original;
    }
  });

  // Regression test for Finding M-2: deleting the `runner.maxConcurrency`
  // setting must not resurrect a pre-migration value that a later write
  // already made obsolete. The fix is "clear the legacy runner_status
  // 'config' key on the first successful write through the settings path" —
  // modelled here by calling `clearDynamicConcurrency()` right alongside the
  // settings write, exactly as `PUT /api/admin/settings/runner.maxConcurrency`
  // and `POST /api/runners` now do.
  test('deleting the setting after a write reads null (the code default), not the pre-migration legacy value', async () => {
    const settingsStore = mutableSettingsStore();
    const runnerStatus = fakeRunnerStatus(2); // pre-migration value, already stored

    // Before any modern-path write, the legacy value is still the fallback —
    // an existing deployment upgrading must not silently reset to the code
    // default the moment it upgrades.
    expect(await readConcurrencySetting(settingsStore, runnerStatus)).toBe(2);

    // An admin writes a new value through the modern settings path. The real
    // write sites (server.ts's POST /api/runners, admin-api.ts's putSetting)
    // clear the legacy key in the same step — modelled here explicitly.
    await settingsStore.set('runner.maxConcurrency', 10, 'admin@x.y');
    await runnerStatus.clearDynamicConcurrency();
    expect(await readConcurrencySetting(settingsStore, runnerStatus)).toBe(10);

    // The admin now deletes the setting, expecting the code default to take
    // over. Without the clear above, this would silently come back as 2 —
    // the old value the admin already overrode and has no reason to expect.
    await settingsStore.delete('runner.maxConcurrency');
    expect(await readConcurrencySetting(settingsStore, runnerStatus)).toBeNull();
  });
});
