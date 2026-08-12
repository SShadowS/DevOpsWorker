import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';
import { SCHEMA } from '../../src/db/postgres.ts';
import { PgRegistryStore } from '../../src/db/pg-registry-store.ts';
import { PgSettingsStore } from '../../src/db/pg-settings-store.ts';
import { PgAuditStore } from '../../src/db/pg-audit-store.ts';
import type { RepoConfig } from '../../src/config/repo-config.ts';
import type { CompanionDef } from '../../src/config/companions.ts';

// Deliberately TEST_DATABASE_URL, never DATABASE_URL: these tests write and
// delete rows, and must not run against the production pipeline database.
//
// This file opens its OWN connection with postgres(url) rather than going
// through connectDatabase(): that helper memoises a singleton and silently
// ignores its url argument on every call after the first, so under
// `bun run test:all` a DATABASE_URL connection made by an earlier test file
// would make this file read and write production despite TEST_DATABASE_URL.
// A private connection also means this file's sql.end() cannot pull the
// connection out from under any other file.
const url = process.env.TEST_DATABASE_URL;

function fakeRepoConfig(overrides: Partial<RepoConfig> = {}): RepoConfig {
  return {
    url: 'https://example.invalid/repo',
    branch: 'main',
    azureDevOps: {
      project: 'Fake.Project',
      repositoryId: 'fake-repo-id',
      repositoryName: 'fake-repo',
      areaPath: 'Fake.Project\\Area',
    },
    repoKey: 'cfgtest-repo-a',
    companions: {},
    layout: {
      appRoot: 'Cloud',
      source: 'Cloud/Al',
      testAppRoot: 'Test',
      test: 'Test/Src',
    },
    ...overrides,
  };
}

function fakeCompanionDef(overrides: Partial<CompanionDef> = {}): CompanionDef {
  return {
    url: 'https://example.invalid/companion',
    defaultBranch: 'main',
    ...overrides,
  };
}

