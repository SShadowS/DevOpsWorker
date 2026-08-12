import { describe, test, expect, beforeEach } from 'bun:test';
import { handleLogin, handleLogout, type AuthDeps } from '../../src/auth/http.ts';
import { hashPassword } from '../../src/auth/local-provider.ts';
import { LoginRateLimiter } from '../../src/auth/rate-limit.ts';
import { SESSION_COOKIE } from '../../src/auth/cookies.ts';
import { FakeUserStore, FakeSessionStore, FakeAuthEventStore } from './fakes.ts';

function loginReq(body: unknown): Request {
  return new Request('http://dash.local/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let deps: AuthDeps;
let events: FakeAuthEventStore;

beforeEach(async () => {
  const userStore = new FakeUserStore();
  await userStore.create({ email: 'op@x.y', displayName: 'Op', role: 'operator', passwordHash: await hashPassword('correct-horse-battery') });
  events = new FakeAuthEventStore();
  deps = {
    userStore,
    sessionStore: new FakeSessionStore(),
    rateLimiter: new LoginRateLimiter(),
    secureCookies: false,
    authEventStore: events,
  };
});

describe('login/logout event recording', () => {
  test('a good login writes exactly one login-success carrying the user id', async () => {
    const res = await handleLogin(loginReq({ email: 'op@x.y', password: 'correct-horse-battery' }), deps, '1.1.1.1');
    expect(res.status).toBe(200);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ kind: 'login-success', email: 'op@x.y', ip: '1.1.1.1' });
    expect(events.rows[0]!.userId).not.toBeNull();
    expect(events.rows[0]!.userId).not.toBeUndefined();
  });

  test('a bad password writes login-failed', async () => {
    const res = await handleLogin(loginReq({ email: 'op@x.y', password: 'nope' }), deps, '1.1.1.1');
    expect(res.status).toBe(401);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ kind: 'login-failed', email: 'op@x.y', ip: '1.1.1.1' });
  });

  test('an unknown email writes login-failed with the attempted email, and the response is identical to the bad-password case', async () => {
    const badPassword = await handleLogin(loginReq({ email: 'op@x.y', password: 'nope' }), deps, '1.1.1.1');
    const unknownEmailDeps: AuthDeps = { ...deps, userStore: new FakeUserStore(), authEventStore: new FakeAuthEventStore() };
    const unknownEmail = await handleLogin(loginReq({ email: 'ghost@x.y', password: 'nope' }), unknownEmailDeps, '1.1.1.1');

    expect(unknownEmail.status).toBe(badPassword.status);
    expect(await unknownEmail.json()).toEqual(await badPassword.json());
    expect([...unknownEmail.headers.entries()].sort()).toEqual([...badPassword.headers.entries()].sort());

    const recorded = (unknownEmailDeps.authEventStore as FakeAuthEventStore).rows;
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ kind: 'login-failed', email: 'ghost@x.y' });
  });

  test('the sixth attempt writes login-locked-out', async () => {
    for (let i = 0; i < 5; i++) {
      await handleLogin(loginReq({ email: 'op@x.y', password: 'nope' }), deps, '9.9.9.9');
    }
    events.rows = []; // isolate the 6th attempt's write from the first 5 failures
    const res = await handleLogin(loginReq({ email: 'op@x.y', password: 'correct-horse-battery' }), deps, '9.9.9.9');
    expect(res.status).toBe(429);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ kind: 'login-locked-out', email: 'op@x.y', ip: '9.9.9.9' });
  });

  test('logout writes logout', async () => {
    const login = await handleLogin(loginReq({ email: 'op@x.y', password: 'correct-horse-battery' }), deps, '1.1.1.1');
    const token = /dw_session=([^;]+)/.exec(login.headers.get('Set-Cookie')!)![1]!;
    const req = new Request('http://dash.local/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE}=${token}` },
    });

    events.rows = []; // isolate the logout write from the preceding login-success
    const res = await handleLogout(req, deps);
    expect(res.status).toBe(200);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ kind: 'logout', email: 'op@x.y' });
  });

  test('no recorded event anywhere contains the password', async () => {
    await handleLogin(loginReq({ email: 'op@x.y', password: 'correct-horse-battery' }), deps, '1.1.1.1');
    await handleLogin(loginReq({ email: 'op@x.y', password: 'super-secret-password' }), deps, '1.1.1.1');
    const serialized = JSON.stringify(events.rows);
    expect(serialized).not.toContain('correct-horse-battery');
    expect(serialized).not.toContain('super-secret-password');
  });

  test('a store whose write rejects still lets login succeed with a 200 and a cookie', async () => {
    events.write = () => Promise.reject(new Error('db unreachable'));
    const res = await handleLogin(loginReq({ email: 'op@x.y', password: 'correct-horse-battery' }), deps, '1.1.1.1');
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toContain(`${SESSION_COOKIE}=`);
  });
});

describe('login request size caps', () => {
  test('an over-long email is 400, writes no event, and never reaches the rate limiter or user store', async () => {
    deps.rateLimiter.check = () => { throw new Error('rate limiter must not be consulted'); };
    deps.userStore.findByEmail = () => { throw new Error('user store must not be consulted'); };
    const res = await handleLogin(
      loginReq({ email: `${'a'.repeat(255)}@x.y`, password: 'correct-horse-battery' }),
      deps,
      '1.1.1.1',
    );
    expect(res.status).toBe(400);
    expect(events.rows).toHaveLength(0);
  });

  test('an over-long password is 400, writes no event, and never reaches the rate limiter or user store', async () => {
    deps.rateLimiter.check = () => { throw new Error('rate limiter must not be consulted'); };
    deps.userStore.findByEmail = () => { throw new Error('user store must not be consulted'); };
    const res = await handleLogin(loginReq({ email: 'op@x.y', password: 'a'.repeat(1025) }), deps, '1.1.1.1');
    expect(res.status).toBe(400);
    expect(events.rows).toHaveLength(0);
  });

  test('over-long-email, over-long-password, and missing-field 400s are byte-identical', async () => {
    const missing = await handleLogin(loginReq({ email: 'op@x.y' }), deps, '1.1.1.1');
    const longEmail = await handleLogin(
      loginReq({ email: `${'a'.repeat(255)}@x.y`, password: 'correct-horse-battery' }),
      deps,
      '1.1.1.1',
    );
    const longPassword = await handleLogin(loginReq({ email: 'op@x.y', password: 'a'.repeat(1025) }), deps, '1.1.1.1');

    const missingStatus = missing.status;
    const missingBody = await missing.json();
    const missingHeaders = [...missing.headers.entries()].sort();
    for (const res of [longEmail, longPassword]) {
      expect(res.status).toBe(missingStatus);
      expect(await res.json()).toEqual(missingBody);
      expect([...res.headers.entries()].sort()).toEqual(missingHeaders);
    }
  });

  test('a normal-length email and password still log in exactly as before', async () => {
    const res = await handleLogin(loginReq({ email: 'op@x.y', password: 'correct-horse-battery' }), deps, '1.1.1.1');
    expect(res.status).toBe(200);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ kind: 'login-success', email: 'op@x.y' });
  });
});
