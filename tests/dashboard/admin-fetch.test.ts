import { describe, test, expect, afterEach } from 'bun:test';
import { adminFetch } from '../../src/dashboard/client/admin-fetch.ts';
import { currentUser } from '../../src/dashboard/client/store.ts';
import type { CurrentUser } from '../../src/dashboard/client/store.ts';

// ---------------------------------------------------------------------------
// Repo-standard globalThis.fetch replacement, restored in afterEach — no
// mock.module(). currentUser is a process-global signal other test files may
// also touch, so it gets the same snapshot/restore treatment (see
// tests/config/hydrate.test.ts / tests/dashboard/auth-gate.test.ts for the
// established pattern with repos/companions).
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
const userSnapshot = currentUser.value;

afterEach(() => {
  globalThis.fetch = realFetch;
  currentUser.value = userSnapshot;
});

function mockFetchJson(status: number, body: unknown): void {
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;
}

function mockFetchRaw(status: number, text: string): void {
  globalThis.fetch = (() =>
    Promise.resolve(new Response(text, { status }))) as unknown as typeof fetch;
}

const ADMIN: CurrentUser = { email: 'admin@x.y', displayName: 'Admin', role: 'admin' };
const OPERATOR: CurrentUser = { email: 'op@x.y', displayName: 'Op', role: 'operator' };

describe('adminFetch', () => {
  test('a 200 returns parsed JSON', async () => {
    mockFetchJson(200, { hello: 'world' });
    const result = await adminFetch('/api/admin/repos');
    expect(result).toEqual({ ok: true, data: { hello: 'world' } });
  });

  test('a 401 sets currentUser to null — the login drop, matching pollRunners', async () => {
    currentUser.value = ADMIN;
    mockFetchJson(401, { error: 'unauthorized' });

    const result = await adminFetch('/api/admin/repos');

    expect(result.ok).toBe(false);
    expect(currentUser.value).toBeNull();
  });

  test('a 403 surfaces a distinct admin-only message and leaves currentUser untouched', async () => {
    currentUser.value = OPERATOR;
    mockFetchJson(403, { error: 'forbidden' });

    const result = await adminFetch('/api/admin/repos');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message.toLowerCase()).toContain('admin');
    }
    // The easy half to get wrong: 403 means authenticated but wrong role —
    // logging the user out would be both incorrect and confusing.
    expect(currentUser.value).toEqual(OPERATOR);
  });

  test('an {errors:[...]} body comes back as a structured list', async () => {
    mockFetchJson(400, {
      errors: [
        { path: 'layout.appRoot', message: 'Required' },
        { path: '(root)', message: 'Expected an object' },
      ],
    });

    const result = await adminFetch('/api/admin/repos/x');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        { path: 'layout.appRoot', message: 'Required' },
        { path: '(root)', message: 'Expected an object' },
      ]);
    }
  });

  test('an {error:"..."} body comes back as a single message', async () => {
    mockFetchJson(404, { error: 'No repo registered under "x"' });

    const result = await adminFetch('/api/admin/repos/x');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe('No repo registered under "x"');
      expect(result.errors).toEqual([]);
    }
  });

  test('a non-JSON error body still produces a usable message rather than throwing', async () => {
    mockFetchRaw(500, 'Internal Server Error');

    const result = await adminFetch('/api/admin/repos');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.errors).toEqual([]);
    }
  });

  test('a rejected fetch produces a message rather than an unhandled rejection', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('network down'))) as unknown as typeof fetch;

    const result = await adminFetch('/api/admin/repos');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});
