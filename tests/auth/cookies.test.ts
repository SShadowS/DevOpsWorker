import { describe, test, expect } from 'bun:test';
import { SESSION_COOKIE, parseCookies, sessionCookie, clearSessionCookie } from '../../src/auth/cookies.ts';

describe('parseCookies', () => {
  test('parses a normal header', () => {
    expect(parseCookies('a=1; dw_session=tok-en_A; b=2')).toEqual({ a: '1', dw_session: 'tok-en_A', b: '2' });
  });
  test('handles null, empty, and malformed pairs', () => {
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies('')).toEqual({});
    expect(parseCookies('noequals; =bare; ok=yes')).toEqual({ ok: 'yes' });
  });
});

describe('sessionCookie', () => {
  const expires = new Date('2027-01-01T00:00:00Z');
  test('sets the required flags', () => {
    const c = sessionCookie('tok', expires, false);
    expect(c).toContain(`${SESSION_COOKIE}=tok`);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/');
    expect(c).toContain(`Expires=${expires.toUTCString()}`);
    expect(c).not.toContain('Secure');
  });
  test('adds Secure when asked', () => {
    expect(sessionCookie('tok', expires, true)).toContain('Secure');
  });
  test('clearSessionCookie expires the cookie', () => {
    const c = clearSessionCookie(false);
    expect(c).toContain(`${SESSION_COOKIE}=`);
    expect(c).toContain('Expires=Thu, 01 Jan 1970');
  });
});
