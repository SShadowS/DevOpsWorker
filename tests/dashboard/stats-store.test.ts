import { describe, test, expect } from 'bun:test';
import { classifyWindowedResponse } from '../../src/dashboard/client/stats-store.ts';

describe('classifyWindowedResponse', () => {
  test('sampleSize 0 -> empty (no data in this window, not an error)', () => {
    const result = classifyWindowedResponse({ sampleSize: 0, foo: 'bar' });
    expect(result).toEqual({ status: 'empty' });
  });

  test('sampleSize > 0 -> ready, carrying the full payload', () => {
    const data = { sampleSize: 5, foo: 'bar' };
    const result = classifyWindowedResponse(data);
    expect(result).toEqual({ status: 'ready', data });
  });

  test('does not mutate or drop fields on the ready path', () => {
    const data = { sampleSize: 1, nested: { a: 1 }, list: [1, 2, 3] };
    const result = classifyWindowedResponse(data);
    expect(result).toEqual({ status: 'ready', data });
    if (result.status === 'ready') {
      expect(result.data).toBe(data); // same reference — no cloning
    }
  });
});
