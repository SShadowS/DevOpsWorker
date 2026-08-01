import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BACKFILL_PREDICATE, parseArgs } from '../../scripts/backfill-test-runs.ts';

describe('backfill-test-runs', () => {
  test('predicate is the agreed union', () => {
    expect(BACKFILL_PREDICATE).toBe("comment_id = 0 OR source_branch = ''");
  });

  test('dry-run is the default', () => {
    expect(parseArgs([]).apply).toBe(false);
  });

  test('--apply opts in to writing', () => {
    expect(parseArgs(['--apply']).apply).toBe(true);
  });

  // Source-text parity check (same pattern as pg-pr-review-store-mapper.test.ts's INSERT/SELECT
  // pinning): both the count and the write must skip already-marked rows, and the write must
  // only ever set the flag true, never clear it. This is the one script in the plan that writes
  // to production — a later edit that silently drops either guard should fail a test, not wait
  // on review.
  test('both statements exclude already-marked rows, and the write only ever sets true', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../scripts/backfill-test-runs.ts', import.meta.url)), 'utf8');
    const guards = src.match(/AND is_test = false/g) ?? [];
    expect(guards.length).toBe(2); // the count query and the UPDATE
    expect(src).toContain('SET is_test = true');
    expect(src).not.toContain('SET is_test = false');
  });
});
