import { describe, test, expect } from 'bun:test';
import { routeRules, requiredAccess } from '../../src/auth/route-access.ts';

describe('route access (pinned invariant)', () => {
  // PINNED: the exact set of unauthenticated routes. Adding a public route
  // means editing this list deliberately — never by accident.
  test('the public surface is exactly the login endpoint, auth status, and the static shell', () => {
    const publicRules = routeRules
      .filter((r) => r.access === 'public')
      .map((r) => `${r.method} ${r.pattern.source}`)
      .sort();
    expect(publicRules).toEqual([
      'GET ^\\/(bundle|index)\\.js$',
      'GET ^\\/(index\\.html)?$',
      'GET ^\\/api\\/auth\\/status$',
      'GET ^\\/dashboard\\.css$',
      'POST ^\\/api\\/auth\\/login$',
    ].sort());
  });

  test('static shell and login are public', () => {
    expect(requiredAccess('GET', '/')).toBe('public');
    expect(requiredAccess('GET', '/index.html')).toBe('public');
    expect(requiredAccess('GET', '/bundle.js')).toBe('public');
    expect(requiredAccess('GET', '/index.js')).toBe('public');
    expect(requiredAccess('GET', '/dashboard.css')).toBe('public');
    expect(requiredAccess('POST', '/api/auth/login')).toBe('public');
    expect(requiredAccess('GET', '/api/auth/status')).toBe('public');
  });

  test('data and action routes need an operator', () => {
    expect(requiredAccess('GET', '/api/sessions')).toBe('operator');
    expect(requiredAccess('GET', '/api/events')).toBe('operator');
    expect(requiredAccess('POST', '/api/actions')).toBe('operator');
    expect(requiredAccess('POST', '/api/learn-rules')).toBe('operator');
    expect(requiredAccess('GET', '/api/auth/me')).toBe('operator');
    expect(requiredAccess('POST', '/api/auth/logout')).toBe('operator');
  });

  test('global mutations need an admin', () => {
    expect(requiredAccess('POST', '/api/runners')).toBe('admin');
    expect(requiredAccess('GET', '/api/runners')).toBe('operator'); // reading is fine
  });

  test('DEFAULT-DENY: routes nobody declared require auth', () => {
    expect(requiredAccess('GET', '/api/some-future-endpoint')).toBe('operator');
    expect(requiredAccess('POST', '/anything/else')).toBe('operator');
    // GET on login path (wrong method for the rule) is NOT public:
    expect(requiredAccess('GET', '/api/auth/login')).toBe('operator');
  });
});
