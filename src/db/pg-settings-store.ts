import type postgres from 'postgres';
import type { ISettingsStore } from '../config/settings-store.interface.ts';

export class PgSettingsStore implements ISettingsStore {
  constructor(private readonly sql: postgres.Sql) {}

  async getAll(): Promise<Record<string, unknown>> {
    const rows = await this.sql`SELECT key, value FROM settings ORDER BY key`;
    const result: Record<string, unknown> = {};
    for (const row of rows) result[row.key as string] = row.value;
    return result;
  }

  async get<T>(key: string): Promise<T | null> {
    const rows = await this.sql`SELECT value FROM settings WHERE key = ${key}`;
    return rows.length > 0 ? (rows[0]!.value as T) : null;
  }

  async set(key: string, value: unknown, actor: string | null): Promise<void> {
    await this.sql`
      INSERT INTO settings (key, value, updated_at, updated_by)
      VALUES (${key}, ${this.sql.json(value as postgres.JSONValue)}, now(), ${actor})
      ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by
    `;
  }

  async delete(key: string): Promise<void> {
    await this.sql`DELETE FROM settings WHERE key = ${key}`;
  }
}
