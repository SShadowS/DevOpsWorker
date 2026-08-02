import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { worstStatus, ERROR_RATE_ATTENTION_THRESHOLD } from '../../src/dashboard/client/assessors.ts';

const read = (p: string) =>
  readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

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

  test('no panel imports an assessor from stats-ribbon any more', () => {
    for (const p of ['stats-integrity.tsx', 'stats-config.tsx', 'stats-costquality.tsx']) {
      const src = read(`../../src/dashboard/client/components/${p}`);
      expect(src).not.toContain("from './stats-ribbon.tsx'");
    }
  });

  test('combinePanelStatus is gone — worstStatus is the one ranking', () => {
    expect(read('../../src/dashboard/client/components/stats-costquality.tsx'))
      .not.toContain('combinePanelStatus');
  });
});
