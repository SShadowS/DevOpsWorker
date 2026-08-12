/**
 * Interface for runner status persistence.
 * Implementations: PgRunnerStatus
 */
export interface IRunnerStatus {
  writeStatus(active: number, max: number, workItemIds: number[]): Promise<void>;
  readStatus(): Promise<{ active: number; max: number; workItemIds: number[]; updatedAt: string | null } | null>;
  /**
   * @deprecated The `runner.maxConcurrency` setting (`ISettingsStore`) is now the
   * primary source — see `readConcurrencySetting` in `src/cli/watch.ts`. This reads
   * the `config` key it replaces, kept only as that function's fallback for a
   * deployment upgrading with a value already stored here.
   */
  readDynamicConcurrency(): Promise<number | null>;
  /** @deprecated No production code writes this anymore; `POST /api/runners` writes
   *  the `runner.maxConcurrency` setting instead. */
  writeDynamicConcurrency(maxConcurrency: number): Promise<void>;
  writeHeartbeat(processName: string): Promise<void>;
  readHeartbeats(): Promise<Record<string, { updatedAt: string; online: boolean }>>;
}
