import { describe, test, expect } from 'bun:test';
import { worstStatus } from '../../src/dashboard/client/assessors.ts';
import { describePopulationExclusion, pickPopulationMeta } from '../../src/dashboard/client/components/stats-view.tsx';
import type { FetchState } from '../../src/dashboard/client/stats-store.ts';
import type { PopulationMeta } from '../../src/dashboard/stats.ts';

// describeFetchState's tests used to live here (fix round 1, task-3-report.md):
// removed along with the function itself — it had zero production callers
// before this file's Task 3 move and zero after, so the tests were the false
// coverage the extraction was meant to end, not a fixture worth keeping.

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

describe('describePopulationExclusion', () => {
  test('prod view names how many test runs were excluded', () => {
    expect(describePopulationExclusion('prod', 5))
      .toBe('5 test run(s) excluded from this window.');
  });

  test('prod view with nothing excluded says so rather than going silent', () => {
    expect(describePopulationExclusion('prod', 0))
      .toBe('No test runs in this window.');
  });

  test('test view names the population it is showing', () => {
    expect(describePopulationExclusion('test', 200))
      .toBe('Showing test runs only. 200 production review(s) excluded from this window.');
  });

  test('test view with nothing excluded says so rather than going silent', () => {
    expect(describePopulationExclusion('test', 0))
      .toBe('Showing test runs only. No production reviews in this window.');
  });
});

describe('pickPopulationMeta', () => {
  const ready = (population: PopulationMeta['population'], otherPopulationCount: number): FetchState<PopulationMeta> => (
    { status: 'ready', data: { population, otherPopulationCount } }
  );

  test('picks the first ready source', () => {
    expect(pickPopulationMeta(
      { status: 'loading' },
      ready('prod', 12),
      ready('prod', 999),
    )).toEqual({ population: 'prod', otherPopulationCount: 12 });
  });

  test('all still loading -> null, never a guessed number', () => {
    expect(pickPopulationMeta({ status: 'loading' }, { status: 'loading' })).toBeNull();
  });

  test('all errored -> null', () => {
    expect(pickPopulationMeta(
      { status: 'error', message: 'boom' },
      { status: 'error', message: 'boom' },
    )).toBeNull();
  });

  test('no sources at all -> null', () => {
    expect(pickPopulationMeta()).toBeNull();
  });
});
