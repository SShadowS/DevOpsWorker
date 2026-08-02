import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { worstStatus, ERROR_RATE_ATTENTION_THRESHOLD } from '../../src/dashboard/client/assessors.ts';

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
