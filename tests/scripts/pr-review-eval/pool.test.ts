import { describe, test, expect } from 'bun:test';
import {
  poolFindings,
  scoreArmAgainstPool,
  type Grade,
} from '../../../scripts/pr-review-eval/pool.ts';

const f = (file: string, location: string, title: string) => ({ file, location, title });

describe('poolFindings', () => {
  test('merges the same finding from two arms into one pooled entry', () => {
    const pool = poolFindings({
      baseline: [f('Cod.al', 'SaveFile', 'Missing timeout')],
      lean: [f('Cod.al', 'SaveFile', 'No timeout configured')],
    });
    expect(pool).toHaveLength(1);
    expect(pool[0]!.raisedBy.sort()).toEqual(['baseline', 'lean']);
  });

  test('keeps findings at different locations separate', () => {
    const pool = poolFindings({
      baseline: [f('Cod.al', 'SaveFile', 'x'), f('Cod.al', 'ReadFile', 'y')],
    });
    expect(pool).toHaveLength(2);
  });

  test('grading is per pooled finding, not per arm occurrence', () => {
    const pool = poolFindings({
      a: [f('X.al', 'P', 'dup')], b: [f('X.al', 'P', 'dup')], c: [f('X.al', 'P', 'dup')],
    });
    expect(pool).toHaveLength(1);
  });

  // --- C4: pooling is PER PR — two PRs must never merge findings ---
  //
  // `keyOf` has no `prId` component at all (a two-arg `keyOf(prId, f)` was
  // the half-plumbed defect this replaces). Safety instead comes from
  // `poolFindings` building a fresh `Map` on every call and having no
  // module-level state — so two separate calls (two PRs) can never leak
  // into each other, even when they share the exact same file+location.
  //
  // Single-line change that would make this fail: hoist `byKey` out of
  // `poolFindings` into module scope (`const byKey = new Map(...)` at the
  // top of pool.ts, function body just reusing it) — the second call would
  // then see the first call's entry already present and merge into it.
  test('two separate poolFindings calls (two PRs) never share state', () => {
    const prA = poolFindings({
      baseline: [f('X.al', 'P', 'dup')],
      lean: [f('X.al', 'P', 'dup')],
    });
    // Same file+location as prA, but on a "different PR" (a separate call)
    // where `lean` never actually raised it.
    const prB = poolFindings({
      baseline: [f('X.al', 'P', 'dup')],
    });

    expect(prA[0]!.raisedBy.sort()).toEqual(['baseline', 'lean']);
    // If poolFindings ever shared a Map across calls, prB would inherit
    // 'lean' from prA's pool even though lean never raised anything on PR B.
    expect(prB[0]!.raisedBy).toEqual(['baseline']);
  });

  // --- C3: dedupe key fallback when location/file are partial or absent ---
  //
  // Measured: across 356 recent findings, `location` appears on 273 and
  // `file` on 314 — neither is universal, so the key must degrade instead
  // of assuming either is always present.

  test('a finding lacking location still keys correctly via file+line', () => {
    const pool = poolFindings({
      baseline: [{ file: 'Cod.al', line: 42, title: 'Missing timeout' }],
      lean: [{ file: 'Cod.al', line: 42, title: 'No timeout configured' }],
    });
    expect(pool).toHaveLength(1);
    expect(pool[0]!.raisedBy.sort()).toEqual(['baseline', 'lean']);
    expect(pool[0]!.line).toBe(42);
  });

  test('file+line and file+location are different keys even at the same line', () => {
    // Guards against a fallback that ignores `location` when `line` is ALSO
    // present and collapses both representations of "the same spot" into
    // one key regardless of which coordinate was actually supplied.
    const pool = poolFindings({
      withLocation: [{ file: 'Cod.al', line: 42, location: 'SaveFile', title: 'x' }],
      withLineOnly: [{ file: 'Cod.al', line: 42, title: 'y' }],
    });
    expect(pool).toHaveLength(2);
  });

  test('a finding lacking both location and file+line lands in a defined bucket, not dropped', () => {
    const pool = poolFindings({
      baseline: [{ title: 'Some vague concern' }],
    });
    expect(pool).toHaveLength(1);
    expect(pool[0]!.key).toContain('unlocated');
    expect(pool[0]!.raisedBy).toEqual(['baseline']);
  });

  test('two different unlocated findings with different titles do not collapse into one', () => {
    const pool = poolFindings({
      baseline: [{ title: 'Concern A' }, { title: 'Concern B' }],
    });
    expect(pool).toHaveLength(2);
  });
});