describe.skipIf(!url)('config stores (integration)', () => {
  let sql: postgres.Sql;
  let registry: PgRegistryStore;
  let settings: PgSettingsStore;
  let audit: PgAuditStore;

  beforeAll(async () => {
    sql = postgres(url!, {
      max: 5,
      // The schema below is idempotent (CREATE/ALTER ... IF NOT EXISTS), so
      // applying it against a database that already has these tables floods
      // stdout with benign "already exists, skipping" NOTICEs. Drop those;
      // forward anything else so a real notice isn't lost.
      onnotice: (notice) => {
        if (notice.code === '42P07' || notice.code === '42701') return;
        console.warn(`[postgres] ${notice.severity}: ${notice.message}`);
      },
    });
    // A fresh connection has no guarantee the schema already exists (e.g. a
    // TEST_DATABASE_URL database no app process has ever connected to) --
    // apply the same idempotent DDL connectDatabase() runs, directly here.
    await sql.unsafe(SCHEMA);
    registry = new PgRegistryStore(sql);
    settings = new PgSettingsStore(sql);
    audit = new PgAuditStore(sql);
    await sql`DELETE FROM repo_registry WHERE repo_key LIKE 'cfgtest-%'`;
    await sql`DELETE FROM companion_registry WHERE companion_key LIKE 'cfgtest-%'`;
    await sql`DELETE FROM settings WHERE key LIKE 'cfgtest-%'`;
    await sql`DELETE FROM audit_log WHERE entity_key LIKE 'cfgtest-%'`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM repo_registry WHERE repo_key LIKE 'cfgtest-%'`;
    await sql`DELETE FROM companion_registry WHERE companion_key LIKE 'cfgtest-%'`;
    await sql`DELETE FROM settings WHERE key LIKE 'cfgtest-%'`;
    await sql`DELETE FROM audit_log WHERE entity_key LIKE 'cfgtest-%'`;
    await sql.end();
  });

  describe('repos', () => {
    test('upsert then list round trip', async () => {
      const config = fakeRepoConfig();
      await registry.upsertRepo('cfgtest-repo-a', config, 'operator@example.invalid');

      const listed = await registry.listRepos();
      expect(listed['cfgtest-repo-a']).toEqual(config);

      const got = await registry.getRepo('cfgtest-repo-a');
      expect(got).toEqual(config);
    });

    test('upsert with the same key updates in place, leaving one row', async () => {
      await registry.upsertRepo('cfgtest-repo-b', fakeRepoConfig({ repoKey: 'cfgtest-repo-b', branch: 'first' }), 'operator@example.invalid');
      await registry.upsertRepo('cfgtest-repo-b', fakeRepoConfig({ repoKey: 'cfgtest-repo-b', branch: 'second' }), 'operator@example.invalid');

      const got = await registry.getRepo('cfgtest-repo-b');
      expect(got?.branch).toBe('second');

      const rows = await sql`SELECT repo_key FROM repo_registry WHERE repo_key = 'cfgtest-repo-b'`;
      expect(rows.length).toBe(1);
    });

    test('delete removes the row', async () => {
      await registry.upsertRepo('cfgtest-repo-c', fakeRepoConfig({ repoKey: 'cfgtest-repo-c' }), 'operator@example.invalid');
      expect(await registry.getRepo('cfgtest-repo-c')).not.toBeNull();

      await registry.deleteRepo('cfgtest-repo-c');
      expect(await registry.getRepo('cfgtest-repo-c')).toBeNull();
    });

    test('getRepo returns null for an absent key', async () => {
      expect(await registry.getRepo('cfgtest-repo-absent')).toBeNull();
    });

    test('countRepos reflects reality', async () => {
      await sql`DELETE FROM repo_registry WHERE repo_key LIKE 'cfgtest-count-%'`;
      const before = await registry.countRepos();
      await registry.upsertRepo('cfgtest-count-1', fakeRepoConfig({ repoKey: 'cfgtest-count-1' }), null);
      await registry.upsertRepo('cfgtest-count-2', fakeRepoConfig({ repoKey: 'cfgtest-count-2' }), null);
      expect(await registry.countRepos()).toBe(before + 2);
      await registry.deleteRepo('cfgtest-count-1');
      expect(await registry.countRepos()).toBe(before + 1);
      await registry.deleteRepo('cfgtest-count-2');
      expect(await registry.countRepos()).toBe(before);
    });
  });

  describe('companions', () => {
    test('upsert then list round trip', async () => {
      const config = fakeCompanionDef();
      await registry.upsertCompanion('cfgtest-companion-a', config, 'operator@example.invalid');

      const listed = await registry.listCompanions();
      expect(listed['cfgtest-companion-a']).toEqual(config);

      const got = await registry.getCompanion('cfgtest-companion-a');
      expect(got).toEqual(config);
    });

    test('upsert with the same key updates in place, leaving one row', async () => {
      await registry.upsertCompanion('cfgtest-companion-b', fakeCompanionDef({ defaultBranch: 'first' }), 'operator@example.invalid');
      await registry.upsertCompanion('cfgtest-companion-b', fakeCompanionDef({ defaultBranch: 'second' }), 'operator@example.invalid');

      const got = await registry.getCompanion('cfgtest-companion-b');
      expect(got?.defaultBranch).toBe('second');

      const rows = await sql`SELECT companion_key FROM companion_registry WHERE companion_key = 'cfgtest-companion-b'`;
      expect(rows.length).toBe(1);
    });

    test('delete removes the row', async () => {
      await registry.upsertCompanion('cfgtest-companion-c', fakeCompanionDef(), 'operator@example.invalid');
      expect(await registry.getCompanion('cfgtest-companion-c')).not.toBeNull();

      await registry.deleteCompanion('cfgtest-companion-c');
      expect(await registry.getCompanion('cfgtest-companion-c')).toBeNull();
    });

    test('countCompanions reflects reality', async () => {
      const before = await registry.countCompanions();
      await registry.upsertCompanion('cfgtest-companion-count-1', fakeCompanionDef(), null);
      expect(await registry.countCompanions()).toBe(before + 1);
      await registry.deleteCompanion('cfgtest-companion-count-1');
      expect(await registry.countCompanions()).toBe(before);
    });
  });

  describe('settings', () => {
    test('set/get/getAll/delete round trip for a scalar value', async () => {
      await settings.set('cfgtest-setting-scalar', 'sonnet', 'operator@example.invalid');
      expect(await settings.get<string>('cfgtest-setting-scalar')).toBe('sonnet');

      const all = await settings.getAll();
      expect(all['cfgtest-setting-scalar']).toBe('sonnet');

      await settings.delete('cfgtest-setting-scalar');
      expect(await settings.get('cfgtest-setting-scalar')).toBeNull();
    });

    test('set/get round trip for a non-scalar JSONB value', async () => {
      const value = { model: 'sonnet', maxTurns: 40, budgets: { coder: 3, planner: 2 } };
      await settings.set('cfgtest-setting-object', value, 'operator@example.invalid');

      const got = await settings.get<typeof value>('cfgtest-setting-object');
      expect(got).toEqual(value);

      const all = await settings.getAll();
      expect(all['cfgtest-setting-object']).toEqual(value);
    });

    test('set with the same key updates in place, leaving one row', async () => {
      await settings.set('cfgtest-setting-update', { n: 1 }, null);
      await settings.set('cfgtest-setting-update', { n: 2 }, null);

      expect(await settings.get<{ n: number }>('cfgtest-setting-update')).toEqual({ n: 2 });
      const rows = await sql`SELECT key FROM settings WHERE key = 'cfgtest-setting-update'`;
      expect(rows.length).toBe(1);
    });

    test('get returns null for an absent key', async () => {
      expect(await settings.get('cfgtest-setting-absent')).toBeNull();
    });
  });

  describe('audit', () => {
    test('write + list returns newest first', async () => {
      await audit.write({
        actorEmail: 'operator@example.invalid',
        action: 'create',
        entityType: 'repo',
        entityKey: 'cfgtest-audit-1',
        beforeValue: null,
        afterValue: { branch: 'main' },
      });

      await new Promise((r) => setTimeout(r, 10));

      await audit.write({
        actorEmail: 'operator@example.invalid',
        action: 'update',
        entityType: 'repo',
        entityKey: 'cfgtest-audit-1',
        beforeValue: { branch: 'main' },
        afterValue: { branch: 'develop' },
      });

      const rows = await audit.list(50);
      const relevant = rows.filter((r) => r.entityKey === 'cfgtest-audit-1');
      expect(relevant.length).toBe(2);
      expect(relevant[0]?.action).toBe('update');
      expect(relevant[0]?.beforeValue).toEqual({ branch: 'main' });
      expect(relevant[0]?.afterValue).toEqual({ branch: 'develop' });
      expect(relevant[1]?.action).toBe('create');
      expect(relevant[1]?.beforeValue).toBeNull();
      expect(relevant[1]?.afterValue).toEqual({ branch: 'main' });
    });

    test('list respects limit', async () => {
      for (let i = 0; i < 5; i++) {
        await audit.write({
          actorEmail: 'operator@example.invalid',
          action: 'update',
          entityType: 'setting',
          entityKey: 'cfgtest-audit-limit',
          beforeValue: { n: i },
          afterValue: { n: i + 1 },
        });
      }

      const rows = await audit.list(3);
      expect(rows.length).toBe(3);
    });

    test('write inside a caller-supplied transaction commits together with the change', async () => {
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO settings (key, value, updated_by) VALUES ('cfgtest-setting-txn', ${tx.json({ n: 1 })}, 'operator@example.invalid')
        `;
        await audit.write(
          {
            actorEmail: 'operator@example.invalid',
            action: 'create',
            entityType: 'setting',
            entityKey: 'cfgtest-audit-txn',
            beforeValue: null,
            afterValue: { n: 1 },
          },
          tx,
        );
      });

      expect(await settings.get<{ n: number }>('cfgtest-setting-txn')).toEqual({ n: 1 });
      const rows = await audit.list(50);
      expect(rows.some((r) => r.entityKey === 'cfgtest-audit-txn')).toBe(true);

      await sql`DELETE FROM settings WHERE key = 'cfgtest-setting-txn'`;
    });
  });
});
