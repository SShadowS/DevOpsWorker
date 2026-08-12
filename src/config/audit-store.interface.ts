import type postgres from 'postgres';

/**
 * One recorded admin change. `beforeValue` is null for a create; `afterValue`
 * is null for a delete. Both are arbitrary JSONB payloads (a RepoConfig, a
 * CompanionDef, a settings value, ...) — there is no shared shape to type
 * more narrowly than `unknown`.
 */
export interface AuditRow {
  id: number;
  at: string;
  actorEmail: string;
  action: string;
  entityType: string;
  entityKey: string;
  beforeValue: unknown;
  afterValue: unknown;
}

export interface IAuditStore {
  /** Newest first. */
  list(limit: number): Promise<AuditRow[]>;
  /**
   * Record one admin change. Pass the transaction handle from a caller's own
   * `sql.begin(...)` as the second argument so the audit row commits or fails
   * together with the change it describes; omit it to write standalone.
   */
  write(entry: Omit<AuditRow, 'id' | 'at'>, sql?: postgres.Sql | postgres.TransactionSql): Promise<void>;
}
