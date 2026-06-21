import type { Database } from 'bun:sqlite';
import type { IStateStore } from '../pipeline/state-store.interface.ts';
import type { PipelineState, PipelineConfig } from '../types/pipeline.types.ts';

export class SqliteStateStore implements IStateStore {
  /** Optional callback fired after save() with the work item ID. Used by dashboard for SSE. */
  onChange?: (workItemId: number) => void;

  constructor(private readonly db: Database) {}

  exists(workItemId: number): boolean {
    const row = this.db.query('SELECT 1 FROM pipeline_state WHERE work_item_id = ?').get(workItemId);
    return row != null;
  }

  load(workItemId: number): PipelineState | null {
    const row = this.db.query('SELECT state FROM pipeline_state WHERE work_item_id = ?').get(workItemId) as { state: string } | null;
    if (!row) return null;
    return JSON.parse(row.state) as PipelineState;
  }

  save(workItemId: number, state: PipelineState): void {
    this.db.query(
      'INSERT OR REPLACE INTO pipeline_state (work_item_id, state, updated_at) VALUES (?, ?, ?)',
    ).run(workItemId, JSON.stringify(state), new Date().toISOString());
    this.onChange?.(workItemId);
  }

  saveConfig(workItemId: number, config: PipelineConfig): void {
    const sanitized = {
      ...config,
      azureDevOps: { ...config.azureDevOps, pat: '' },
    };
    this.db.query(
      'INSERT OR REPLACE INTO pipeline_config (work_item_id, config, updated_at) VALUES (?, ?, ?)',
    ).run(workItemId, JSON.stringify(sanitized), new Date().toISOString());
  }

  loadConfig(workItemId: number): PipelineConfig | null {
    const row = this.db.query('SELECT config FROM pipeline_config WHERE work_item_id = ?').get(workItemId) as { config: string } | null;
    if (!row) return null;
    return JSON.parse(row.config) as PipelineConfig;
  }

  listAll(): number[] {
    const rows = this.db.query('SELECT work_item_id FROM pipeline_state').all() as { work_item_id: number }[];
    return rows.map(r => r.work_item_id);
  }
}
