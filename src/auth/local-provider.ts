import type { IUserStore } from './user-store.interface.ts';
import type { AuthUser } from './types.ts';

// Bun.password defaults to argon2id.
export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password);
}

// Verified against when the email is unknown, so a login attempt costs the
// same time whether or not the user exists (no user enumeration by timing).
const dummyHash = await Bun.password.hash('dummy-timing-equalizer');

/** Email + password → user, or null. Null for: unknown email, wrong password,
 *  disabled user, user without a password (EntraID-only later). */
export async function verifyLocalLogin(
  userStore: IUserStore,
  email: string,
  password: string,
): Promise<AuthUser | null> {
  const found = await userStore.findByEmail(email);
  if (!found || found.disabled || !found.passwordHash) {
    await Bun.password.verify(password, dummyHash).catch((err) => {
      console.error('[auth] timing equaliser failed; login timing may now reveal whether an account exists:', err);
    });
    return null;
  }
  const ok = await Bun.password.verify(password, found.passwordHash);
  if (!ok) return null;
  const { passwordHash: _, ...user } = found;
  return user;
}
