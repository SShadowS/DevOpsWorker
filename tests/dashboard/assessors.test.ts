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
    const src = read('../../src/dashboard/client/assessors.ts');
    expect(src).not.toContain('.tsx');
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
