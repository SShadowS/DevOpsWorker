import { describe, test, expect } from 'bun:test';
import { formatPct } from '../../src/dashboard/client/format.ts';

// Only formatPct is covered here — the pre-existing formatters in format.ts
// (formatCost, formatDuration, etc.) predate this file and are untouched by
// Task 6; this file exists because formatPct was just promoted out of
// stats-view.tsx (Task 4) once a second/third consumer (this task's dispatch
// and findings-integrity mismatch rates) needed the exact same formatting.

describe('formatPct', () => {
  test('null -> "n/a", never a fake 0%', () => {
    expect(formatPct(null)).toBe('n/a');
  });

  test('0 -> "0.0%", a real distinct fact from unknown', () => {
    expect(formatPct(0)).toBe('0.0%');
  });

  test('a fractional rate -> one decimal place percentage', () => {
    expect(formatPct(0.691)).toBe('69.1%');
  });

  test('1 -> "100.0%"', () => {
    expect(formatPct(1)).toBe('100.0%');
  });
});
