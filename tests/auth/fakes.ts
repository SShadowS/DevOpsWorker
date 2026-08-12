import type { IUserStore } from '../../src/auth/user-store.interface.ts';
import type { ISessionStore } from '../../src/auth/session-store.interface.ts';
import type { IAuthEventStore, AuthEventRow, AuthEventKind } from '../../src/auth/auth-event-store.interface.ts';
import type { AuthUser, Role } from '../../src/auth/types.ts';

export class FakeUserStore implements IUserStore {
  rows: (AuthUser & { passwordHash: string | null })[] = [];
  private nextId = 1;

  async create(u: { email: string; displayName: string; role: Role; passwordHash: string | null }): Promise<AuthUser> {
    const row = {
      id: this.nextId++,
      email: u.email.trim().toLowerCase(),
      displayName: u.displayName,
      role: u.role,
      disabled: false,
      passwordHash: u.passwordHash,
    };
    this.rows.push(row);
    const { passwordHash: _, ...user } = row;
    return user;
  }

  async findByEmail(email: string): Promise<(AuthUser & { passwordHash: string | null }) | null> {
    return this.rows.find((r) => r.email === email.trim().toLowerCase()) ?? null;
  }

  async findById(id: number): Promise<AuthUser | null> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    const { passwordHash: _, ...user } = row;
    return user;
  }

  async list(): Promise<AuthUser[]> {
    return this.rows.map(({ passwordHash: _, ...user }) => user);
  }

  async count(): Promise<number> {
    return this.rows.length;
  }

  async setPassword(id: number, passwordHash: string): Promise<void> {
    const row = this.rows.find((r) => r.id === id);
    if (row) row.passwordHash = passwordHash;
  }
}

export class FakeSessionStore implements ISessionStore {
  rows = new Map<string, { userId: number; expiresAt: Date }>();

  async create(userId: number, tokenHash: string, expiresAt: Date): Promise<void> {
    this.rows.set(tokenHash, { userId, expiresAt });
  }

  async findValid(tokenHash: string): Promise<{ userId: number } | null> {
    const row = this.rows.get(tokenHash);
    if (!row || row.expiresAt.getTime() <= Date.now()) return null;
    return { userId: row.userId };
  }

  async touch(_tokenHash: string): Promise<void> {}

  async delete(tokenHash: string): Promise<void> {
    this.rows.delete(tokenHash);
  }

  async deleteByUser(userId: number): Promise<void> {
    for (const [hash, row] of this.rows) {
      if (row.userId === userId) this.rows.delete(hash);
    }
  }

  async deleteExpired(): Promise<void> {
    for (const [hash, row] of this.rows) {
      if (row.expiresAt.getTime() <= Date.now()) this.rows.delete(hash);
    }
  }
}

export class FakeAuthEventStore implements IAuthEventStore {
  rows: AuthEventRow[] = [];
  private nextId = 1;

  async write(event: { kind: AuthEventKind; email: string; ip: string | null; userId?: number | null }): Promise<void> {
    this.rows.push({
      id: this.nextId++,
      at: new Date().toISOString(),
      kind: event.kind,
      email: event.email,
      ip: event.ip,
      userId: event.userId ?? null,
    });
  }

  async list(limit: number): Promise<AuthEventRow[]> {
    return this.rows.slice(-limit).reverse();
  }
}
