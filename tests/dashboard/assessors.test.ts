import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { worstStatus, ERROR_RATE_ATTENTION_THRESHOLD, assessFlaggedModelKeys, assessModelIntegrity } from '../../src/dashboard/client/assessors.ts';
import { assessModelBreakdownCost } from '../../src/dashboard/client/components/stats-costquality.tsx';
import type { IntegrityStats } from '../../src/dashboard/stats.ts';
import type { SettledContaminationAvailability } from '../../src/dashboard/client/model-contamination.ts';

const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

const componentsDir = fileURLToPath(
  new URL('../../src/dashboard/client/components/', import.meta.url),
);

describe('assessors module', () => {
  // SlotSourceInfo is { label, status, message } — all three required.
  const src_ = (status: 'loading' | 'error' | 'empty' | 'ready') =>
    ({ label: 'x', status, message: 'm' });

  test('worstStatus ranks error worst and ready best', () => {
    expect(worstStatus([src_('ready'), src_('error')])).toBe('error');
    expect(worstStatus([src_('ready'), src_('loading')])).toBe('loading');
    expect(worstStatus([src_('ready'), src_('empty')])).toBe('empty');
    expect(worstStatus([src_('ready')])).toBe('ready');
  });

  test('the threshold survives the move', () => {
    expect(ERROR_RATE_ATTENTION_THRESHOLD).toBe(0.1);
  });

  test('the module holds no JSX — it must not import a component', () => {
    // Fix round 1: anchored to import/require syntax, not a bare `.tsx`
    // substring — the earlier version also tripped on prose that merely
    // NAMED a `.tsx` file in a doc comment, which cost a round rewording
    // accurate comments into vaguer ones for no real safety gain. `</` stays
    // a bare substring check: JSX genuinely should never appear here, and
    // prose essentially never contains a literal `</`.
    const src = read('../../src/dashboard/client/assessors.ts');
    expect(src).not.toMatch(/\bfrom\s+['"][^'"]*\.tsx['"]/);
    expect(src).not.toMatch(/\brequire\(\s*['"][^'"]*\.tsx['"]\s*\)/);
    expect(src).not.toContain('</');
  });

  test('no component other than stats-view.tsx imports from stats-ribbon.tsx', () => {
    // Final fix wave: the previous version hard-coded three filenames and checked
    // `.not.toContain("from './stats-ribbon.tsx'")` — a single-quote-only substring match
    // that missed double-quoted imports and a `from`/path split across lines, and left a
    // fourth panel added tomorrow completely unguarded (the invariant is "no component but
    // stats-view.tsx imports stats-ribbon.tsx", which wants a directory scan, not a list).
    // Reuses the no-JSX guard's shape above: anchored to import/require syntax, not a bare
    // substring. `\s+` / `\s*` match newlines by default, so a `from` split onto its own
    // line from the path is still caught without a multiline flag.
    const importRibbon = /\bfrom\s+['"][^'"]*stats-ribbon\.tsx['"]/;
    const requireRibbon = /\brequire\(\s*['"][^'"]*stats-ribbon\.tsx['"]\s*\)/;

    const offenders = readdirSync(componentsDir)
      .filter((f) => f.endsWith('.tsx') && f !== 'stats-view.tsx')
      .filter((f) => {
        const src = readFileSync(join(componentsDir, f), 'utf8');
        return importRibbon.test(src) || requireRibbon.test(src);
      });
    expect(offenders).toEqual([]);

    // stats-view.tsx is the one file that SHOULD still import it — without this, a guard
    // that also (wrongly) caught the legitimate import would pass by testing nothing.
    expect(importRibbon.test(read('../../src/dashboard/client/components/stats-view.tsx'))).toBe(true);
  });

  test('combinePanelStatus is gone — worstStatus is the one ranking', () => {
    expect(read('../../src/dashboard/client/components/stats-costquality.tsx'))
      .not.toContain('combinePanelStatus');
  });
});

// ---------------------------------------------------------------------------
// One name for the `flagged` rows, across the two cards that cross-reference
// each other.
//
// This block guards the property: whatever noun the Cost card and the
// Integrity card use for a flagged row, both must use the SAME one. The two
// panels report the same server-computed `flagged` field — not two
// independent measurements — and the Cost card's own summary ends "see the
// Integrity panel's Model usage section", pointing the reader straight at
// the other card's wording.
//
// History: Task 8 dropped "key" from the Cost card's summary and guarded it
// there, but left two sites in this module untouched, so the Cost card said
// "1 flagged model(s)" while the Integrity card two slots away said "1
// flagged model key(s)" — the same field under two names. That split is what
// this block now closes and keeps closed.
// ---------------------------------------------------------------------------

