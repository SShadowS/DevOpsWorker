import type postgres from 'postgres';
import type { IAuthEventStore, AuthEventRow, AuthEventKind } from '../auth/auth-event-store.interface.ts';

export class PgAuthEventStore implements IAuthEventStore {
  constructor(private readonly sql: postgres.Sql) {}

  async write(event: { kind: AuthEventKind; email: string; ip: string | null; userId?: number | null }): Promise<void> {
    await this.sql`
      INSERT INTO auth_events (kind, email, ip, user_id)
      VALUES (${event.kind}, ${event.email}, ${event.ip}, ${event.userId ?? null})
    `;
  }

  async list(limit: number): Promise<AuthEventRow[]> {
    const rows = await this.sql`
      SELECT id, at::text, kind, email, ip, user_id
      FROM auth_events
      ORDER BY at DESC
      LIMIT ${limit}
    `;
    return rows.map(rowToAuthEvent);
  }
}

export function rowToAuthEvent(r: any): AuthEventRow {
  return {
    id: r.id,
    at: r.at,
    kind: r.kind,
    email: r.email,
    ip: r.ip ?? null,
    userId: r.user_id ?? null,
  };
}
