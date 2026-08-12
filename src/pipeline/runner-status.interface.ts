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
  /**
   * Deletes the legacy `runner_status` `config` key. Called on the FIRST
   * successful write of `runner.maxConcurrency` through the settings path
   * (`PUT /api/admin/settings/runner.maxConcurrency`, `POST /api/runners`) —
   * without this, deleting the modern setting falls back to whatever
   * pre-migration value still sits here, silently resurrecting it even
   * though the admin who deleted the setting expected the code default.
   * Idempotent: a no-op once the key is gone.
   */
  clearDynamicConcurrency(): Promise<void>;
  writeHeartbeat(processName: string): Promise<void>;
  readHeartbeats(): Promise<Record<string, { updatedAt: string; online: boolean }>>;
}