describe('scoreArmAgainstPool', () => {
  const pool = poolFindings({
    baseline: [f('A.al', 'P1', 'real one'), f('A.al', 'P2', 'noise')],
    lean: [f('A.al', 'P1', 'real one')],
  });
  const grades: Record<string, Grade> = {
    [pool.find((p) => p.location === 'P1')!.key]: 'real-bug',
    [pool.find((p) => p.location === 'P2')!.key]: 'false-positive',
  };

  test('counts a real finding the arm raised as caught', () => {
    expect(scoreArmAgainstPool('lean', pool, grades).caught).toBe(1);
  });

  test('counts a real finding the arm did NOT raise as missed', () => {
    const withExtra = poolFindings({
      baseline: [f('A.al', 'P1', 'r'), f('A.al', 'P3', 'also real')],
      lean: [f('A.al', 'P1', 'r')],
    });
    const g: Record<string, Grade> = Object.fromEntries(withExtra.map((p) => [p.key, 'real-bug']));
    expect(scoreArmAgainstPool('lean', withExtra, g).missed).toBe(1);
  });

  test('counts a false-positive the arm raised against it', () => {
    expect(scoreArmAgainstPool('baseline', pool, grades).falsePositives).toBe(1);
  });

  test('nits count as neither caught nor false-positive', () => {
    const g: Record<string, Grade> = { ...grades, [pool.find((p) => p.location === 'P2')!.key]: 'nit' };
    const s = scoreArmAgainstPool('baseline', pool, g);
    expect(s.falsePositives).toBe(0);
    expect(s.nits).toBe(1);
  });

  // --- C5: 'unverifiable' must be excluded from caught/missed/falsePositives/nits ---
  //
  // Single-line change that would make the first test below fail: add an
  // `else if (grade === 'unverifiable') { if (raised) caught++; }` branch
  // (i.e. treat an unverifiable-and-raised finding as caught instead of
  // tracking it separately) — the exact "diff-only judge coerced into
  // guessing real-bug" failure C5 exists to prevent.
  test('an unverifiable finding raised by the arm counts toward unverifiable, not caught/missed/falsePositives/nits', () => {
    const p = poolFindings({ lean: [f('A.al', 'P1', 'cross-file claim')] });
    const g: Record<string, Grade> = { [p[0]!.key]: 'unverifiable' };
    const s = scoreArmAgainstPool('lean', p, g);
    expect(s.caught).toBe(0);
    expect(s.missed).toBe(0);
    expect(s.falsePositives).toBe(0);
    expect(s.nits).toBe(0);
    expect(s.unverifiable).toBe(1);
  });

  test('an unverifiable finding does not debit an arm that did not raise it — no false "missed"', () => {
    const p = poolFindings({ baseline: [f('A.al', 'P1', 'cross-file claim')] });
    const g: Record<string, Grade> = { [p[0]!.key]: 'unverifiable' };
    const s = scoreArmAgainstPool('lean', p, g); // lean never raised it
    expect(s.missed).toBe(0);
    expect(s.unverifiable).toBe(0); // not lean's finding — not counted against lean either
  });

  test('a key absent from grades entirely (not yet graded) is excluded from every counter', () => {
    const p = poolFindings({ lean: [f('A.al', 'P1', 'ungraded')] });
    const s = scoreArmAgainstPool('lean', p, {});
    expect(s).toEqual({ arm: 'lean', caught: 0, missed: 0, falsePositives: 0, nits: 0, unverifiable: 0 });
  });
});
