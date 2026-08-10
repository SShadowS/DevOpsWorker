export interface ISessionStore {
  create(userId: number, tokenHash: string, expiresAt: Date): Promise<void>;
  /** Returns null when the hash is unknown OR the session is expired. */
  findValid(tokenHash: string): Promise<{ userId: number } | null>;
  /** Update last_seen_at. */
  touch(tokenHash: string): Promise<void>;
  delete(tokenHash: string): Promise<void>;
  deleteExpired(): Promise<void>;
}
