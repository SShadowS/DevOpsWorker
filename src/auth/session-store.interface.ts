export interface ISessionStore {
  create(userId: number, tokenHash: string, expiresAt: Date): Promise<void>;
  /** Returns null when the hash is unknown OR the session is expired. */
  findValid(tokenHash: string): Promise<{ userId: number } | null>;
  /** Update last_seen_at. */
  touch(tokenHash: string): Promise<void>;
  delete(tokenHash: string): Promise<void>;
  /** Invalidate every session for one user — used when a password is rotated. */
  deleteByUser(userId: number): Promise<void>;
  deleteExpired(): Promise<void>;
}
