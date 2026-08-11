import { currentUser } from './store.ts';
import type { CurrentUser } from './store.ts';

export async function checkAuth(): Promise<void> {
  try {
    const res = await fetch('/api/auth/me');
    currentUser.value = res.ok ? ((await res.json()) as CurrentUser) : null;
  } catch {
    currentUser.value = null;
  }
}

/** Returns an error message to show, or null on success. On success the page
 *  reloads so the normal boot path runs with the fresh session. */
export async function login(email: string, password: string): Promise<string | null> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (res.ok) {
    location.reload();
    return null;
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? 'Login failed';
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.reload();
}
