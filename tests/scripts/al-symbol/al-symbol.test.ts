import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { scanAlFiles, formatDefinitions, formatCallers, formatCallees, resolveRoot } from '../../../scripts/al-symbol.ts';
import { findDefinition } from '../../../scripts/al-symbol/resolver.ts';

const FIXTURES = join(import.meta.dir, '../../fixtures/al-symbol');

// ---------------------------------------------------------------------------
// The file scan must see dot-directories.
//
// Bun's Glob skips them by default. In these repos the companion apps' source
// is vendored under `.dependencies/`, so the default behaviour made the
// resolver blind to every callee that lives in another app — measured on a real
// clone: `find` sees 1280 .al files, the glob saw 1082, and none of the missing
// 198 were visible to a `def` lookup. Scoping the root INTO the dot-directory
// worked, which is what disguised it: the same symbol resolved or not depending
// on where you stood.
// ---------------------------------------------------------------------------
describe('scanAlFiles', () => {
  test('includes files under a dot-directory', () => {
    const files = scanAlFiles(FIXTURES);
    expect(files.some((f) => f.includes('.dependencies'))).toBe(true);
  });

  test('still finds the ordinary files beside them', () => {
    const files = scanAlFiles(FIXTURES);
    expect(files.some((f) => f.endsWith('InsertFileArchive.Codeunit.al'))).toBe(true);
  });

  test('a symbol that exists ONLY under the dot-directory resolves', () => {
    const defs = findDefinition('VendoredOnlyProc', scanAlFiles(FIXTURES));
    expect(defs).toHaveLength(1);
    expect(defs[0]!.file).toContain('.dependencies');
  });
});

// ---------------------------------------------------------------------------
// Ambiguous lookups must stay readable.
//
// `def` printed the full body of every match. On a real repo, one lookup of a
// common test-library name returned 33 bodies — 28 KB, 515 lines — into the
// agent's context for a single question. Beyond a few matches the bodies stop
// being an answer and become a haystack, so past that point print where they
// are and let the caller narrow.
// ---------------------------------------------------------------------------
function fakeDefs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    file: `/repo/File${i}.Codeunit.al`,
    line: i + 1,
    body: `procedure Thing()\n    begin\n        // body line ${i}\n    end;`,
  }));
}

describe('formatDefinitions', () => {
  test('one match prints the whole body', () => {
    const out = formatDefinitions('Thing', fakeDefs(1));
    expect(out).toContain('/repo/File0.Codeunit.al:1');
    expect(out).toContain('// body line 0');
  });

  test('a couple of matches still print bodies — that is the useful case', () => {
    const out = formatDefinitions('Thing', fakeDefs(3));
    expect(out).toContain('ambiguous: 3 definitions');
    expect(out).toContain('// body line 2');
  });

  test('many matches print locations only, not bodies', () => {
    const out = formatDefinitions('Thing', fakeDefs(33));
    expect(out).toContain('ambiguous: 33 definitions');
    expect(out).not.toContain('// body line');
  });

  test('many matches still name every location, so nothing is hidden', () => {
    const out = formatDefinitions('Thing', fakeDefs(33));
    expect(out).toContain('/repo/File0.Codeunit.al:1');
    expect(out).toContain('/repo/File32.Codeunit.al:33');
  });

  test('many matches say how to narrow, rather than leaving the caller stuck', () => {
    const out = formatDefinitions('Thing', fakeDefs(33));
    expect(out).toMatch(/--root|Read/);
  });

  test('the bounded form stays small — the whole point', () => {
    const out = formatDefinitions('Thing', fakeDefs(33));
    expect(out.length).toBeLessThan(4000);
  });

  test('no match says so plainly', () => {
    expect(formatDefinitions('Thing', [])).toContain("No definition found for 'Thing'");
  });
});

// ---------------------------------------------------------------------------
// `callers` needs the same bound as `def`.
//
// Measured on a real clone: `callers Insert` printed 1229 lines / 145 KB. A
// common AL name (Insert, Get, Run, FindFirst) is exactly the kind an agent
// reaches for, and one lookup at that size costs more context than the review
// it is meant to inform.
// ---------------------------------------------------------------------------
function fakeCallers(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    file: `/repo/File${i}.Codeunit.al`,
    line: i + 1,
    proc: `Caller${i}`,
  }));
}

describe('formatCallers', () => {
  test('a handful print in full', () => {
    const out = formatCallers('Thing', fakeCallers(4));
    expect(out).toContain('/repo/File0.Codeunit.al:1  Caller0');
    expect(out).toContain('/repo/File3.Codeunit.al:4  Caller3');
  });

  test('a flood is summarised by file rather than listed call by call', () => {
    const out = formatCallers('Insert', fakeCallers(1229));
    expect(out).toContain('1229');
    expect(out.length).toBeLessThan(8000);
  });

  test('the flood form still says how to see the rest', () => {
    const out = formatCallers('Insert', fakeCallers(1229));
    expect(out).toMatch(/--root/);
  });

  test('none says so plainly', () => {
    expect(formatCallers('Thing', [])).toContain("No callers found for 'Thing'");
  });
});

// ---------------------------------------------------------------------------
// "No callees" and "no such procedure here" are different answers.
//
// Both printed the same line. For an agent they mean opposite things: one says
// stop looking, the other says you are in the wrong file. Conflating them
// invites a finding built on "I checked and it calls nothing".
// ---------------------------------------------------------------------------
describe('formatCallees', () => {
  test('a procedure with callees lists them', () => {
    expect(formatCallees('Foo', 'f.al', { found: true, callees: ['Get', 'Insert'] })).toContain('Get');
  });

  test('a procedure with no callees says exactly that', () => {
    const out = formatCallees('Foo', 'f.al', { found: true, callees: [] });
    expect(out).toContain('calls nothing');
  });

  test('a procedure that is not in the file says THAT instead', () => {
    const out = formatCallees('Foo', 'f.al', { found: false, callees: [] });
    expect(out).toMatch(/not found|no procedure/i);
    expect(out).not.toContain('calls nothing');
  });
});

// ---------------------------------------------------------------------------
// --root must be a directory.
//
// The tool's own hint says "narrow with --root <dir>", and the obvious next
// move after seeing a file path in the output is to paste that path back in.
// Doing so produced a raw `ENOTDIR: not a directory, open ...`, which tells an
// agent nothing about what to do instead.
// ---------------------------------------------------------------------------
describe('resolveRoot', () => {
  test('accepts a directory', () => {
    expect(resolveRoot(FIXTURES)).toBe(FIXTURES);
  });

  test('rejects a file with a message that names the fix', () => {
    const file = join(FIXTURES, 'InsertFileArchive.Codeunit.al');
    expect(() => resolveRoot(file)).toThrow(/directory/i);
  });

  test('rejects a path that does not exist', () => {
    expect(() => resolveRoot(join(FIXTURES, 'no-such-dir'))).toThrow(/does not exist|directory/i);
  });
});
