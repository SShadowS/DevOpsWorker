/**
 * Interface for runner status persistence.
 * Implementations: PgRunnerStatus
 */
export interface IRunnerStatus {
  writeStatus(active: number, max: number, workItemIds: number[]): Promise<void>;
  readStatus(): Promise<{ active: number; max: number; workItemIds: number[]; updatedAt: string | null } | null>;
  readDynamicConcurrency(): Promise<number | null>;
  writeDynamicConcurrency(maxConcurrency: number): Promise<void>;
  writeHeartbeat(processName: string): Promise<void>;
  readHeartbeats(): Promise<Record<string, { updatedAt: string; online: boolean }>>;
}
