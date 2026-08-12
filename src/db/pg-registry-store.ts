import type postgres from 'postgres';
import type { IRegistryStore, CompanionRegistry } from '../config/registry-store.interface.ts';
import type { RepoConfig, RepoRegistry } from '../config/repo-config.ts';
import type { CompanionDef } from '../config/companions.ts';

export class PgRegistryStore implements IRegistryStore {
  constructor(private readonly sql: postgres.Sql) {}

  async listRepos(): Promise<RepoRegistry> {
    const rows = await this.sql`SELECT repo_key, config FROM repo_registry ORDER BY repo_key`;
    const result: RepoRegistry = {};
    for (const row of rows) result[row.repo_key as string] = row.config as RepoConfig;
    return result;
  }

  async getRepo(key: string): Promise<RepoConfig | null> {
    const rows = await this.sql`SELECT config FROM repo_registry WHERE repo_key = ${key}`;
    return rows.length > 0 ? (rows[0]!.config as RepoConfig) : null;
  }

  async upsertRepo(key: string, config: RepoConfig, actor: string | null): Promise<void> {
    await this.sql`
      INSERT INTO repo_registry (repo_key, config, updated_at, updated_by)
      VALUES (${key}, ${this.sql.json(config as unknown as postgres.JSONValue)}, now(), ${actor})
      ON CONFLICT (repo_key) DO UPDATE
        SET config = EXCLUDED.config, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
    `;
  }

  async deleteRepo(key: string): Promise<void> {
    await this.sql`DELETE FROM repo_registry WHERE repo_key = ${key}`;
  }

  async countRepos(): Promise<number> {
    const rows = await this.sql`SELECT count(*)::int AS n FROM repo_registry`;
    return rows[0]!.n as number;
  }

  async listCompanions(): Promise<CompanionRegistry> {
    const rows = await this.sql`SELECT companion_key, config FROM companion_registry ORDER BY companion_key`;
    const result: CompanionRegistry = {};
    for (const row of rows) result[row.companion_key as string] = row.config as CompanionDef;
    return result;
  }

  async getCompanion(key: string): Promise<CompanionDef | null> {
    const rows = await this.sql`SELECT config FROM companion_registry WHERE companion_key = ${key}`;
    return rows.length > 0 ? (rows[0]!.config as CompanionDef) : null;
  }

  async upsertCompanion(key: string, config: CompanionDef, actor: string | null): Promise<void> {
    await this.sql`
      INSERT INTO companion_registry (companion_key, config, updated_at, updated_by)
      VALUES (${key}, ${this.sql.json(config as unknown as postgres.JSONValue)}, now(), ${actor})
      ON CONFLICT (companion_key) DO UPDATE
        SET config = EXCLUDED.config, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
    `;
  }

  async deleteCompanion(key: string): Promise<void> {
    await this.sql`DELETE FROM companion_registry WHERE companion_key = ${key}`;
  }

  async countCompanions(): Promise<number> {
    const rows = await this.sql`SELECT count(*)::int AS n FROM companion_registry`;
    return rows[0]!.n as number;
  }
}