describe('flagged model wording is shared with the Cost card', () => {
  const integrity = (models: string[]) =>
    ({
      sampleSize: 100,
      modelUsage: {
        breakdown: [],
        flaggedKeys: models.map((model) => ({ model, rows: 1, totalCostUsd: 1, totalOutputTokens: 1, flagged: true })),
      },
    }) as unknown as IntegrityStats;

  const settledNoPins = { status: 'ready', rows: [] } as unknown as SettledContaminationAvailability;

  test('both Integrity-side assessors say "flagged model", never "model key(s)"', () => {
    const one = assessFlaggedModelKeys(integrity(['claude-opus-5[1m]']));
    expect(one.text).toContain('1 flagged model: claude-opus-5[1m]');
    expect(one.text).not.toContain('key');
    expect(one.text).not.toContain('(s)');

    const combined = assessModelIntegrity(integrity(['claude-opus-5[1m]']), settledNoPins);
    expect(combined.text).toContain('1 flagged model: claude-opus-5[1m]');
    expect(combined.text).not.toContain('model key');
    expect(combined.text).not.toContain('(s)');
  });

  // The clean branches too. Leaving them at "no flagged model keys" would have
  // put both names inside ONE function, one branch apart — the same defect one
  // level down from the one being fixed.
  test('the clean branches use the same word as the branch that fires', () => {
    expect(assessFlaggedModelKeys(integrity([])).text).toContain('no flagged models');
    expect(assessModelIntegrity(integrity([]), settledNoPins).text).toContain('no flagged models');
  });

  // The property, not two literals that happen to agree today: whatever noun
  // each card uses for a flagged row, it must be the same noun. `assessors.ts`
  // is the only file this repo can change to keep that true, which is why the
  // guard lives here and not beside either card.
  test('the Cost card and the Integrity card name a flagged row identically', () => {
    const costText = assessModelBreakdownCost([
      { model: 'claude-opus-5[1m]', rows: 1, totalCostUsd: 3.75, totalOutputTokens: 500, flagged: true },
    ]);
    const NOUN = /\d+ flagged models?\b/;
    expect(costText.text).toMatch(NOUN);
    expect(assessFlaggedModelKeys(integrity(['claude-opus-5[1m]'])).text).toMatch(NOUN);
    expect(assessModelIntegrity(integrity(['claude-opus-5[1m]']), settledNoPins).text).toMatch(NOUN);
  });
});

// ---------------------------------------------------------------------------
// The ribbon's contamination clause (dashboard-followups, Task 2). It used to
// read "runs off declared pin across N sub-agent(s) (floor — sub_agents
// undercounts, see Integrity panel)": a raw schema name, "floor" (the rest of
// the page settled on "at least this much"/"at least this many" instead), and
// a hand-written "(s)" placeholder where the rest of the page uses countOf().
// ---------------------------------------------------------------------------

describe("the ribbon's contamination clause", () => {
  const cleanIntegrity = (): IntegrityStats =>
    ({ sampleSize: 100, modelUsage: { breakdown: [], flaggedKeys: [] } }) as unknown as IntegrityStats;

  /** `n` contaminated sub-agent rows, one off-pin run each. */
  const contaminatedRows = (n: number): SettledContaminationAvailability =>
    ({
      status: 'ready',
      rows: Array.from({ length: n }, (_, i) => ({
        agent: `sub-agent-${i}`,
        declaredModel: 'claude-sonnet-5',
        observed: [{ model: 'claude-opus-5', count: 1 }],
        totalRuns: 1,
        offPinRuns: 1,
        status: 'attention' as const,
      })),
    }) as unknown as SettledContaminationAvailability;

  const ribbonText = (contamination: SettledContaminationAvailability) =>
    assessModelIntegrity(cleanIntegrity(), contamination).text;

  test('the ribbon states the undercount without naming a database column', () => {
    const text = ribbonText(contaminatedRows(2));
    expect(text).not.toContain('sub_agents');
    expect(text).not.toContain('floor');
    expect(text).not.toContain('(s)');
    expect(text).toContain('at least this many');
    // The hedge and its reason travel together — pinning only "at least this
    // many" would let a later edit strand a bare hedge with nothing behind it.
    expect(text).toContain('the record of which sub-agents ran is incomplete');
  });

  test('the ribbon agrees with its own count at one and at three', () => {
    expect(ribbonText(contaminatedRows(1))).toContain('1 sub-agent');
    expect(ribbonText(contaminatedRows(1))).not.toContain('1 sub-agents');
    expect(ribbonText(contaminatedRows(3))).toContain('3 sub-agents');
  });
});
