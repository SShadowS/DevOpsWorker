import { describe, test, expect } from 'bun:test';
import { chooseShownProposal, awaitingDecisionElsewhere } from '../../src/dashboard/client/components/reflection-card.tsx';
import type { ReflectionProposal, ProposalStatus } from '../../src/db/reflection-proposal-mapper.ts';

// ---------------------------------------------------------------------------
// Which proposal the Reflection card shows in full.
//
// The card used to render only the newest proposal in full, and that full
// view is the only place the Approve/Reject gate lives. Older proposals were
// a date and a badge. With cycles on the 1st and the 15th, a newer cycle can
// arrive before the older one is decided — proposal #2 (09-01) sat pending
// under #3 (09-15) with no way to reach its buttons. These are the pure
// choices behind the fix: any proposal can be opened, and one still waiting on
// a decision is named even when another is on screen.
// ---------------------------------------------------------------------------

function proposal(id: number, status: ProposalStatus | null, error: string | null = null): ReflectionProposal {
  return {
    id, cycleDate: `2026-09-${String(id).padStart(2, '0')}`, windowDays: 35, coverage: null,
    adjudications: [], clusters: [], proposedChanges: [], watchLedger: null, classifierNotes: null,
    expectedEffects: null, logEntryDraft: null, status, decidedBy: null, decidedAt: null,
    appliedAt: null, appliedCommits: null, costUsd: null, sessionId: null, error, imageSha: null,
    createdAt: '2026-09-15T08:14:16.948Z',
  };
}

// Newest first, as /api/reflections returns them.
const LIST = [proposal(3, 'applied'), proposal(2, 'pending'), proposal(1, 'rejected')];

describe('chooseShownProposal', () => {
  test('with nothing selected, the newest proposal is shown', () => {
    expect(chooseShownProposal(LIST, null).id).toBe(3);
  });

  test('a selected older proposal is shown in full', () => {
    expect(chooseShownProposal(LIST, 2).id).toBe(2);
  });

  test('a selection that is no longer in the list falls back to the newest', () => {
    // e.g. the list was refetched and the selected row aged out of the limit.
    expect(chooseShownProposal(LIST, 99).id).toBe(3);
  });
});

describe('awaitingDecisionElsewhere', () => {
  test('names a pending proposal that is not the one on screen', () => {
    expect(awaitingDecisionElsewhere(LIST, 3).map((p) => p.id)).toEqual([2]);
  });

  test('is empty once the pending proposal is the one on screen', () => {
    expect(awaitingDecisionElsewhere(LIST, 2)).toEqual([]);
  });

  test('a failed run is not offered as waiting for a decision — it has no buttons to press', () => {
    const list = [proposal(3, 'applied'), proposal(2, 'pending', 'agent crashed')];
    expect(awaitingDecisionElsewhere(list, 3)).toEqual([]);
  });

  test('lists every other pending proposal, oldest first, so the longest wait is read first', () => {
    const list = [proposal(4, 'applied'), proposal(3, 'pending'), proposal(2, 'pending')];
    expect(awaitingDecisionElsewhere(list, 4).map((p) => p.id)).toEqual([2, 3]);
  });
});
