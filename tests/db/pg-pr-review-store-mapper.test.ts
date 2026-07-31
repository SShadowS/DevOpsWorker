import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rowToPRReview } from '../../src/db/pg-pr-review-store.ts';
import type { PRFinding } from '../../src/agents/pr-reviewer/schema.ts';

describe('rowToPRReview', () => {
  test('maps review_run_id to reviewRunId', () => {
    const row = rowToPRReview({
      id: 1, pr_id: 42, repo_key: 'k', source_branch: 's', target_branch: 't',
      title: null, recommendation: 'approve', findings: null, findings_count: null,
      comment_id: null, cost_usd: null, duration_ms: null, turns: null,
      tool_calls: null, session_id: null, error: null, review_body: null,
      created_at: '2026-01-01T00:00:00Z', action_id: null, review_run_id: 'pr42-abc',
    });
    expect(row.reviewRunId).toBe('pr42-abc');
  });

  test('maps findings_list to findingsList', () => {
    const findingsList: PRFinding[] = [
      { severity: 'critical', title: 'Missing guard', file: 'App/Foo.Codeunit.al', line: 42, location: 'PostDocument', body: 'Explanation.' },
    ];
    const row = rowToPRReview({
      id: 1, pr_id: 42, repo_key: 'k', source_branch: 's', target_branch: 't',
      title: null, recommendation: 'request changes', findings: null, findings_count: 1,
      comment_id: null, cost_usd: null, duration_ms: null, turns: null,
      tool_calls: null, session_id: null, error: null, review_body: null,
      created_at: '2026-01-01T00:00:00Z', action_id: null, review_run_id: 'pr42-abc',
      findings_list: findingsList,
    });
    expect(row.findingsList).toEqual(findingsList);
  });

  test('maps a null findings_list to null (not attempted / no findings)', () => {
    const row = rowToPRReview({
      id: 1, pr_id: 42, repo_key: 'k', source_branch: 's', target_branch: 't',
      title: null, recommendation: 'approve', findings: null, findings_count: null,
      comment_id: null, cost_usd: null, duration_ms: null, turns: null,
      tool_calls: null, session_id: null, error: null, review_body: null,
      created_at: '2026-01-01T00:00:00Z', action_id: null, review_run_id: 'pr42-abc',
      findings_list: null,
    });
    expect(row.findingsList).toBeNull();
  });

  test('maps inline_threads to inlineThreads', () => {
    const inlineThreads = { created: 2, updated: 1, stale: 0, failed: 0 };
    const row = rowToPRReview({
      id: 1, pr_id: 42, repo_key: 'k', source_branch: 's', target_branch: 't',
      title: null, recommendation: 'request changes', findings: null, findings_count: 1,
      comment_id: null, cost_usd: null, duration_ms: null, turns: null,
      tool_calls: null, session_id: null, error: null, review_body: null,
      created_at: '2026-01-01T00:00:00Z', action_id: null, review_run_id: 'pr42-abc',
      inline_threads: inlineThreads,
    });
    expect(row.inlineThreads).toEqual(inlineThreads);
  });

  test('maps a null inline_threads to null — distinct from an all-zero measured result', () => {
    const row = rowToPRReview({
      id: 1, pr_id: 42, repo_key: 'k', source_branch: 's', target_branch: 't',
      title: null, recommendation: 'approve', findings: null, findings_count: null,
      comment_id: null, cost_usd: null, duration_ms: null, turns: null,
      tool_calls: null, session_id: null, error: null, review_body: null,
      created_at: '2026-01-01T00:00:00Z', action_id: null, review_run_id: 'pr42-abc',
      inline_threads: null,
    });
    expect(row.inlineThreads).toBeNull();
  });

  test('maps review_path to reviewPath', () => {
    const row = rowToPRReview({
      id: 1, pr_id: 42, repo_key: 'k', source_branch: 's', target_branch: 't',
      title: null, recommendation: 'approve', findings: null, findings_count: null,
      comment_id: null, cost_usd: null, duration_ms: null, turns: null,
      tool_calls: null, session_id: null, error: null, review_body: null,
      created_at: '2026-01-01T00:00:00Z', action_id: null, review_run_id: 'pr42-abc',
      review_path: 'sanity:52117',
    });
    expect(row.reviewPath).toBe('sanity:52117');
  });

  test('maps a null review_path to null — rows predating the backport path', () => {
    const row = rowToPRReview({
      id: 1, pr_id: 42, repo_key: 'k', source_branch: 's', target_branch: 't',
      title: null, recommendation: 'approve', findings: null, findings_count: null,
      comment_id: null, cost_usd: null, duration_ms: null, turns: null,
      tool_calls: null, session_id: null, error: null, review_body: null,
      created_at: '2026-01-01T00:00:00Z', action_id: null, review_run_id: 'pr42-abc',
      review_path: null,
    });
    expect(row.reviewPath).toBeNull();
  });

  test('maps applied_levers to appliedLevers', () => {
    const appliedLevers = { scopedPayload: 1, securityBcOnly: 2 };
    const row = rowToPRReview({
      id: 1, pr_id: 42, repo_key: 'k', source_branch: 's', target_branch: 't',
      title: null, recommendation: 'approve', findings: null, findings_count: null,
      comment_id: null, cost_usd: null, duration_ms: null, turns: null,
      tool_calls: null, session_id: null, error: null, review_body: null,
      created_at: '2026-01-01T00:00:00Z', action_id: null, review_run_id: 'pr42-abc',
      applied_levers: appliedLevers,
    });
    expect(row.appliedLevers).toEqual(appliedLevers);
  });

  // C2's failure mode lands here if the mapper ever normalised an absent
  // key differently from an explicit null — a plain `??` is what keeps them
  // both reading as "not recorded" rather than accidentally as `{}`.
  test('maps a null applied_levers to null — production reviews set no lever', () => {
    const row = rowToPRReview({
      id: 1, pr_id: 42, repo_key: 'k', source_branch: 's', target_branch: 't',
      title: null, recommendation: 'approve', findings: null, findings_count: null,
      comment_id: null, cost_usd: null, duration_ms: null, turns: null,
      tool_calls: null, session_id: null, error: null, review_body: null,
      created_at: '2026-01-01T00:00:00Z', action_id: null, review_run_id: 'pr42-abc',
      applied_levers: null,
    });
    expect(row.appliedLevers).toBeNull();
  });
});

