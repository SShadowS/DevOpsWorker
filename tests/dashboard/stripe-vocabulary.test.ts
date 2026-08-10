import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The coloured left edge is the dashboard's only "what state is this in" signal, and it
// appears on around twenty elements across views that were built at different times. It
// drifted: the same state was green in one list and amber in another, one colour meant
// two things, and a label was wearing a state colour. These pin the vocabulary written
// at the top of dashboard.css so it stays one language.
//
// Source-text pins, like the rest of tests/dashboard/ — no database, no rendering.

const css = readFileSync(
  fileURLToPath(new URL('../../src/dashboard/client/styles/dashboard.css', import.meta.url)),
  'utf8',
);

/** Every `border-left-color: …` declaration, as [selector, token]. */
function stripeColours(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = /^(\.[a-z0-9_-]+(?:,\s*\.[a-z0-9_-]+)*)\s*\{[^}]*border-left-color:\s*([^;]+);/gim;
  for (const m of css.matchAll(re)) out.push([m[1]!.trim(), m[2]!.trim()]);
  return out;
}

describe('stripe width scale', () => {
  test('every left edge is 2, 3 or 4px — no fourth width creeps in', () => {
    const widths = [...css.matchAll(/border-left:\s*(\d+)px/g)].map((m) => Number(m[1]));
    expect(widths.length).toBeGreaterThanOrEqual(15);
    expect([...new Set(widths)].sort()).toEqual([2, 3, 4]);
  });

  test('a card that is its own row in a list gets 4px', () => {
    for (const selector of ['.session-card {', '.mobile-card {', '.stats-slot {', '.status-ribbon__item {']) {
      const rule = css.slice(css.indexOf(selector));
      expect(rule.slice(0, rule.indexOf('}'))).toMatch(/border-left:\s*4px/);
    }
  });

  test('something inside a card gets 3px', () => {
    for (const selector of ['.pr-review-row {', '.review-item {', '.gap-item {', '.risk-card {']) {
      const rule = css.slice(css.indexOf(selector));
      expect(rule.slice(0, rule.indexOf('}'))).toMatch(/border-left:\s*3px/);
    }
  });
});

describe('one colour, one meaning', () => {
  test('--color-accent marks only "a person needs to act"', () => {
    // Not selection, not a test run, not a category. Every accent edge must belong to a
    // checkpoint waiting for someone, or to a panel flagging something to look at.
    //
    // Both spellings count: `border-left-color:` on a modifier, and the `border-left:`
    // shorthand. Checking only the first is how the shorthand at .review-value-figure
    // --attention slipped past the first version of this test.
    const accentEdges = [...css.matchAll(/(\.[a-z0-9_ ,.:>-]+?)\s*\{([^}]*)\}/gi)]
      .filter(([, , body]) => /border-left(-color)?:[^;]*--color-accent/.test(body!))
      .map(([, selector]) => selector!.trim());
    expect(accentEdges.length).toBeGreaterThan(0);
    for (const selector of accentEdges) {
      expect(selector).toMatch(/--(waiting|attention)\b/);
    }
  });

  test('selection does not borrow the attention colour', () => {
    const rule = css.slice(css.indexOf('.log-viewer__stage--active {'));
    const body = rule.slice(0, rule.indexOf('}'));
    expect(body).toContain('border-left');
    expect(body).not.toContain('--color-accent');
  });
});

describe('the two session lists tell the same story', () => {
  // The desktop list and the phone list render the SAME five pipeline states. They were
  // written separately and disagreed: checkpoint-waiting was --color-success on desktop
  // and --color-stage-waiting (amber) on mobile. Same fact, different colour, depending
  // on the width of your window.
  const STATES = ['running', 'waiting', 'failed', 'completed', 'stalled'];

  function colourOf(family: string, state: string): string {
    const m = css.match(new RegExp(`\\.${family}--${state}\\s*\\{[^}]*border-left-color:\\s*([^;]+);`));
    if (!m) throw new Error(`no stripe rule for .${family}--${state}`);
    return m[1]!.trim();
  }

  for (const state of STATES) {
    test(`${state} is the same colour on desktop and on mobile`, () => {
      expect(colourOf('mobile-card', state)).toBe(colourOf('session-card', state));
    });
  }

  test('a checkpoint reads as needing a person, not as success', () => {
    expect(colourOf('session-card', 'waiting')).toContain('--color-accent');
  });
});
