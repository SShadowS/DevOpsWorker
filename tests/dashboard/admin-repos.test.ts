import { describe, test, expect } from 'bun:test';
import {
  emptyFormState,
  repoConfigToFormState,
  parseJsonField,
  parseOptionalInt,
  buildRepoConfigFromForm,
  describeRepoRow,
  listRepoRows,
  buildDeleteConfirmationText,
  reduceRepoPanel,
} from '../../src/dashboard/client/components/admin-repos.tsx';
import type { RepoFormState, RepoPanel } from '../../src/dashboard/client/components/admin-repos.tsx';
import type { RepoConfig } from '../../src/config/repo-config.ts';
import type { AdminFieldError } from '../../src/dashboard/client/admin-fetch.ts';
import { mkRepo } from '../config/fixtures/fake-registry-store.ts';

// No test in this file may open a database connection or render a component
// tree (repo convention — see tests/dashboard/stats-config.test.ts). Every
// function under test is pure: given data, it returns a value.

// ---------------------------------------------------------------------------
// emptyFormState / repoConfigToFormState — the two directions of the form
// ---------------------------------------------------------------------------

describe('emptyFormState', () => {
  test('active and autoReview default true, matching a freshly registered repo', () => {
    const f = emptyFormState();
    expect(f.active).toBe(true);
    expect(f.autoReview).toBe(true);
    expect(f.reviewDrafts).toBe(false);
    expect(f.testCases).toBe(false);
    expect(f.companionsJson).toBe('{}');
    expect(f.envProvisionJson).toBe('');
  });
});