describe('PgPRReviewStore.save — INSERT column/placeholder parity', () => {
  // A hand-maintained parameterised INSERT only fails at runtime, against the
  // live database, if the column list and the `${}` placeholder count drift —
  // no mapper test would catch that. Read the source and count both sides.
  const src = readFileSync(fileURLToPath(new URL('../../src/db/pg-pr-review-store.ts', import.meta.url)), 'utf-8');

  test('names both new columns', () => {
    expect(src).toContain('findings_list');
    expect(src).toContain('inline_threads');
  });

  test('the INSERT names review_path', () => {
    const insert = /INSERT INTO pr_reviews \(([^)]*)\)/.exec(src);
    expect(insert).not.toBeNull();
    expect(insert![1]).toContain('review_path');
  });

  test('the INSERT names applied_levers', () => {
    const insert = /INSERT INTO pr_reviews \(([^)]*)\)/.exec(src);
    expect(insert).not.toBeNull();
    expect(insert![1]).toContain('applied_levers');
  });

  test('column count matches placeholder count in the INSERT', () => {
    const columnMatch = src.match(/INSERT INTO pr_reviews \(([^)]*)\)/);
    expect(columnMatch).not.toBeNull();
    const columns = columnMatch![1]!.split(',').map((c) => c.trim()).filter(Boolean);

    const valuesMatch = src.match(/VALUES \(([\s\S]*?)\n\s*\)\s*\n\s*RETURNING id/);
    expect(valuesMatch).not.toBeNull();
    const placeholderCount = (valuesMatch![1]!.match(/\$\{/g) ?? []).length;

    expect(columns).toContain('findings_list');
    expect(columns).toContain('inline_threads');
    expect(columns).toContain('review_path');
    expect(columns).toContain('applied_levers');
    expect(placeholderCount).toBe(columns.length);
  });

  // C3: the four SELECT column lists (listRecent, findByActionId, findById,
  // findLatestByPrId) are hand-maintained too — missing applied_levers on any
  // one of them means `row.appliedLevers` reads as undefined for rows fetched
  // through that method, silently voiding every arm at scoring time.
  test('every SELECT names applied_levers', () => {
    const selects = src.match(/SELECT id,[\s\S]*?FROM pr_reviews/g) ?? [];
    expect(selects.length).toBeGreaterThanOrEqual(4);
    for (const select of selects) {
      expect(select).toContain('applied_levers');
    }
  });
});

describe('PgPRReviewStore.findLatestByPrId — excludes the sanity path', () => {
  // Caught by review: without this, a sanity review OF a PR counts as that PR's
  // own "deep review" — on a release-line chain A -> B -> C, the sanity review
  // that ported A's fix onto B would make C's lookup of B report `reviewed`,
  // suppressing the "no recorded deep review anywhere" warning for a change that
  // was never actually deep-reviewed. No live-DB test (DATABASE_URL points at
  // production and nothing under tests/ guards it) — pinned in the SQL text.
  const src = readFileSync(fileURLToPath(new URL('../../src/db/pg-pr-review-store.ts', import.meta.url)), 'utf-8');

  test('the query excludes rows recorded on the sanity path', () => {
    const method = src.match(/async findLatestByPrId\(prId: number\)[\s\S]*?\n {2}\}/);
    expect(method).not.toBeNull();
    const body = method![0];
    expect(body).toContain('WHERE pr_id = ${prId}');
    // NULL must count as a full review too — every row predating this feature
    // has no review_path at all.
    expect(body).toMatch(/review_path IS NULL OR review_path LIKE 'full:%'/);
  });
});
