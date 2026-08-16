import { describe, test, expect, afterEach } from 'bun:test';
import {
  classifyWindowedResponse, classifyDriftResponse,
  loadStatsForWindow, loadConfigReport, statsPopulation,
  parseStatsSection, parseStatsWindow, parseStatsPopulation,
  buildPanelHref, navigateToPanel,
} from '../../src/dashboard/client/stats-store.ts';
import type { DriftStats } from '../../src/dashboard/stats.ts';

describe('classifyWindowedResponse', () => {
  test('sampleSize 0 -> empty (no data in this window, not an error)', () => {
    const result = classifyWindowedResponse({ sampleSize: 0, foo: 'bar' });
    expect(result).toEqual({ status: 'empty' });
  });

  test('sampleSize > 0 -> ready, carrying the full payload', () => {
    const data = { sampleSize: 5, foo: 'bar' };
    const result = classifyWindowedResponse(data);
    expect(result).toEqual({ status: 'ready', data });
  });

  test('does not mutate or drop fields on the ready path', () => {
    const data = { sampleSize: 1, nested: { a: 1 }, list: [1, 2, 3] };
    const result = classifyWindowedResponse(data);
    expect(result).toEqual({ status: 'ready', data });
    if (result.status === 'ready') {
      expect(result.data).toBe(data); // same reference — no cloning
    }
  });
});

// Fixture matching the real DriftStats shape (src/dashboard/stats.ts), so this
// test breaks if the response shape drifts rather than silently going stale.
function driftFixture(sampleSize: number): DriftStats {
  return {
    window: '7d',
    windowDays: 7,
    since: '2026-01-01T00:00:00.000Z',
    sampleSize,
    lowSample: sampleSize < 10,
    head: { value: '8129ee0', reason: null },
    composeService: { value: 'abc123', classification: 'sha', source: 'BUILD_SHA env var', commitsBehindHead: 2 },
    spawnedImage: {
      mostRecentSha: { value: null, classification: 'not-recorded', recordedAt: null, commitsBehindHead: null },
      distribution: [],
    },
    provenanceRecorded: false,
  };
}

describe('classifyDriftResponse', () => {
  // The whole point of Finding 1 (fix round 1): drift must NOT collapse to
  // 'empty' at sampleSize 0 the way every other windowed endpoint does —
  // head/composeService/mostRecentSha are unwindowed, and a zero-review
  // window's distribution is itself an informative reading, not a blank.
  test('sampleSize 0 -> still ready, never empty', () => {
    const data = driftFixture(0);
    expect(classifyDriftResponse(data)).toEqual({ status: 'ready', data });
  });

  test('sampleSize > 0 -> also ready (same rule regardless of sample size)', () => {
    const data = driftFixture(42);
    expect(classifyDriftResponse(data)).toEqual({ status: 'ready', data });
  });

  test('never returns an empty status for any sample size', () => {
    for (const n of [0, 1, 10, 1000]) {
      expect(classifyDriftResponse(driftFixture(n)).status).not.toBe('empty');
    }
  });
});

// ---------------------------------------------------------------------------
// loadStatsForWindow — the actual query strings it builds. The tests above
// only exercise the pure classify functions, so nothing pinned the fetch URLs
// themselves: dropping `&population=${population}` from the four stats
// fetches, or having the ribbon's dedicated integrity re-fetch follow the
// toggle instead of staying prod-pinned, would both leave every existing
// guard (parsePopulation, the per-query `is_test` predicate tests,
// pickPopulationMeta) green while the Prod/Test toggle silently did nothing.
// Repo-standard globalThis.fetch replacement, restored in afterEach — no
// mock.module(), no DB.
// ---------------------------------------------------------------------------

describe('loadStatsForWindow — population query string', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    statsPopulation.value = 'prod';
  });

  /** Records every fetched URL and returns a minimal valid body — sampleSize: 0
   *  satisfies classifyWindowedResponse for the four stats endpoints; drift and
   *  config never inspect the body's shape before storing it. */
  function captureFetchUrls(): string[] {
    const urls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(new Response(JSON.stringify({ sampleSize: 0 })));
    }) as unknown as typeof fetch;
    return urls;
  }

  test('population=test: the 4 stats endpoints carry population=test, the ribbon integrity fetch stays pinned to population=prod, and drift/config carry no population param at all', async () => {
    statsPopulation.value = 'test';
    const urls = captureFetchUrls();

    await Promise.all([loadStatsForWindow('30d'), loadConfigReport()]);

    expect(urls).toContain('/api/stats/cost?window=30d&population=test');
    expect(urls).toContain('/api/stats/quality?window=30d&population=test');
    expect(urls).toContain('/api/stats/integrity?window=30d&population=test');
    expect(urls).toContain('/api/stats/operational?window=30d&population=test');

    // The ribbon's dedicated re-fetch — must stay prod-pinned even though the
    // toggle is on 'test'. If the ribbon ever followed the toggle instead,
    // this exact URL would never be requested and this assertion fails.
    expect(urls).toContain('/api/stats/integrity?window=30d&population=prod');

    // Population-independent by design (Task 3 left these two untouched) —
    // neither may carry the parameter under any toggle state.
    const driftUrl = urls.find((u) => u.startsWith('/api/drift'));
    expect(driftUrl).toBe('/api/drift?window=30d');
    expect(driftUrl).not.toContain('population');

    const configUrl = urls.find((u) => u.startsWith('/api/config'));
    expect(configUrl).toBe('/api/config');
    expect(configUrl).not.toContain('population');
  });
});