describe('repoConfigToFormState', () => {
  test('a fully-specified config round-trips into matching form fields', () => {
    const config: RepoConfig = {
      ...mkRepo({ repoKey: 'repo-a', areaPath: 'Fake.Project\\Area' }),
      active: true,
      autoReview: false,
      reviewDrafts: true,
      testCases: true,
      docsWriter: { docsRepoUrl: 'https://example.invalid/docs.git' },
      envProvision: { region: 'GB' },
      companions: { BC: { branch: 'main', readOnly: true } },
    };
    config.azureDevOps.organization = 'fake-org';
    config.azureDevOps.orgUrl = 'https://example.invalid/fake-org';
    config.azureDevOps.iterationPath = 'Fake.Project\\Iteration';
    config.azureDevOps.ciPipelineId = 111;
    config.azureDevOps.cdPipelineId = 222;

    const f = repoConfigToFormState(config);

    expect(f.active).toBe(true);
    expect(f.autoReview).toBe(false); // explicit false must survive, not read as "unset"
    expect(f.reviewDrafts).toBe(true);
    expect(f.testCases).toBe(true);
    expect(f.docsRepoUrl).toBe('https://example.invalid/docs.git');
    expect(f.organization).toBe('fake-org');
    expect(f.orgUrl).toBe('https://example.invalid/fake-org');
    expect(f.iterationPath).toBe('Fake.Project\\Iteration');
    expect(f.ciPipelineId).toBe('111');
    expect(f.cdPipelineId).toBe('222');
    expect(JSON.parse(f.companionsJson)).toEqual({ BC: { branch: 'main', readOnly: true } });
    expect(JSON.parse(f.envProvisionJson)).toEqual({ region: 'GB' });
  });

  test('an absent active reads as false and an absent autoReview reads as true — the documented defaults, not a blank', () => {
    const config = mkRepo({ repoKey: 'repo-b' }); // no active/autoReview set at all
    const f = repoConfigToFormState(config);
    expect(f.active).toBe(false);
    expect(f.autoReview).toBe(true);
  });

  test('optional fields absent on the config become empty strings, not "undefined"', () => {
    const config = mkRepo({ repoKey: 'repo-c' });
    const f = repoConfigToFormState(config);
    expect(f.organization).toBe('');
    expect(f.orgUrl).toBe('');
    expect(f.iterationPath).toBe('');
    expect(f.ciPipelineId).toBe('');
    expect(f.cdPipelineId).toBe('');
    expect(f.docsRepoUrl).toBe('');
    expect(f.envProvisionJson).toBe('');
    expect(JSON.parse(f.companionsJson)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// parseJsonField / parseOptionalInt
// ---------------------------------------------------------------------------

describe('parseJsonField', () => {
  test('valid JSON parses to its value', () => {
    const result = parseJsonField('{"a": 1}', 'companions');
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  test('invalid JSON names the field in the error, not just "JSON"', () => {
    const result = parseJsonField('{not json', 'companions');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('companions');
      expect(result.error).toContain('not valid JSON');
    }
  });
});

describe('parseOptionalInt', () => {
  test('a blank field is absent, not an error', () => {
    const errors: AdminFieldError[] = [];
    expect(parseOptionalInt('', 'azureDevOps.ciPipelineId', errors)).toBeUndefined();
    expect(parseOptionalInt('   ', 'azureDevOps.ciPipelineId', errors)).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test('a whole number parses cleanly', () => {
    const errors: AdminFieldError[] = [];
    expect(parseOptionalInt('973', 'azureDevOps.ciPipelineId', errors)).toBe(973);
    expect(errors).toEqual([]);
  });

  test('a non-integer records a field error naming the path', () => {
    const errors: AdminFieldError[] = [];
    expect(parseOptionalInt('12.5', 'azureDevOps.ciPipelineId', errors)).toBeUndefined();
    expect(parseOptionalInt('not-a-number', 'azureDevOps.cdPipelineId', errors)).toBeUndefined();
    expect(errors).toEqual([
      { path: 'azureDevOps.ciPipelineId', message: 'Must be a whole number.' },
      { path: 'azureDevOps.cdPipelineId', message: 'Must be a whole number.' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildRepoConfigFromForm — the direction the PUT body is actually built in
// ---------------------------------------------------------------------------

function fixtureForm(overrides: Partial<RepoFormState> = {}): RepoFormState {
  return {
    ...emptyFormState(),
    url: 'https://example.invalid/repo.git',
    branch: 'main',
    repoKey: 'FakeRepo',
    project: 'Fake Project',
    repositoryId: '00000000-0000-0000-0000-000000000000',
    repositoryName: 'FakeRepo',
    areaPath: 'Fake.Project\\Area',
    appRoot: 'Cloud',
    source: 'Cloud/Al',
    testAppRoot: 'Test',
    test: 'Test/Src',
    ...overrides,
  };
}

describe('buildRepoConfigFromForm', () => {
  test('a minimal valid form builds a RepoConfig with no optional fields present', () => {
    const result = buildRepoConfigFromForm(fixtureForm());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.url).toBe('https://example.invalid/repo.git');
      expect(result.config.azureDevOps.organization).toBeUndefined();
      expect(result.config.azureDevOps.ciPipelineId).toBeUndefined();
      expect(result.config.docsWriter).toBeUndefined();
      expect(result.config.envProvision).toBeUndefined();
      expect(result.config.companions).toEqual({});
      // Flags are sent explicitly either way — never omitted — so the admin's
      // checkbox state is exactly what reaches the server.
      expect(result.config.active).toBe(true);
      expect(result.config.autoReview).toBe(true);
      expect(result.config.reviewDrafts).toBe(false);
      expect(result.config.testCases).toBe(false);
    }
  });

  test('a blank companions textarea defaults to an empty object rather than failing', () => {
    const result = buildRepoConfigFromForm(fixtureForm({ companionsJson: '   ' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.companions).toEqual({});
  });

  test('whitespace-trims text fields', () => {
    const result = buildRepoConfigFromForm(fixtureForm({ url: '  https://example.invalid/repo.git  ', branch: ' main ' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.url).toBe('https://example.invalid/repo.git');
      expect(result.config.branch).toBe('main');
    }
  });

  test('optional azureDevOps fields appear only when filled in', () => {
    const result = buildRepoConfigFromForm(fixtureForm({
      organization: 'fake-org',
      orgUrl: 'https://example.invalid/fake-org',
      iterationPath: 'Fake.Project\\Iteration',
      ciPipelineId: '111',
      cdPipelineId: '222',
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.azureDevOps.organization).toBe('fake-org');
      expect(result.config.azureDevOps.orgUrl).toBe('https://example.invalid/fake-org');
      expect(result.config.azureDevOps.iterationPath).toBe('Fake.Project\\Iteration');
      expect(result.config.azureDevOps.ciPipelineId).toBe(111);
      expect(result.config.azureDevOps.cdPipelineId).toBe(222);
    }
  });

  test('docsWriter and envProvision are present only when the admin filled them in', () => {
    const result = buildRepoConfigFromForm(fixtureForm({
      docsRepoUrl: 'https://example.invalid/docs.git',
      envProvisionJson: '{"region": "GB"}',
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.docsWriter).toEqual({ docsRepoUrl: 'https://example.invalid/docs.git' });
      expect(result.config.envProvision).toEqual({ region: 'GB' });
    }
  });

  test('invalid JSON in companions is reported against the "companions" path, not sent to the server', () => {
    const result = buildRepoConfigFromForm(fixtureForm({ companionsJson: '{not json' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.path).toBe('companions');
    }
  });

  test('a companions value that parses but is not an object is rejected with a readable reason', () => {
    const result = buildRepoConfigFromForm(fixtureForm({ companionsJson: '["not", "an", "object"]' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toEqual({ path: 'companions', message: 'companions must be a JSON object mapping a companion key to its overrides.' });
    }
  });

  test('invalid JSON in envProvision is reported against the "envProvision" path', () => {
    const result = buildRepoConfigFromForm(fixtureForm({ envProvisionJson: '{not json' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.path).toBe('envProvision');
    }
  });

  test('a non-integer pipeline id is reported without also swallowing a companions error', () => {
    const result = buildRepoConfigFromForm(fixtureForm({ ciPipelineId: 'nope', companionsJson: '{not json' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const paths = result.errors.map((e) => e.path).sort();
      expect(paths).toEqual(['azureDevOps.ciPipelineId', 'companions']);
    }
  });
});

// ---------------------------------------------------------------------------
// describeRepoRow / listRepoRows
// ---------------------------------------------------------------------------

describe('describeRepoRow', () => {
  test('name comes from azureDevOps.repositoryName, since RepoConfig has no "name" field of its own', () => {
    const row = describeRepoRow('the-key', mkRepo({ repoKey: 'x' }));
    expect(row.name).toBe('FakeRepo'); // mkRepo's repositoryName fixture value
  });

  test('active is false unless explicitly true — matches getActiveAreaPaths\' truthiness filter', () => {
    const withoutActive = describeRepoRow('k', mkRepo());
    expect(withoutActive.active).toBe(false);
    const withActive: RepoConfig = { ...mkRepo(), active: true };
    expect(describeRepoRow('k', withActive).active).toBe(true);
    const withActiveFalse: RepoConfig = { ...mkRepo(), active: false };
    expect(describeRepoRow('k', withActiveFalse).active).toBe(false);
  });

  test('autoReview is true unless explicitly false — "omitted/true reviews every new PR"', () => {
    const withoutAutoReview = describeRepoRow('k', mkRepo());
    expect(withoutAutoReview.autoReview).toBe(true);
    const withAutoReviewFalse: RepoConfig = { ...mkRepo(), autoReview: false };
    expect(describeRepoRow('k', withAutoReviewFalse).autoReview).toBe(false);
  });
});

describe('listRepoRows', () => {
  test('sorts by key so the table order is stable regardless of object insertion order', () => {
    const rows = listRepoRows({
      zeta: mkRepo({ repoKey: 'zeta' }),
      alpha: mkRepo({ repoKey: 'alpha' }),
      mid: mkRepo({ repoKey: 'mid' }),
    });
    expect(rows.map((r) => r.key)).toEqual(['alpha', 'mid', 'zeta']);
  });

  test('an empty registry yields an empty list, not an error', () => {
    expect(listRepoRows({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildDeleteConfirmationText
// ---------------------------------------------------------------------------

describe('buildDeleteConfirmationText', () => {
  test('names the repo and states the live consequence, not just a database edit', () => {
    const text = buildDeleteConfirmationText('fake-repo', mkRepo({ repoKey: 'fake-repo' }));
    expect(text).toContain('FakeRepo'); // the human-readable name
    expect(text).toContain('fake-repo'); // the key
    expect(text).toContain('watcher');
    expect(text).toContain('next poll');
  });
});

// ---------------------------------------------------------------------------
// reduceRepoPanel — the single source of truth for which secondary panel
// (the create/edit form, or a row's delete confirmation) is open.
//
// This closes a real gap: before this reducer existed, "editor open" and
// "delete confirmation open" were two independent signals, and opening one
// never cleared the other. Confirmed directly against the shipped code
// before this fix: calling requestDelete('repo-a') then openEdit('repo-b',
// ...) left confirmingDeleteKey.value at 'repo-a', so closing the editor
// afterwards surfaced repo-a's stale delete confirmation again. Every test
// below asserts the fix's actual guarantee — that opening any panel leaves
// no trace of whatever was open before — regardless of what that prior
// panel was.
// ---------------------------------------------------------------------------

describe('reduceRepoPanel', () => {
  const priorPanels: RepoPanel[] = [
    { kind: 'closed' },
    { kind: 'create' },
    { kind: 'edit', key: 'repo-a' },
    { kind: 'confirmDelete', key: 'repo-a' },
  ];

  test('opening the create panel closes whatever was open before, regardless of what it was', () => {
    for (const prior of priorPanels) {
      expect(reduceRepoPanel(prior, { type: 'openCreate' })).toEqual({ kind: 'create' });
    }
  });

  test('opening the edit panel for a row closes a pending delete confirmation for a different row', () => {
    const confirmingDeleteForRepoA: RepoPanel = { kind: 'confirmDelete', key: 'repo-a' };
    const next = reduceRepoPanel(confirmingDeleteForRepoA, { type: 'openEdit', key: 'repo-b' });
    expect(next).toEqual({ kind: 'edit', key: 'repo-b' });
  });

  test('requesting delete on a row closes an editor that was open for a different row', () => {
    const editingRepoA: RepoPanel = { kind: 'edit', key: 'repo-a' };
    const next = reduceRepoPanel(editingRepoA, { type: 'requestDelete', key: 'repo-b' });
    expect(next).toEqual({ kind: 'confirmDelete', key: 'repo-b' });
  });

  test('close always returns to closed, regardless of what was open', () => {
    for (const prior of priorPanels) {
      expect(reduceRepoPanel(prior, { type: 'close' })).toEqual({ kind: 'closed' });
    }
  });
});
