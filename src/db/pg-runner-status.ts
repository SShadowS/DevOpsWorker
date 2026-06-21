import type postgres from 'postgres';
import type { IRunnerStatus } from '../pipeline/runner-status.interface.ts';

export class PgRunnerStatus implements IRunnerStatus {
  constructor(private readonly sql: postgres.Sql) {}

  async writeStatus(active: number, max: number, workItemIds: number[]): Promise<void> {
    const value = { active, max, workItemIds, updatedAt: new Date().toISOString() };
    await this.sql`
      INSERT INTO runner_status (key, value, updated_at)
      VALUES ('status', ${this.sql.json(value)}, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `;
  }

  async readStatus(): Promise<{ active: number; max: number; workItemIds: number[]; updatedAt: string | null } | null> {
    const rows = await this.sql`SELECT value FROM runner_status WHERE key = 'status'`;
    if (rows.length === 0) return null;
    return rows[0]!.value as any;
  }

  async readDynamicConcurrency(): Promise<number | null> {
    const rows = await this.sql`SELECT value FROM runner_status WHERE key = 'config'`;
    if (rows.length === 0) return null;
    const data = rows[0]!.value as any;
    return data?.maxConcurrency ?? null;
  }

  async writeDynamicConcurrency(maxConcurrency: number): Promise<void> {
    await this.sql`
      INSERT INTO runner_status (key, value, updated_at)
      VALUES ('config', ${this.sql.json({ maxConcurrency })}, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `;
  }

  async writeHeartbeat(processName: string): Promise<void> {
    const key = `heartbeat:${processName}`;
    const now = new Date().toISOString();
    await this.sql`
      INSERT INTO runner_status (key, value, updated_at)
      VALUES (${key}, ${this.sql.json({ updatedAt: now })}, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `;
  }

  async readHeartbeats(): Promise<Record<string, { updatedAt: string; online: boolean }>> {
    const rows = await this.sql`
      SELECT key, value, updated_at::text FROM runner_status WHERE key LIKE 'heartbeat:%'
    `;
    const staleThresholdMs = 60_000;
    const result: Record<string, { updatedAt: string; online: boolean }> = {};
    for (const row of rows) {
      const name = (row.key as string).replace('heartbeat:', '');
      const updatedAt = row.updated_at as string;
      const ageMs = Date.now() - new Date(updatedAt).getTime();
      result[name] = { updatedAt, online: ageMs < staleThresholdMs };
    }
    return result;
  }
}
