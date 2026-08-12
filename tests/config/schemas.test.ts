import { describe, test, expect } from 'bun:test';
import {
  repoConfigSchema,
  companionConfigSchema,
  settingsSchemas,
  validateSetting,
} from '../../src/config/schemas.ts';
import type { RepoConfig } from '../../src/config/repo-config.ts';
import type { CompanionDef } from '../../src/config/companions.ts';

// Obviously-fake values only — this is the public core. No customer/tenant
// names, no real repo URLs, no real ADO GUIDs or area paths.
const fakeRepoConfig: RepoConfig = {
  active: true,
  autoReview: true,
  reviewDrafts: false,
  url: 'https://example.invalid/repo.git',
  branch: 'main',
  azureDevOps: {
    organization: 'fake-org',
    orgUrl: 'https://dev.azure.com/fake-org',
    project: 'Fake Project',
    repositoryId: '00000000-0000-0000-0000-000000000000',
    repositoryName: 'FakeRepo',
    ciPipelineId: 1,
    cdPipelineId: 2,
    areaPath: 'Fake.Project\\Area',
    iterationPath: 'Fake.Project\\Area',
  },
  envProvision: {
    profileId: 'fake-profile-id',
    bcVersion: '28.0.0.0',
    region: 'GB',
    bcUser: 'fake-user',
    wizard: { instructions: 'Do the fake wizard steps.' },
  },
  testCases: true,
  docsWriter: { docsRepoUrl: 'https://example.invalid/docs.git' },
  repoKey: 'FakeRepo',
  companions: {
    Core: { branch: 'main', readOnly: true },
  },
  layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
};

// The minimal shape — every optional field omitted — must parse too, since
// most repo registrations don't set them.
const minimalRepoConfig: RepoConfig = {
  url: 'https://example.invalid/minimal.git',
  branch: 'main',
  azureDevOps: {
    project: 'Fake Project',
    repositoryId: '00000000-0000-0000-0000-000000000000',
    repositoryName: 'FakeRepo',
    areaPath: 'Fake.Project\\Area',
  },
  repoKey: 'MinimalRepo',
  companions: {},
  layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
};

const fakeCompanionDef: CompanionDef = {
  url: 'https://example.invalid/companion.git',
  defaultBranch: 'main',
  readOnly: true,
  symlinkOnly: false,
};

describe('repoConfigSchema', () => {
  test('parses a realistic fake repo config', () => {
    const result = repoConfigSchema.safeParse(fakeRepoConfig);
    expect(result.success).toBe(true);
  });

  test('parses the minimal shape with every optional field omitted', () => {
    const result = repoConfigSchema.safeParse(minimalRepoConfig);
    expect(result.success).toBe(true);
  });

  test('fails when repoKey is missing', () => {
    const { repoKey, ...withoutRepoKey } = fakeRepoConfig;
    const result = repoConfigSchema.safeParse(withoutRepoKey);
    expect(result.success).toBe(false);
  });

  test('fails on an unknown top-level key', () => {
    const result = repoConfigSchema.safeParse({ ...fakeRepoConfig, bogusField: 'nope' });
    expect(result.success).toBe(false);
  });

  test.each(['appRoot', 'source', 'testAppRoot', 'test'] as const)(
    'fails when layout is missing %s',
    (key) => {
      const layout = { ...fakeRepoConfig.layout };
      delete (layout as Record<string, unknown>)[key];
      const result = repoConfigSchema.safeParse({ ...fakeRepoConfig, layout });
      expect(result.success).toBe(false);
    },
  );

  test('fails on an unknown key inside layout', () => {
    const result = repoConfigSchema.safeParse({
      ...fakeRepoConfig,
      layout: { ...fakeRepoConfig.layout, bogus: 'nope' },
    });
    expect(result.success).toBe(false);
  });

  test('envProvision is optional — absent is fine', () => {
    const { envProvision, ...withoutEnvProvision } = fakeRepoConfig;
    const result = repoConfigSchema.safeParse(withoutEnvProvision);
    expect(result.success).toBe(true);
  });

  test('envProvision validates its inner shape when present', () => {
    const result = repoConfigSchema.safeParse({
      ...fakeRepoConfig,
      envProvision: { wizard: {} }, // wizard.instructions is required
    });
    expect(result.success).toBe(false);
  });

  test('envProvision rejects an unknown inner key', () => {
    const result = repoConfigSchema.safeParse({
      ...fakeRepoConfig,
      envProvision: { ...fakeRepoConfig.envProvision, bogus: 'nope' },
    });
    expect(result.success).toBe(false);
  });

  test('rejects an unknown key inside a companion override', () => {
    const result = repoConfigSchema.safeParse({
      ...fakeRepoConfig,
      companions: { Core: { branch: 'main', bogus: true } },
    });
    expect(result.success).toBe(false);
  });
});

