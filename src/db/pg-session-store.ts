import type postgres from 'postgres';
import type { ISessionStore } from '../auth/session-store.interface.ts';

export class PgSessionStore implements ISessionStore {
  constructor(private readonly sql: postgres.Sql) {}

  async create(userId: number, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.sql`
      INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (${tokenHash}, ${userId}, ${expiresAt})
    `;
  }

  async findValid(tokenHash: string): Promise<{ userId: number } | null> {
    const rows = await this.sql`
      SELECT user_id FROM sessions WHERE token_hash = ${tokenHash} AND expires_at > now()
    `;
    return rows.length === 0 ? null : { userId: rows[0]!.user_id as number };
  }

  async touch(tokenHash: string): Promise<void> {
    await this.sql`UPDATE sessions SET last_seen_at = now() WHERE token_hash = ${tokenHash}`;
  }

  async delete(tokenHash: string): Promise<void> {
    await this.sql`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
  }

  async deleteExpired(): Promise<void> {
    await this.sql`DELETE FROM sessions WHERE expires_at <= now()`;
  }
}
