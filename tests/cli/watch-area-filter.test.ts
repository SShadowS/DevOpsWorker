import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { wiqlAnalyse, wiqlPlanApproved, wiqlContinue, wiqlNeedInput } from '../../src/cli/watch.ts';
import { repos, replaceRepos } from '../../src/config/repos.ts';
import type { RepoRegistry } from '../../src/config/repo-config.ts';
import { mkRepo } from '../config/fixtures/fake-registry-store.ts';

// `replaceRepos` mutates the real process-global registry that other test files
// also touch. Snapshot before each test and restore after, so this file's
// swaps can never leak into another file regardless of bun test's run order —
// same pattern as tests/config/hydrate.test.ts.
let repoSnapshot: RepoRegistry;

beforeEach(() => {
  repoSnapshot = { ...repos };
});

afterEach(() => {
  replaceRepos(repoSnapshot);
});

// These builders must read the LIVE registry at call time, not a value baked
// in at module load — otherwise a repo added mid-run (via the database) stays
// invisible to the watcher's WIQL queries until the process restarts.
describe('WIQL query builders — rebuild the area filter from the live registry on every call', () => {
  test('wiqlAnalyse() reflects the current registry, then reflects a later swap', () => {
    replaceRepos({ one: { ...mkRepo({ areaPath: 'Fake.Project\\AreaOne' }), active: true } });
    expect(wiqlAnalyse()).toContain('Fake.Project\\AreaOne');

    replaceRepos({ two: { ...mkRepo({ areaPath: 'Fake.Project\\AreaTwo' }), active: true } });
    const rebuilt = wiqlAnalyse();
    expect(rebuilt).toContain('Fake.Project\\AreaTwo');
    expect(rebuilt).not.toContain('Fake.Project\\AreaOne');
  });

  test('wiqlPlanApproved(), wiqlContinue(), wiqlNeedInput() all rebuild too', () => {
    replaceRepos({ one: { ...mkRepo({ areaPath: 'Fake.Project\\AreaOne' }), active: true } });
    expect(wiqlPlanApproved()).toContain('Fake.Project\\AreaOne');
    expect(wiqlContinue()).toContain('Fake.Project\\AreaOne');
    expect(wiqlNeedInput()).toContain('Fake.Project\\AreaOne');

    replaceRepos({ two: { ...mkRepo({ areaPath: 'Fake.Project\\AreaTwo' }), active: true } });
    expect(wiqlPlanApproved()).not.toContain('Fake.Project\\AreaOne');
    expect(wiqlContinue()).not.toContain('Fake.Project\\AreaOne');
    expect(wiqlNeedInput()).not.toContain('Fake.Project\\AreaOne');
  });
});
