import type { AuthUser, Role } from './types.ts';

export interface IUserStore {
  create(u: { email: string; displayName: string; role: Role; passwordHash: string | null }): Promise<AuthUser>;
  /** Lookup is case-insensitive; returns the stored password hash for verification. */
  findByEmail(email: string): Promise<(AuthUser & { passwordHash: string | null }) | null>;
  findById(id: number): Promise<AuthUser | null>;
  list(): Promise<AuthUser[]>;
  count(): Promise<number>;
  setPassword(id: number, passwordHash: string): Promise<void>;
}
