import { describe, test, expect, afterEach } from 'bun:test';
import {
  openLogViewer, openPrReviewLogViewer, activeLogViewer, logStages,
} from '../../src/dashboard/client/store.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function jsonRes(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), { status: ok ? 200 : 404 });
}

describe('log-viewer store', () => {
  test('a 404 stages response does not become logStages', async () => {
    globalThis.fetch = ((..._a: unknown[]) =>
      Promise.resolve(jsonRes({ error: 'Not found' }, false))) as unknown as typeof fetch;
    await openPrReviewLogViewer(7, 4821);
    expect(Array.isArray(logStages.value)).toBe(true);
    expect(logStages.value).toEqual([]);
  });

  test('a late response from a superseded open does not overwrite the newer viewer', async () => {
    let resolveA!: (r: Response) => void;
    const aPending = new Promise<Response>((res) => { resolveA = res; });
    // First open (session A) hangs on its stages fetch.
    globalThis.fetch = (() => aPending) as unknown as typeof fetch;
    const openA = openLogViewer(123);
    // Second open (pr-review B) resolves immediately with its own stages.
    globalThis.fetch = ((..._a: unknown[]) =>
      Promise.resolve(jsonRes(['stage-b']))) as unknown as typeof fetch;
    await openPrReviewLogViewer(7, 4821);
    // Now let A's stale response land.
    resolveA(jsonRes(['stage-a']));
    await openA;
    expect(activeLogViewer.value?.kind).toBe('pr-review');
    expect(logStages.value).not.toContain('stage-a');
  });
});
