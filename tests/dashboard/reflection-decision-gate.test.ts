import { describe, test, expect } from 'bun:test';
import { decisionButtonState, type Decision } from '../../src/dashboard/client/components/reflection-card.tsx';

// ---------------------------------------------------------------------------
// The Approve/Reject gate is a two-step confirm (design-critique fix, P1):
// a first click arms a button instead of sending the decision, and the
// OTHER button becomes a "Cancel" escape hatch. `decisionButtonState` is the
// pure state machine behind that — given which decision (if any) is armed,
// it says what one button should render as. This is the part of the gate
// that is testable without a DOM harness (this repo has none — no
// jsdom/happy-dom/testing-library dependency, and reflections-api.test.ts,
// the only other reflection-card test file, only exercises the HTTP routes).
// The click handlers themselves, the rendered label text, and the styling
// are DOM behaviour and are not covered here.
// ---------------------------------------------------------------------------

describe('decisionButtonState', () => {
  const APPROVED: Decision = 'approved';
  const REJECTED: Decision = 'rejected';

  test('nothing armed: both buttons are plain, independent of each other', () => {
    expect(decisionButtonState(null, APPROVED)).toBe('plain');
    expect(decisionButtonState(null, REJECTED)).toBe('plain');
  });

  test('approve armed: approve is the confirm, reject becomes cancel', () => {
    expect(decisionButtonState(APPROVED, APPROVED)).toBe('armed');
    expect(decisionButtonState(APPROVED, REJECTED)).toBe('cancel');
  });

  test('reject armed: reject is the confirm, approve becomes cancel', () => {
    expect(decisionButtonState(REJECTED, REJECTED)).toBe('armed');
    expect(decisionButtonState(REJECTED, APPROVED)).toBe('cancel');
  });

  test('arming is mutually exclusive: a button is never both armed and the cancel for itself', () => {
    for (const armed of [null, APPROVED, REJECTED] as const) {
      for (const decision of [APPROVED, REJECTED] as const) {
        const state = decisionButtonState(armed, decision);
        // 'armed' only ever applies to the button matching the armed decision.
        if (state === 'armed') expect(armed).toBe(decision);
        // 'cancel' only ever applies to the OTHER button.
        if (state === 'cancel') { expect(armed).not.toBeNull(); expect(armed).not.toBe(decision); }
      }
    }
  });
});
