import type postgres from 'postgres';
import type { IAuditStore, AuditRow } from '../config/audit-store.interface.ts';

export class PgAuditStore implements IAuditStore {
  constructor(private readonly sql: postgres.Sql) {}

  async write(entry: Omit<AuditRow, 'id' | 'at'>, sql?: postgres.Sql | postgres.TransactionSql): Promise<void> {
    const db = sql ?? this.sql;
    const before = entry.beforeValue == null ? null : db.json(entry.beforeValue as postgres.JSONValue);
    const after = entry.afterValue == null ? null : db.json(entry.afterValue as postgres.JSONValue);
    await db`
      INSERT INTO audit_log (actor_email, action, entity_type, entity_key, before_value, after_value)
      VALUES (${entry.actorEmail}, ${entry.action}, ${entry.entityType}, ${entry.entityKey}, ${before}, ${after})
    `;
  }

  async list(limit: number): Promise<AuditRow[]> {
    const rows = await this.sql`
      SELECT id, at::text, actor_email, action, entity_type, entity_key, before_value, after_value
      FROM audit_log
      ORDER BY at DESC
      LIMIT ${limit}
    `;
    return rows.map(rowToAuditRow);
  }
}

export function rowToAuditRow(r: any): AuditRow {
  return {
    id: r.id,
    at: r.at,
    actorEmail: r.actor_email,
    action: r.action,
    entityType: r.entity_type,
    entityKey: r.entity_key,
    beforeValue: r.before_value ?? null,
    afterValue: r.after_value ?? null,
  };
}
