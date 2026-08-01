import { describe, test, expect } from 'bun:test';
import { describeFetchState, worstStatus } from '../../src/dashboard/client/components/stats-view.tsx';
import type { FetchState } from '../../src/dashboard/client/stats-store.ts';

describe('describeFetchState', () => {
  test('loading -> a loading message, never the ready describer', () => {
    const state: FetchState<{ n: number }> = { status: 'loading' };
    const info = describeFetchState('Cost', state, () => {
      throw new Error('describeReady must not run while loading');
    });
    expect(info).toEqual({ label: 'Cost', status: 'loading', message: 'Loading…' });
  });

  test('error -> states what failed, in words', () => {
    const state: FetchState<{ n: number }> = { status: 'error', message: '500 Internal Server Error' };
    const info = describeFetchState('Cost', state, () => 'unreachable');
    expect(info.status).toBe('error');
    expect(info.message).toContain('500 Internal Server Error');
  });

  test('empty -> reads distinctly from error (no data vs request failed)', () => {
    const state: FetchState<{ n: number }> = { status: 'empty' };
    const info = describeFetchState('Cost', state, () => 'unreachable');
    expect(info.status).toBe('empty');
    expect(info.message).not.toContain('Failed');
  });

  test('ready -> delegates to the caller-supplied describer with the real data', () => {
    const state: FetchState<{ n: number }> = { status: 'ready', data: { n: 42 } };
    const info = describeFetchState('Cost', state, (d) => `n=${d.n}`);
    expect(info).toEqual({ label: 'Cost', status: 'ready', message: 'n=42' });
  });
});

describe('worstStatus', () => {
  test('error outranks everything', () => {
    expect(worstStatus([
      { label: 'a', status: 'ready', message: '' },
      { label: 'b', status: 'error', message: '' },
      { label: 'c', status: 'loading', message: '' },
    ])).toBe('error');
  });

  test('loading outranks empty and ready', () => {
    expect(worstStatus([
      { label: 'a', status: 'ready', message: '' },
      { label: 'b', status: 'empty', message: '' },
      { label: 'c', status: 'loading', message: '' },
    ])).toBe('loading');
  });

  test('empty outranks ready', () => {
    expect(worstStatus([
      { label: 'a', status: 'ready', message: '' },
      { label: 'b', status: 'empty', message: '' },
    ])).toBe('empty');
  });

  test('all ready -> ready', () => {
    expect(worstStatus([
      { label: 'a', status: 'ready', message: '' },
      { label: 'b', status: 'ready', message: '' },
    ])).toBe('ready');
  });

  test('single source -> that source\'s own status', () => {
    expect(worstStatus([{ label: 'a', status: 'error', message: '' }])).toBe('error');
  });
});