// ---------------------------------------------------------------------------
// URL-route parsers (arrival-efficiency fix) — pure, total. Each must return
// `null` for an absent OR unrecognised param rather than a hardcoded
// default, so a caller can tell "the URL said nothing" from "the URL said
// something" and fall back accordingly (see this file's own `initialSection`
// for the one case that actually branches on this: URL wins, then
// localStorage, then a hardcoded default).
// ---------------------------------------------------------------------------

describe('parseStatsSection', () => {
  test('a valid section round-trips', () => {
    expect(parseStatsSection(new URLSearchParams('section=reflection'))).toBe('reflection');
  });

  test('absent -> null', () => {
    expect(parseStatsSection(new URLSearchParams(''))).toBeNull();
  });

  test('unrecognised value -> null, never a thrown error', () => {
    expect(parseStatsSection(new URLSearchParams('section=bogus'))).toBeNull();
  });
});

describe('parseStatsWindow', () => {
  test('every real window value round-trips', () => {
    expect(parseStatsWindow(new URLSearchParams('window=7d'))).toBe('7d');
    expect(parseStatsWindow(new URLSearchParams('window=30d'))).toBe('30d');
    expect(parseStatsWindow(new URLSearchParams('window=90d'))).toBe('90d');
  });

  test('absent -> null', () => {
    expect(parseStatsWindow(new URLSearchParams(''))).toBeNull();
  });

  test('a garbage window -> null, not a silent fallback to 30d here', () => {
    // The 30d fallback is the CALLER's decision (stats-store.ts's hardcoded
    // signal default) — this function only reports what the URL said.
    expect(parseStatsWindow(new URLSearchParams('window=next-quarter'))).toBeNull();
  });
});

describe('parseStatsPopulation', () => {
  test('both real population values round-trip', () => {
    expect(parseStatsPopulation(new URLSearchParams('population=prod'))).toBe('prod');
    expect(parseStatsPopulation(new URLSearchParams('population=test'))).toBe('test');
  });

  test('absent -> null', () => {
    expect(parseStatsPopulation(new URLSearchParams(''))).toBeNull();
  });

  test('an unrecognised population -> null', () => {
    expect(parseStatsPopulation(new URLSearchParams('population=staging'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildPanelHref — the readability review's rank #2 fix (the dead
// `#stats-slot-integrity` cross-section anchor). Pure: takes the current
// params as an argument rather than reading `location` itself, so it is
// testable the same way the parsers above are, with a plain URLSearchParams
// fixture and no DOM.
// ---------------------------------------------------------------------------

describe('buildPanelHref', () => {
  test('an empty current URL -> a hash carrying only section and anchor', () => {
    const href = buildPanelHref(new URLSearchParams(''), 'health', 'stats-slot-integrity');
    const params = new URLSearchParams(href.slice(1));
    expect(params.get('section')).toBe('health');
    expect(params.get('anchor')).toBe('stats-slot-integrity');
  });

  test('preserves every other param already on the URL (view, window, population)', () => {
    const current = new URLSearchParams('view=stats&section=config&window=7d&population=test');
    const href = buildPanelHref(current, 'health', 'stats-slot-integrity');
    const params = new URLSearchParams(href.slice(1));
    expect(params.get('view')).toBe('stats');
    expect(params.get('window')).toBe('7d');
    expect(params.get('population')).toBe('test');
    // section is overwritten to the link's target, not left at the caller's
    // current section — the whole point of the link is to change it.
    expect(params.get('section')).toBe('health');
  });

  test('does not mutate the URLSearchParams handed to it', () => {
    const current = new URLSearchParams('section=config');
    buildPanelHref(current, 'health', 'stats-slot-integrity');
    expect(current.get('section')).toBe('config');
    expect(current.get('anchor')).toBeNull();
  });

  // Unknown-input fallback: a blank or whitespace-only anchor id degrades to
  // a section-only link rather than an `anchor=` param pointing at nothing.
  test('a blank anchor id -> no anchor param, not anchor=""', () => {
    const href = buildPanelHref(new URLSearchParams(''), 'health', '');
    const params = new URLSearchParams(href.slice(1));
    expect(params.has('anchor')).toBe(false);
    expect(params.get('section')).toBe('health');
  });

  test('a whitespace-only anchor id -> also no anchor param', () => {
    const href = buildPanelHref(new URLSearchParams(''), 'health', '   ');
    const params = new URLSearchParams(href.slice(1));
    expect(params.has('anchor')).toBe(false);
  });

  test('a stale anchor already on the URL is replaced, not accumulated', () => {
    const current = new URLSearchParams('section=value&anchor=stats-slot-old');
    const href = buildPanelHref(current, 'health', 'stats-slot-integrity');
    const params = new URLSearchParams(href.slice(1));
    expect(params.getAll('anchor')).toEqual(['stats-slot-integrity']);
  });
});

// ---------------------------------------------------------------------------
// navigateToPanel — safe outside a browser. No DOM/history exists in this
// test runtime (see url-route.test.ts's own guard tests), which is exactly
// the environment `setSection`'s `updateRouteParams` call and the
// `requestAnimationFrame`/`document` guards must degrade gracefully in.
// ---------------------------------------------------------------------------

describe('navigateToPanel — outside a browser', () => {
  test('does not throw when document/requestAnimationFrame/location/history are all missing', () => {
    expect(typeof document).toBe('undefined');
    expect(() => navigateToPanel('health', 'stats-slot-integrity')).not.toThrow();
  });
});
