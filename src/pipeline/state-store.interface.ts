import type { PipelineConfig, PipelineState } from '../types/pipeline.types.ts';

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
}
