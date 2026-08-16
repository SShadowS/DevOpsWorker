import { describe, test, expect } from 'bun:test';
import { getRouteParams, parseEnumParam, updateRouteParams } from '../../src/dashboard/client/url-route.ts';

// ---------------------------------------------------------------------------
// url-route.ts — the generic hash-param read/write behind the
// arrival-efficiency fix (deep links to the Stats & Config tab's exact
// section/window/population, plus the app-tab switcher). No DOM exists in
// this test runtime (`typeof location === 'undefined'`, verified directly —
// see the module's own guards), which doubles as the test for "safe outside
// a browser": every function here must degrade gracefully rather than throw
// when `location`/`history` are missing, and that is exactly the
// environment these tests already run in.
// ---------------------------------------------------------------------------

describe('getRouteParams — outside a browser', () => {
  test('returns an empty bag rather than throwing when location is undefined', () => {
    expect(typeof location).toBe('undefined');
    const params = getRouteParams();
    expect(params.toString()).toBe('');
    expect(params.get('anything')).toBeNull();
  });
});

describe('updateRouteParams — outside a browser', () => {
  test('no-ops rather than throwing when history/location are undefined', () => {
    expect(typeof history).toBe('undefined');
    expect(() => updateRouteParams({ view: 'stats' })).not.toThrow();
    expect(() => updateRouteParams({ view: 'stats' }, { push: true })).not.toThrow();
  });
});

describe('parseEnumParam', () => {
  const COLORS = ['red', 'green', 'blue'] as const;

  test('a valid value round-trips', () => {
    const params = new URLSearchParams('color=green');
    expect(parseEnumParam(params, 'color', COLORS)).toBe('green');
  });

  test('a missing key returns null, not a default', () => {
    const params = new URLSearchParams('other=1');
    expect(parseEnumParam(params, 'color', COLORS)).toBeNull();
  });

  test('an unrecognised value returns null rather than throwing', () => {
    const params = new URLSearchParams('color=chartreuse');
    expect(parseEnumParam(params, 'color', COLORS)).toBeNull();
  });

  test('an empty value returns null', () => {
    const params = new URLSearchParams('color=');
    expect(parseEnumParam(params, 'color', COLORS)).toBeNull();
  });

  test('garbage query strings never throw — URLSearchParams itself is total', () => {
    const inputs = ['???', '===', '&&&&', '%zz', 'color=green&color=blue', 'a=b=c=d'];
    for (const raw of inputs) {
      expect(() => new URLSearchParams(raw)).not.toThrow();
      expect(() => parseEnumParam(new URLSearchParams(raw), 'color', COLORS)).not.toThrow();
    }
  });

  test('repeated keys: URLSearchParams.get takes the first occurrence', () => {
    const params = new URLSearchParams('color=green&color=blue');
    expect(parseEnumParam(params, 'color', COLORS)).toBe('green');
  });
});
