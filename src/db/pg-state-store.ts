import type postgres from 'postgres';
import type { IStateStore, StateWatermark } from '../pipeline/state-store.interface.ts';
import type { PipelineState, PipelineConfig } from '../types/pipeline.types.ts';

export class PgStateStore implements IStateStore {
  onChange?: (workItemId: number) => void;

  constructor(private readonly sql: postgres.Sql) {}

  async exists(workItemId: number): Promise<boolean> {
    const rows = await this.sql`SELECT 1 FROM pipeline_state WHERE work_item_id = ${workItemId}`;
    return rows.length > 0;
  }

  async load(workItemId: number): Promise<PipelineState | null> {
    const rows = await this.sql`SELECT state FROM pipeline_state WHERE work_item_id = ${workItemId}`;
    if (rows.length === 0) return null;
    return rows[0]!.state as PipelineState;
  }

  async save(workItemId: number, state: PipelineState): Promise<void> {
    await this.sql`
      INSERT INTO pipeline_state (work_item_id, state, updated_at)
      VALUES (${workItemId}, ${this.sql.json(state as any)}, now())
      ON CONFLICT (work_item_id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at
    `;
    this.onChange?.(workItemId);
  }

  async saveConfig(workItemId: number, config: PipelineConfig): Promise<void> {
    const sanitized = { ...config, azureDevOps: { ...config.azureDevOps, pat: '' } };
    await this.sql`
      INSERT INTO pipeline_config (work_item_id, config, updated_at)
      VALUES (${workItemId}, ${this.sql.json(sanitized as any)}, now())
      ON CONFLICT (work_item_id) DO UPDATE SET config = EXCLUDED.config, updated_at = EXCLUDED.updated_at
    `;
  }

  async loadConfig(workItemId: number): Promise<PipelineConfig | null> {
    const rows = await this.sql`SELECT config FROM pipeline_config WHERE work_item_id = ${workItemId}`;
    if (rows.length === 0) return null;
    return rows[0]!.config as PipelineConfig;
  }

  async listAll(): Promise<number[]> {
    const rows = await this.sql`SELECT work_item_id FROM pipeline_state`;
    return rows.map((r: any) => r.work_item_id);
  }

  /** One cheap aggregate query — no JSONB deserialization. */
  async getWatermark(): Promise<StateWatermark> {
    const rows = await this.sql`
      SELECT count(*)::int AS count, max(updated_at)::text AS max FROM pipeline_state
    `;
    const row = rows[0] as { count: number; max: string | null };
    return { count: row.count, maxUpdatedAt: row.max };
  }
}
