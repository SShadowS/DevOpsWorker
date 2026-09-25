import { describe, test, expect } from 'bun:test';
import { readPRReviewDetail } from '../../src/dashboard/state-reader.ts';

// Issue #26 step 1: `foundBy` was recorded on every finding but read by nothing
// on the dashboard. The detail endpoint now carries it to the finding table.
function storeWith(findingsList: unknown) {
  return {
    findById: async () => ({
      id: 1, prId: 2, repoKey: 'r', sourceBranch: 's', targetBranch: 't', title: 'x',
      recommendation: 'approve', findings: {}, findingsCount: 1, costUsd: null, durationMs: null,
      turns: null, toolCalls: null, error: null, createdAt: '2026-09-25', reviewBody: null,
      isTest: false, reviewPath: null, observedCherryPick: null, findingsList,
    }),
  } as never;
}

describe('readPRReviewDetail findingsList', () => {
  test('carries each finding with the agents that raised it', async () => {
    const d = await readPRReviewDetail(storeWith([
      { severity: 'major', title: 'A', file: 'App/X.al', line: 4, foundBy: ['code-review-validator', 'al-error-pattern-analyzer'] },
      { severity: 'minor', title: 'B' },
    ]), 1);
    expect(d!.findingsList).toEqual([
      { severity: 'major', title: 'A', file: 'App/X.al', line: 4, foundBy: ['code-review-validator', 'al-error-pattern-analyzer'] },
      { severity: 'minor', title: 'B', foundBy: [] },
    ]);
  });

  test('null when the review recorded no list', async () => {
    expect((await readPRReviewDetail(storeWith(null), 1))!.findingsList).toBeNull();
  });
});
