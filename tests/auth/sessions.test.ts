import { describe, test, expect } from 'bun:test';
import { generateToken, hashToken, createSession, resolveSession, SESSION_TTL_MS } from '../../src/auth/sessions.ts';
import { FakeUserStore, FakeSessionStore } from './fakes.ts';

describe('tokens', () => {
  test('generateToken returns long unique url-safe strings', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40); // 32 random bytes base64url
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('hashToken is deterministic sha-256 hex and differs from input', () => {
    const t = generateToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toBe(t);
  });
});

describe('session lifecycle', () => {
  test('createSession stores the HASH with a 30-day expiry, returns the raw token', async () => {
    const sessions = new FakeSessionStore();
    const { token, expiresAt } = await createSession(sessions, 7);
    expect(sessions.rows.has(token)).toBe(false); // raw token never stored
    expect(sessions.rows.has(hashToken(token))).toBe(true);
    const ttl = expiresAt.getTime() - Date.now();
    expect(ttl).toBeGreaterThan(SESSION_TTL_MS - 5_000);
    expect(ttl).toBeLessThanOrEqual(SESSION_TTL_MS);
  });

  test('resolveSession returns the user for a valid token', async () => {
    const users = new FakeUserStore();
    const sessions = new FakeSessionStore();
    const user = await users.create({ email: 'a@b.c', displayName: 'A', role: 'operator', passwordHash: null });
    const { token } = await createSession(sessions, user.id);
    const resolved = await resolveSession(users, sessions, token);
    expect(resolved?.email).toBe('a@b.c');
  });

  test('resolveSession rejects unknown, expired, and disabled', async () => {
    const users = new FakeUserStore();
    const sessions = new FakeSessionStore();
    const user = await users.create({ email: 'a@b.c', displayName: 'A', role: 'operator', passwordHash: null });

    expect(await resolveSession(users, sessions, 'no-such-token')).toBeNull();

    const { token: expired } = await createSession(sessions, user.id);
    sessions.rows.get(hashToken(expired))!.expiresAt = new Date(Date.now() - 1000);
    expect(await resolveSession(users, sessions, expired)).toBeNull();

    const { token } = await createSession(sessions, user.id);
    users.rows[0]!.disabled = true;
    expect(await resolveSession(users, sessions, token)).toBeNull();
  });
});
