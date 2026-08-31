import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { rowToPRReview } from '../../src/db/pg-pr-review-store.ts';

// ---------------------------------------------------------------------------
// Which commit did this review actually look at?
//
// Mining review history for misses needs one fact per run that was never
// recorded: the tree the agents read. Without it, "same code, second look" can
// only be guessed from timing — and measured on 59 run-pairs, that guess is
// dominated by the confound that later runs see NEW code (~8x more new files
// once there has been time to push).
//
// The SHA recorded is ground truth, not an approximation: `git rev-parse HEAD`
// after the checkout that the review path actually performed. The PR payload's
// `lastMergeSourceCommit` was considered and rejected — it can drift between
// fetch and checkout, and for a merge-preview tree the reviewed tree is the
// preview commit, not the source head. Recording what HEAD resolves to also
// makes a force-push a non-issue, which is why no iteration number is stored.
// ---------------------------------------------------------------------------

const REVIEW_PR = readFileSync(join(import.meta.dir, '../../src/cli/review-pr.ts'), 'utf-8');
const SCHEMA = readFileSync(join(import.meta.dir, '../../src/db/postgres.ts'), 'utf-8');
const STORE = readFileSync(join(import.meta.dir, '../../src/db/pg-pr-review-store.ts'), 'utf-8');

describe('reviewed-commit provenance — schema and store', () => {
  test('the columns exist, in the additive style every other column used', () => {
    expect(SCHEMA).toContain('ADD COLUMN IF NOT EXISTS reviewed_commit_sha');
    expect(SCHEMA).toContain('ADD COLUMN IF NOT EXISTS base_commit_sha');
  });

  test('rowToPRReview maps both fields', () => {
    const row = rowToPRReview({
      pr_id: 1, repo_key: 'r', title: 't',
      reviewed_commit_sha: 'a'.repeat(40),
      base_commit_sha: 'b'.repeat(40),
    });

    expect(row.reviewedCommitSha).toBe('a'.repeat(40));
    expect(row.baseCommitSha).toBe('b'.repeat(40));
  });

  test('rows written before the columns existed read back as null, not undefined', () => {
    // Every historical row is null here by design — the plan this implements
    // forbids backfilling by guess, because a wrong SHA is worse than a missing
    // one when the whole point is trusting "same diff".
    const row = rowToPRReview({ pr_id: 1, repo_key: 'r', title: 't' });

    expect(row.reviewedCommitSha).toBeNull();
    expect(row.baseCommitSha).toBeNull();
  });

  test('the INSERT persists both fields', () => {
    expect(STORE).toContain('reviewed_commit_sha');
    expect(STORE).toContain('base_commit_sha');
    expect(STORE).toContain('row.reviewedCommitSha ?? null');
    expect(STORE).toContain('row.baseCommitSha ?? null');
  });
});

describe('reviewed-commit provenance — the review records what it read', () => {
  test('the full path resolves HEAD after the ladder walk lands', () => {
    // Ground truth over payload: whatever rung won — merge preview, source
    // head, target tip, or the default-branch fallback — HEAD after the walk
    // IS the tree the agents read.
    const idx = REVIEW_PR.indexOf('await checkoutReviewTree(');
    expect(idx).toBeGreaterThan(-1);
    const after = REVIEW_PR.slice(idx, idx + 600);
    expect(after).toContain("resolveRef(repoDir, 'HEAD')");
  });

  test('the sanity path records the checkout it already has', () => {
    // checkoutBranch returns the full sha of what it landed on; no second
    // rev-parse needed there.
    expect(REVIEW_PR).toMatch(/reviewedCommitSha = checkout\.sha/);
  });

  test('both save() sites persist the provenance', () => {
    // The catch-block save persists a failed run's row — a fact about the run,
    // recorded even when the review dies, same contract as treeSource.
    const saves = REVIEW_PR.split('prReviewStore.save').length - 1;
    const withField = REVIEW_PR.split('reviewedCommitSha,').length - 1;
    expect(saves).toBeGreaterThanOrEqual(2);
    expect(withField).toBeGreaterThanOrEqual(2);
    expect(REVIEW_PR).toContain('baseCommitSha:');
  });
});
