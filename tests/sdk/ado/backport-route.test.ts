import { describe, test, expect } from 'bun:test';
import { chooseReviewPath } from '../../../src/sdk/ado/backport.ts';

const base = {
  cherryPick: { isCherryPick: true, originalPrId: 52117 },
  sourceBranch: 'refs/heads/bug/x-on-hotfix-28.3.2',
  sourcePrExists: true,
  sourceDiffFetchable: true,
  forceFull: false,
};

describe('chooseReviewPath', () => {
  test('takes the sanity path when every condition holds', () => {
    expect(chooseReviewPath(base)).toEqual({ path: 'sanity', sourcePrId: 52117 });
  });

  test('full when not a cherry-pick', () => {
    const r = chooseReviewPath({ ...base, cherryPick: { isCherryPick: false } });
    expect(r.path).toBe('full');
  });

  test('full when detected but no source id could be extracted', () => {
    const r = chooseReviewPath({ ...base, cherryPick: { isCherryPick: true } });
    expect(r.path).toBe('full');
    if (r.path === 'full') expect(r.reason).toContain('source');
  });

  test('full when the source PR does not exist in this repository', () => {
    expect(chooseReviewPath({ ...base, sourcePrExists: false }).path).toBe('full');
  });

  test('full when the source diff cannot be fetched', () => {
    expect(chooseReviewPath({ ...base, sourceDiffFetchable: false }).path).toBe('full');
  });

  test('full when sourceBranch is empty — the checkout cannot happen', () => {
    // action-processor passes `sourceBranch || ''`, so this is reachable.
    expect(chooseReviewPath({ ...base, sourceBranch: '' }).path).toBe('full');
  });

  test('full when forced, even though every other condition holds', () => {
    const r = chooseReviewPath({ ...base, forceFull: true });
    expect(r.path).toBe('full');
    if (r.path === 'full') expect(r.reason).toContain('forced');
  });

  test('every full-path result carries a reason, for the review_path column', () => {
    for (const bad of [
      { ...base, cherryPick: { isCherryPick: false } },
      { ...base, sourcePrExists: false },
      { ...base, sourceDiffFetchable: false },
      { ...base, sourceBranch: '' },
      { ...base, forceFull: true },
    ]) {
      const r = chooseReviewPath(bad);
      expect(r.path).toBe('full');
      if (r.path === 'full') expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  test('every full-path reason is distinct, so review_path identifies which guard fired', () => {
    const reasons = [
      { ...base, forceFull: true },
      { ...base, cherryPick: { isCherryPick: false } },
      { ...base, cherryPick: { isCherryPick: true } },        // no originalPrId
      { ...base, sourcePrExists: false },
      { ...base, sourceDiffFetchable: false },
      { ...base, sourceBranch: '' },
    ].map((input) => {
      const r = chooseReviewPath(input);
      if (r.path !== 'full') throw new Error('expected the full path');
      return r.reason;
    });

    // Distinct: a reader of review_path must be able to tell which condition fired.
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  test('the uncomputable-diff reason carries WHY, not just that it failed', () => {
    // The CRITICAL this branch shipped with: every diff failure collapsed into
    // "source PR !<id> not found in this repository", which is unfalsifiable from a
    // `review_path` read and is what let a 404-ing endpoint hide in plain sight
    // through nine reviews. The cause has to survive into the column.
    const r = chooseReviewPath({
      ...base,
      sourceDiffFetchable: false,
      sourceDiffError: 'commit(s) not present in the clone: abc123',
    });
    expect(r.path).toBe('full');
    if (r.path === 'full') {
      expect(r.reason).toContain('commit(s) not present in the clone');
      expect(r.reason).not.toContain('not found in this repository');
    }
  });

  test('a long diff error is capped — review_path is a column a human reads', () => {
    const r = chooseReviewPath({ ...base, sourceDiffFetchable: false, sourceDiffError: 'x'.repeat(5000) });
    if (r.path === 'full') expect(r.reason.length).toBeLessThan(300);
  });

  test('the "(via <route>)" suffix survives the cap — it is the most diagnostic token', () => {
    // Measured regression: `fetchPRDiff` appends the route at the TAIL, where this
    // cap bites first. An unreachable commit with a 5-digit PR id landed at 195 of
    // 200 — five characters of headroom — so a 7-digit id silently dropped the
    // route, and any ADO API error truncated it outright (`... (via merge-com`).
    // `fetchPRDiff` now caps the detail BEFORE appending, so whatever arrives here
    // still ends with an intact suffix. Both routes, and a deliberately long detail.
    // The worst real case: BOTH commits absent (two 40-char shas) and a 7-digit PR
    // id in both recover refs. That is what overflowed 200 and lost the suffix.
    for (const via of ['merge-commit', 'iteration']) {
      const detail = `commit(s) not present in the clone: ${'a'.repeat(40)}, ${'b'.repeat(40)}`
        + ' (tried fetching refs/pull/1234567/merge, refs/pull/1234567/head)';
      // Pre-capped by fetchPRDiff exactly as production does, then the suffix added.
      const capped = detail.length > 160 ? `${detail.slice(0, 160)}…` : detail;
      const r = chooseReviewPath({
        ...base,
        sourceDiffFetchable: false,
        sourceDiffError: `${capped} (via ${via})`,
      });
      expect(r.path).toBe('full');
      if (r.path === 'full') expect(r.reason).toContain(`(via ${via})`);
    }
  });

  test('"PR missing" and "diff uncomputable" stay distinct reasons', () => {
    const missing = chooseReviewPath({ ...base, sourcePrExists: false });
    const uncomputable = chooseReviewPath({ ...base, sourceDiffFetchable: false });
    expect(missing.path).toBe('full');
    expect(uncomputable.path).toBe('full');
    if (missing.path === 'full' && uncomputable.path === 'full') {
      expect(missing.reason).not.toBe(uncomputable.reason);
    }
  });

  test('forceFull is reported even when another condition would also fail', () => {
    // Ordering is deliberate: a human who asked for the full review should see that
    // reason, not an incidental detection failure that happens to be checked first.
    const r = chooseReviewPath({ ...base, forceFull: true, cherryPick: { isCherryPick: false }, sourceBranch: '' });
    expect(r.path).toBe('full');
    if (r.path === 'full') expect(r.reason).toContain('forced');
  });
});

// ---------------------------------------------------------------------------
// A multi-source port keeps the full path, and the reason says so.
//
// `originalPrId` is now unset for two different reasons — nothing named a
// source at all, or several did — and the route reason is what a human reads
// out of `review_path` months later. "no source PR id in the trailer" would be
// a lie about the second case.
// ---------------------------------------------------------------------------
describe('chooseReviewPath — multi-source ports', () => {
  const multi = {
    ...base,
    cherryPick: { isCherryPick: true, multiSourcePrIds: [41464, 42379] },
    sourcePrExists: false,
    sourceDiffFetchable: false,
  };

  test('stays on the full path', () => {
    expect(chooseReviewPath(multi).path).toBe('full');
  });

  test('names the sources in the reason instead of blaming a missing trailer', () => {
    const r = chooseReviewPath(multi);
    if (r.path !== 'full') throw new Error('expected the full path');
    expect(r.reason).toContain('41464');
    expect(r.reason).toContain('42379');
    expect(r.reason).not.toContain('trailer');
  });
});
