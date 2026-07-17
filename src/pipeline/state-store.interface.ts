import type { PipelineConfig, PipelineState } from '../types/pipeline.types.ts';

/**
 * Cheap change-detection signal for pipeline_state: row count + the most recent
 * updated_at. Callers that need to know "did anything change since I last looked"
 * without paying for a full listAll()+load() scan can poll this instead — count
 * catches inserts/deletes, maxUpdatedAt catches in-place updates. Either one
 * moving means the set of sessions changed.
 */
export interface StateWatermark {
  count: number;
  maxUpdatedAt: string | null;
}

/**
 * Interface for pipeline state persistence.
 * Implementations: SqliteStateStore, PgStateStore
 */
export interface IStateStore {
  onChange?: (workItemId: number) => void;
  exists(workItemId: number): Promise<boolean> | boolean;
  load(workItemId: number): Promise<PipelineState | null> | PipelineState | null;
  save(workItemId: number, state: PipelineState): Promise<void> | void;
  saveConfig(workItemId: number, config: PipelineConfig): Promise<void> | void;
  loadConfig(workItemId: number): Promise<PipelineConfig | null> | PipelineConfig | null;
  listAll(): Promise<number[]> | number[];
  /**
   * Optional cheap watermark (count + max(updated_at)) over pipeline_state.
   * Implementations that can't answer this cheaply (or at all — e.g. the
   * legacy file-based StateStore) may omit it; callers must fall back to
   * always doing the full scan when it's absent.
   */
  getWatermark?(): Promise<StateWatermark> | StateWatermark;
}
