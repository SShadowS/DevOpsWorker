import { describe, test, expect, beforeEach } from 'bun:test';
import { authenticate, type AuthDeps } from '../../src/auth/http.ts';
import { LoginRateLimiter } from '../../src/auth/rate-limit.ts';
import { FakeUserStore, FakeSessionStore, FakeAuthEventStore } from './fakes.ts';

// Edge sign-in: Caddy + oauth2-proxy already signed the person in with Entra ID and
// pass their email in X-Auth-Request-Email. The dashboard trusts it only together
// with X-Edge-Secret, which only Caddy knows.

const SECRET = 'edge-secret-0123456789';

function req(headers: Record<string, string>): Request {
  return new Request('http://dash.local/api/pipelines', { headers });
}

let userStore: FakeUserStore;
let deps: AuthDeps;

beforeEach(async () => {
  userStore = new FakeUserStore();
  await userStore.create({ email: 'boss@example.com', displayName: 'Boss', role: 'admin', passwordHash: null });
  deps = {
    userStore, sessionStore: new FakeSessionStore(), rateLimiter: new LoginRateLimiter(),
    secureCookies: true, authEventStore: new FakeAuthEventStore(), edgeAuthSecret: SECRET,
  };
});

describe('authenticate via the edge', () => {
  test('a first-time signed-in user gets an operator account', async () => {
    const user = await authenticate(req({ 'x-edge-secret': SECRET, 'x-auth-request-email': 'New.Person@Example.com' }), deps);
    expect(user).toMatchObject({ email: 'new.person@example.com', role: 'operator', disabled: false });
    expect(userStore.rows.filter((r) => r.email === 'new.person@example.com')).toHaveLength(1);
    expect(userStore.rows.find((r) => r.email === 'new.person@example.com')!.passwordHash).toBeNull();
  });

  test('a second visit reuses the account instead of creating another', async () => {
    const h = { 'x-edge-secret': SECRET, 'x-auth-request-email': 'new.person@example.com' };
    const first = await authenticate(req(h), deps);
    const second = await authenticate(req(h), deps);
    expect(second!.id).toBe(first!.id);
    expect(userStore.rows.filter((r) => r.email === 'new.person@example.com')).toHaveLength(1);
  });

  test('an existing account keeps its role', async () => {
    const user = await authenticate(req({ 'x-edge-secret': SECRET, 'x-auth-request-email': 'boss@example.com' }), deps);
    expect(user!.role).toBe('admin');
  });

  test('a disabled account is refused', async () => {
    await userStore.setDisabled(1, true);
    expect(await authenticate(req({ 'x-edge-secret': SECRET, 'x-auth-request-email': 'boss@example.com' }), deps)).toBeNull();
  });

  test('the email header alone is not trusted', async () => {
    expect(await authenticate(req({ 'x-auth-request-email': 'boss@example.com' }), deps)).toBeNull();
    expect(await authenticate(req({ 'x-edge-secret': 'wrong', 'x-auth-request-email': 'boss@example.com' }), deps)).toBeNull();
    expect(userStore.rows).toHaveLength(1);
  });

  test('without a configured secret the headers are ignored entirely', async () => {
    const noEdge = { ...deps, edgeAuthSecret: undefined };
    expect(await authenticate(req({ 'x-edge-secret': '', 'x-auth-request-email': 'boss@example.com' }), noEdge)).toBeNull();
    expect(await authenticate(req({ 'x-edge-secret': SECRET, 'x-auth-request-email': 'x@example.com' }), noEdge)).toBeNull();
  });

  test('a malformed email is refused', async () => {
    for (const email of ['', 'no-at-sign', `${'a'.repeat(250)}@example.com`]) {
      expect(await authenticate(req({ 'x-edge-secret': SECRET, 'x-auth-request-email': email }), deps)).toBeNull();
    }
  });
});
