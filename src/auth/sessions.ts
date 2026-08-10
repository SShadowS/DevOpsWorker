import { randomBytes, createHash } from 'crypto';
import type { IUserStore } from './user-store.interface.ts';
import type { ISessionStore } from './session-store.interface.ts';
import type { AuthUser } from './types.ts';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (spec)

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  store: ISessionStore,
  userId: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await store.create(userId, hashToken(token), expiresAt);
  return { token, expiresAt };
}

/** Cookie token → user, or null. Rejects unknown/expired sessions and disabled users. */
export async function resolveSession(
  userStore: IUserStore,
  sessionStore: ISessionStore,
  token: string,
): Promise<AuthUser | null> {
  const tokenHash = hashToken(token);
  const session = await sessionStore.findValid(tokenHash);
  if (!session) return null;
  const user = await userStore.findById(session.userId);
  if (!user || user.disabled) return null;
  void Promise.resolve(sessionStore.touch(tokenHash)).catch(() => {});
  return user;
}
