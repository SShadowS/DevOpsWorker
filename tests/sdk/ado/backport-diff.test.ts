import { describe, test, expect } from 'bun:test';
import { compareDiffs, renderDiffComparison } from '../../../src/sdk/ado/backport.ts';

const f = (path: string, patch: string) => ({ path, patch });

// Same content, different hunk header line numbers — the normal case for a port.
const HUNK_AT_20 = `@@ -20,12 +20,20 @@\n     begin\n-        SalesHeader := GetSalesHeader();\n+        // cached lookup removed\n         PostDocument.OnBeforePost();`;
const HUNK_AT_35 = `@@ -35,12 +35,20 @@\n     begin\n-        SalesHeader := GetSalesHeader();\n+        // cached lookup removed\n         PostDocument.OnBeforePost();`;
const HUNK_DIFFERENT = `@@ -20,12 +20,20 @@\n     begin\n-        SalesHeader := GetSalesHeader();\n+        // cached lookup removed AND a guard dropped\n         PostDocument.OnBeforePost();`;

// Two hunks, same content, in a different order and at different offsets between
// source and port — plausible when the port's surrounding code causes the diff
// engine to split hunks differently. Order across hunks must not matter; order
// WITHIN a hunk (context/added/removed sequence) still does.
const TWO_HUNKS_SOURCE = `@@ -10,3 +10,4 @@\n context line\n-old A\n+new A\n context line\n@@ -50,3 +50,4 @@\n context line\n-old B\n+new B\n context line`;
const TWO_HUNKS_PORT_REORDERED = `@@ -55,3 +56,4 @@\n context line\n-old B\n+new B\n context line\n@@ -12,3 +12,4 @@\n context line\n-old A\n+new A\n context line`;

describe('compareDiffs', () => {
  test('a hunk differing only by line offset compares identical', () => {
    // THE false-positive trap: offsets always shift between release lines. If this
    // reports a difference, every backport looks divergent and the check is noise.
    const c = compareDiffs([f('A.al', HUNK_AT_20)], [f('A.al', HUNK_AT_35)]);
    expect(c.changedFiles).toEqual([{ path: 'A.al', identical: true }]);
    expect(c.missingFromPort).toEqual([]);
    expect(c.extraInPort).toEqual([]);
  });

  test('a hunk differing in content is reported as not identical', () => {
    const c = compareDiffs([f('A.al', HUNK_AT_20)], [f('A.al', HUNK_DIFFERENT)]);
    expect(c.changedFiles).toEqual([{ path: 'A.al', identical: false }]);
  });

  test('a file in the source but not the port is a partial port', () => {
    const c = compareDiffs([f('A.al', HUNK_AT_20), f('B.al', HUNK_AT_20)], [f('A.al', HUNK_AT_20)]);
    expect(c.missingFromPort).toEqual(['B.al']);
  });

  test('a file in the port but not the source is an extra change', () => {
    const c = compareDiffs([f('A.al', HUNK_AT_20)], [f('A.al', HUNK_AT_20), f('C.al', HUNK_AT_20)]);
    expect(c.extraInPort).toEqual(['C.al']);
  });

  test('leading slashes on paths do not create phantom differences', () => {
    // ADO change entries use `/Cloud/...`; other callers use repo-relative paths.
    const c = compareDiffs([f('/Cloud/A.al', HUNK_AT_20)], [f('Cloud/A.al', HUNK_AT_35)]);
    expect(c.missingFromPort).toEqual([]);
    expect(c.extraInPort).toEqual([]);
    expect(c.changedFiles).toEqual([{ path: 'Cloud/A.al', identical: true }]);
  });

  test('hunks reordered within a file compare identical when their content matches', () => {
    // The false-positive trap from a different door: a port can fragment its hunks
    // differently from the source when the target's surrounding code has shifted.
    // If hunk order leaked into the comparison, every such port would falsely report
    // `differs` even though nothing meaningful changed.
    const c = compareDiffs([f('A.al', TWO_HUNKS_SOURCE)], [f('A.al', TWO_HUNKS_PORT_REORDERED)]);
    expect(c.changedFiles).toEqual([{ path: 'A.al', identical: true }]);
  });

  test('paths are compared verbatim in case — a case-only difference is a real difference', () => {
    // Azure Repos is case-sensitive: 'Cloud/A.al' and 'cloud/a.al' are distinct blobs,
    // not a formatting quirk. Folding case here would risk silently treating two
    // genuinely different files as one. This test exists so a future "helpful"
    // normalisation refactor cannot reintroduce case folding without going red.
    const c = compareDiffs([f('Cloud/A.al', HUNK_AT_20)], [f('cloud/a.al', HUNK_AT_20)]);
    expect(c.missingFromPort).toEqual(['Cloud/A.al']);
    expect(c.extraInPort).toEqual(['cloud/a.al']);
    expect(c.changedFiles).toEqual([]);
  });
});

describe('renderDiffComparison', () => {
  test('states plainly when the port is faithful', () => {
    const out = renderDiffComparison({ missingFromPort: [], extraInPort: [], changedFiles: [{ path: 'A.al', identical: true }] });
    expect(out).toContain('A.al');
    expect(out).toContain('identical');
  });

  test('names every discrepancy so the agent can judge each one', () => {
    const out = renderDiffComparison({ missingFromPort: ['B.al'], extraInPort: ['C.al'], changedFiles: [{ path: 'A.al', identical: false }] });
    expect(out).toContain('B.al');
    expect(out).toContain('C.al');
    expect(out).toContain('A.al');
  });

  test('says plainly when there is nothing in common to compare, and does not reference an absent table', () => {
    // Distinguishes "no files missing/extra" (reported per-section as "none") from
    // "no changed files at all" (an empty table would be ambiguous — did the
    // comparison run, or is this a rendering bug?).
    const out = renderDiffComparison({ missingFromPort: [], extraInPort: [], changedFiles: [] });
    expect(out).toContain('No files present in both the source and this port to compare.');
    // The closing paragraph explains the `differs` table — it must not render when
    // there is no table for it to refer to.
    expect(out).not.toContain('Line numbers and context');
  });
});