describe('companionConfigSchema', () => {
  test('parses a realistic fake companion config', () => {
    const result = companionConfigSchema.safeParse(fakeCompanionDef);
    expect(result.success).toBe(true);
  });

  test('parses the minimal shape (only required fields)', () => {
    const result = companionConfigSchema.safeParse({
      url: 'https://example.invalid/companion.git',
      defaultBranch: 'main',
    });
    expect(result.success).toBe(true);
  });

  test('fails when url is missing', () => {
    const { url, ...withoutUrl } = fakeCompanionDef;
    const result = companionConfigSchema.safeParse(withoutUrl);
    expect(result.success).toBe(false);
  });

  test('fails on an unknown key', () => {
    const result = companionConfigSchema.safeParse({ ...fakeCompanionDef, bogus: 'nope' });
    expect(result.success).toBe(false);
  });
});

describe('settingsSchemas', () => {
  test('models.default accepts a non-empty string', () => {
    expect(settingsSchemas['models.default']!.safeParse('claude-sonnet-5').success).toBe(true);
  });

  test('models.default rejects an empty string', () => {
    expect(settingsSchemas['models.default']!.safeParse('').success).toBe(false);
  });

  test('models.default rejects a non-string', () => {
    expect(settingsSchemas['models.default']!.safeParse(123).success).toBe(false);
  });

  test('models.perAgent accepts a record of agent name to non-empty model id', () => {
    const schema = settingsSchemas['models.perAgent']!;
    expect(schema.safeParse({ coder: 'claude-sonnet-5', planner: 'claude-opus-5' }).success).toBe(true);
  });

  test('models.perAgent rejects an empty model id', () => {
    expect(settingsSchemas['models.perAgent']!.safeParse({ coder: '' }).success).toBe(false);
  });

  test('models.perAgent rejects a non-object', () => {
    expect(settingsSchemas['models.perAgent']!.safeParse('claude-sonnet-5').success).toBe(false);
  });

  test('models.effort accepts every level the pipeline accepts', () => {
    const schema = settingsSchemas['models.effort']!;
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(schema.safeParse(level).success).toBe(true);
    }
  });

  test('models.effort rejects a level the pipeline does not accept', () => {
    expect(settingsSchemas['models.effort']!.safeParse('ultra').success).toBe(false);
  });

  test('costs.maxBudgetPerAgentUsd accepts a positive number', () => {
    expect(settingsSchemas['costs.maxBudgetPerAgentUsd']!.safeParse(5).success).toBe(true);
  });

  test('costs.maxBudgetPerAgentUsd rejects zero and negative numbers', () => {
    expect(settingsSchemas['costs.maxBudgetPerAgentUsd']!.safeParse(0).success).toBe(false);
    expect(settingsSchemas['costs.maxBudgetPerAgentUsd']!.safeParse(-5).success).toBe(false);
  });

  test('costs.maxBudgetPerRunUsd accepts a positive number', () => {
    expect(settingsSchemas['costs.maxBudgetPerRunUsd']!.safeParse(50).success).toBe(true);
  });

  test('costs.maxBudgetPerRunUsd rejects zero and negative numbers', () => {
    expect(settingsSchemas['costs.maxBudgetPerRunUsd']!.safeParse(0).success).toBe(false);
    expect(settingsSchemas['costs.maxBudgetPerRunUsd']!.safeParse(-1).success).toBe(false);
  });

  test('runner.maxConcurrency accepts a positive integer', () => {
    expect(settingsSchemas['runner.maxConcurrency']!.safeParse(3).success).toBe(true);
  });

  test('runner.maxConcurrency rejects zero and negative numbers', () => {
    expect(settingsSchemas['runner.maxConcurrency']!.safeParse(0).success).toBe(false);
    expect(settingsSchemas['runner.maxConcurrency']!.safeParse(-1).success).toBe(false);
  });

  test('runner.maxConcurrency rejects a non-integer', () => {
    expect(settingsSchemas['runner.maxConcurrency']!.safeParse(1.5).success).toBe(false);
  });
});

describe('validateSetting', () => {
  test('valid value for a known key returns valid: true with the parsed value', () => {
    const result = validateSetting('models.default', 'claude-sonnet-5');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.value).toBe('claude-sonnet-5');
    }
  });

  test('invalid value for a known key returns valid: false with a field error', () => {
    const result = validateSetting('models.default', '');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  test('runner.maxConcurrency rejects 0 through validateSetting', () => {
    expect(validateSetting('runner.maxConcurrency', 0).valid).toBe(false);
  });

  test('runner.maxConcurrency rejects a negative number through validateSetting', () => {
    expect(validateSetting('runner.maxConcurrency', -3).valid).toBe(false);
  });

  test('accepts maxTurns for an arbitrary agent name', () => {
    expect(validateSetting('agents.coder.maxTurns', 50).valid).toBe(true);
    expect(validateSetting('agents.planner.maxTurns', 10).valid).toBe(true);
  });

  test('rejects a non-positive maxTurns for an arbitrary agent name', () => {
    expect(validateSetting('agents.coder.maxTurns', 0).valid).toBe(false);
    expect(validateSetting('agents.coder.maxTurns', -1).valid).toBe(false);
  });

  test('rejects an entirely unknown settings key', () => {
    const result = validateSetting('not.a.real.key', 'anything');
    expect(result.valid).toBe(false);
  });
});
