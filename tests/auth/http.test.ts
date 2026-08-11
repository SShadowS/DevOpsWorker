import { describe, test, expect, beforeEach } from 'bun:test';
import { handleLogin, handleLogout, handleMe, handleAuthStatus, authenticate, originAllowed, type AuthDeps } from '../../src/auth/http.ts';
import { hashPassword } from '../../src/auth/local-provider.ts';
import { LoginRateLimiter } from '../../src/auth/rate-limit.ts';
import { SESSION_COOKIE } from '../../src/auth/cookies.ts';
import { FakeUserStore, FakeSessionStore } from './fakes.ts';

function loginReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://dash.local/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

let deps: AuthDeps;

beforeEach(async () => {
  const userStore = new FakeUserStore();
  await userStore.create({ email: 'op@x.y', displayName: 'Op', role: 'operator', passwordHash: await hashPassword('correct-horse-battery') });
  deps = { userStore, sessionStore: new FakeSessionStore(), rateLimiter: new LoginRateLimiter(), secureCookies: false };
});

describe('handleLogin', () => {
  test('success sets the session cookie and returns the user', async () => {
    const res = await handleLogin(loginReq({ email: 'OP@x.y', password: 'correct-horse-battery' }), deps, '1.1.1.1');
    expect(res.status).toBe(200);
    const cookie = res.headers.get('Set-Cookie')!;
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain('HttpOnly');
    expect(await res.json()).toEqual({ email: 'op@x.y', displayName: 'Op', role: 'operator' });
  });

  test('wrong password is 401 with a plain-English error and no cookie', async () => {
    const res = await handleLogin(loginReq({ email: 'op@x.y', password: 'nope' }), deps, '1.1.1.1');
    expect(res.status).toBe(401);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(((await res.json()) as { error: string }).error).toBe('Wrong email or password');
  });

  test('missing fields are 400; garbage body is 400', async () => {
    expect((await handleLogin(loginReq({ email: 'op@x.y' }), deps, '1.1.1.1')).status).toBe(400);
    const bad = new Request('http://dash.local/api/auth/login', { method: 'POST', body: 'not json' });
    expect((await handleLogin(bad, deps, '1.1.1.1')).status).toBe(400);
  });

  test('6th failed attempt from the same email+ip is 429', async () => {
    for (let i = 0; i < 5; i++) {
      await handleLogin(loginReq({ email: 'op@x.y', password: 'nope' }), deps, '9.9.9.9');
    }
    const res = await handleLogin(loginReq({ email: 'op@x.y', password: 'correct-horse-battery' }), deps, '9.9.9.9');
    expect(res.status).toBe(429);
    // …but a different IP still works:
    const other = await handleLogin(loginReq({ email: 'op@x.y', password: 'correct-horse-battery' }), deps, '2.2.2.2');
    expect(other.status).toBe(200);
  });
});

describe('authenticate + logout + me + status', () => {
  test('cookie from login authenticates; logout kills the session', async () => {
    const login = await handleLogin(loginReq({ email: 'op@x.y', password: 'correct-horse-battery' }), deps, '1.1.1.1');
    const token = /dw_session=([^;]+)/.exec(login.headers.get('Set-Cookie')!)![1]!;
    const authed = new Request('http://dash.local/api/sessions', { headers: { Cookie: `${SESSION_COOKIE}=${token}` } });

    const user = await authenticate(authed, deps);
    expect(user?.email).toBe('op@x.y');
    expect(handleMe(user!).status).toBe(200);

    const out = await handleLogout(authed, deps);
    expect(out.status).toBe(200);
    expect(out.headers.get('Set-Cookie')).toContain('Expires=Thu, 01 Jan 1970');
    expect(await authenticate(authed, deps)).toBeNull();
  });

  test('no cookie / bogus cookie → null', async () => {
    expect(await authenticate(new Request('http://d/api/sessions'), deps)).toBeNull();
    const bogus = new Request('http://d/api/sessions', { headers: { Cookie: `${SESSION_COOKIE}=fabricated` } });
    expect(await authenticate(bogus, deps)).toBeNull();
  });

  test('logout still clears the cookie and returns 200 when the store delete fails', async () => {
    const login = await handleLogin(loginReq({ email: 'op@x.y', password: 'correct-horse-battery' }), deps, '1.1.1.1');
    const token = /dw_session=([^;]+)/.exec(login.headers.get('Set-Cookie')!)![1]!;
    const authed = new Request('http://dash.local/api/sessions', { headers: { Cookie: `${SESSION_COOKIE}=${token}` } });

    deps.sessionStore.delete = () => Promise.reject(new Error('db unreachable'));
    const out = await handleLogout(authed, deps);

    expect(out.status).toBe(200);
    expect(out.headers.get('Set-Cookie')).toContain('Expires=Thu, 01 Jan 1970');
  });

  test('status reports whether any user exists', async () => {
    expect(await (await handleAuthStatus(deps)).json()).toEqual({ usersExist: true });
    expect(await (await handleAuthStatus({ ...deps, userStore: new FakeUserStore() })).json()).toEqual({ usersExist: false });
  });
});

describe('originAllowed', () => {
  const req = (headers: Record<string, string>) => new Request('http://dash.local/api/actions', { method: 'POST', headers });
  test('no Origin header is allowed (curl, same-origin GET-initiated)', () => {
    expect(originAllowed(req({ host: 'dash.local' }))).toBe(true);
  });
  test('matching Origin allowed, foreign Origin rejected, garbage rejected', () => {
    expect(originAllowed(req({ host: 'dash.local:3000', origin: 'http://dash.local:3000' }))).toBe(true);
    expect(originAllowed(req({ host: 'dash.local', origin: 'http://evil.example' }))).toBe(false);
    expect(originAllowed(req({ host: 'dash.local', origin: '::::' }))).toBe(false);
  });
});
