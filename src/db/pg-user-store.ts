import type postgres from 'postgres';
import type { IUserStore } from '../auth/user-store.interface.ts';
import type { AuthUser, Role } from '../auth/types.ts';

function rowToUser(row: postgres.Row): AuthUser {
  return {
    id: row.id as number,
    email: row.email as string,
    displayName: row.display_name as string,
    role: row.role as Role,
    disabled: row.disabled as boolean,
  };
}

export class PgUserStore implements IUserStore {
  constructor(private readonly sql: postgres.Sql) {}

  async create(u: { email: string; displayName: string; role: Role; passwordHash: string | null }): Promise<AuthUser> {
    const rows = await this.sql`
      INSERT INTO users (email, display_name, role, password_hash)
      VALUES (${u.email.trim().toLowerCase()}, ${u.displayName}, ${u.role}, ${u.passwordHash})
      RETURNING id, email, display_name, role, disabled
    `;
    return rowToUser(rows[0]!);
  }

  async findByEmail(email: string): Promise<(AuthUser & { passwordHash: string | null }) | null> {
    const rows = await this.sql`
      SELECT id, email, display_name, role, disabled, password_hash
      FROM users WHERE email = ${email.trim().toLowerCase()}
    `;
    if (rows.length === 0) return null;
    return { ...rowToUser(rows[0]!), passwordHash: rows[0]!.password_hash as string | null };
  }

  async findById(id: number): Promise<AuthUser | null> {
    const rows = await this.sql`
      SELECT id, email, display_name, role, disabled FROM users WHERE id = ${id}
    `;
    return rows.length === 0 ? null : rowToUser(rows[0]!);
  }

  async list(): Promise<AuthUser[]> {
    const rows = await this.sql`
      SELECT id, email, display_name, role, disabled FROM users ORDER BY email
    `;
    return rows.map(rowToUser);
  }

  async count(): Promise<number> {
    const rows = await this.sql`SELECT count(*)::int AS n FROM users`;
    return rows[0]!.n as number;
  }

  async setPassword(id: number, passwordHash: string): Promise<void> {
    await this.sql`
      UPDATE users SET password_hash = ${passwordHash}, updated_at = now() WHERE id = ${id}
    `;
  }

  async setRole(id: number, role: Role): Promise<void> {
    await this.sql`
      UPDATE users SET role = ${role}, updated_at = now() WHERE id = ${id}
    `;
  }

  async setDisabled(id: number, disabled: boolean): Promise<void> {
    await this.sql`
      UPDATE users SET disabled = ${disabled}, updated_at = now() WHERE id = ${id}
    `;
  }
}
