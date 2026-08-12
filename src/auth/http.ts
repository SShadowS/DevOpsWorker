import type { IUserStore } from './user-store.interface.ts';
import type { ISessionStore } from './session-store.interface.ts';
import type { IAuthEventStore, AuthEventKind } from './auth-event-store.interface.ts';
import type { AuthUser } from './types.ts';
import type { LoginRateLimiter } from './rate-limit.ts';
import { createSession, resolveSession, hashToken } from './sessions.ts';
import { SESSION_COOKIE, parseCookies, sessionCookie, clearSessionCookie } from './cookies.ts';
import { verifyLocalLogin } from './local-provider.ts';

export interface AuthDeps {
  userStore: IUserStore;
  sessionStore: ISessionStore;
  rateLimiter: LoginRateLimiter;
  secureCookies: boolean;
  authEventStore: IAuthEventStore;
}

/** Best-effort: a logging failure must never stop someone logging in or out,
 *  so a rejection is swallowed here (after logging) rather than propagated. */
function recordAuthEvent(
  store: IAuthEventStore,
  event: { kind: AuthEventKind; email: string; ip: string | null; userId?: number | null },
): void {
  void store.write(event).catch((err) => {
    console.error('[auth] failed to record auth event:', err);
  });
}

function userJson(user: AuthUser): { email: string; displayName: string; role: string } {
  return { email: user.email, displayName: user.displayName, role: user.role };
}

/** Session cookie → user, or null. Never throws (fail closed → null). */
export async function authenticate(req: Request, deps: AuthDeps): Promise<AuthUser | null> {
  try {
    const token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE];
    if (!token) return null;
    return await resolveSession(deps.userStore, deps.sessionStore, token);
  } catch {
    return null;
  }
}

export async function handleLogin(req: Request, deps: AuthDeps, ip: string): Promise<Response> {
  let body: { email?: string; password?: string };
  try {
    body = (await req.json()) as { email?: string; password?: string };
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const email = body.email?.trim().toLowerCase();
  const password = body.password;
  if (!email || !password) {
    return Response.json({ error: 'Email and password are required' }, { status: 400 });
  }

  const key = `${email}|${ip}`;
  if (!deps.rateLimiter.check(key)) {
    recordAuthEvent(deps.authEventStore, { kind: 'login-locked-out', email, ip });
    return Response.json({ error: 'Too many failed attempts. Wait a minute and try again.' }, { status: 429 });
  }

  const user = await verifyLocalLogin(deps.userStore, email, password);
  if (!user) {
    deps.rateLimiter.recordFailure(key);
    // One outcome for every failure cause (unknown email, wrong password, disabled
    // user, password-less user) — do not split this by cause, in the event log or
    // anywhere else. That split is exactly the account-existence leak the uniform
    // 401 response exists to prevent.
    recordAuthEvent(deps.authEventStore, { kind: 'login-failed', email, ip });
    return Response.json({ error: 'Wrong email or password' }, { status: 401 });
  }

  deps.rateLimiter.recordSuccess(key);
  void Promise.resolve(deps.sessionStore.deleteExpired()).catch(() => {}); // opportunistic cleanup
  const { token, expiresAt } = await createSession(deps.sessionStore, user.id);
  recordAuthEvent(deps.authEventStore, { kind: 'login-success', email, ip, userId: user.id });
  return Response.json(userJson(user), {
    status: 200,
    headers: { 'Set-Cookie': sessionCookie(token, expiresAt, deps.secureCookies) },
  });
}

/** Sign-out is best-effort on the server-side cleanup: a database hiccup must
 *  never turn "log me out" into a 500 that leaves the browser still holding a
 *  cookie it believes is valid. Always clear the cookie and return 200. */
export async function handleLogout(req: Request, deps: AuthDeps, ip: string | null = null): Promise<Response> {
  const token = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE];
  if (token) {
    // Resolve who this is before the session is gone, so the event can carry
    // an email. A bogus/expired token resolves to null — nothing to log.
    const user = await authenticate(req, deps);
    await deps.sessionStore.delete(hashToken(token)).catch((err) => {
      console.error('[auth] failed to delete session on logout; cookie is cleared anyway:', err);
    });
    if (user) recordAuthEvent(deps.authEventStore, { kind: 'logout', email: user.email, ip, userId: user.id });
  }
  return Response.json({ ok: true }, { headers: { 'Set-Cookie': clearSessionCookie(deps.secureCookies) } });
}

export function handleMe(user: AuthUser): Response {
  return Response.json(userJson(user));
}

/** Public: lets the login page say "no users yet — create one with the CLI". */
export async function handleAuthStatus(deps: AuthDeps): Promise<Response> {
  const count = await deps.userStore.count();
  return Response.json({ usersExist: count > 0 });
}

/** Cross-origin write protection on top of SameSite=Lax: when a browser sends
 *  an Origin header, its host must match ours. Requests without Origin (curl,
 *  scripts) pass — they carry no ambient browser credentials. */
export function originAllowed(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  const host = req.headers.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
