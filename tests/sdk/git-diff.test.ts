import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { diffCommits } from '../../src/sdk/git-diff.ts';
import { compareDiffs } from '../../src/sdk/ado/backport.ts';

// ---------------------------------------------------------------------------
// Real git repositories, no mocks anywhere in this file — on purpose.
//
// The bug this replaces was a mocked `fetch` asserting a URL that 404s and a
// response shape no API ever returned. A mock can only confirm our own request
// against our own imagined reply. Everything below runs actual git and reads
// actual diff output, so it is evidence about the mechanism rather than about
// the test's own assumptions.
// ---------------------------------------------------------------------------

let repo: string;
let bareOrigin: string;
let cloneDir: string;

/** Commits in `repo`, in creation order. */
const sha: Record<string, string> = {};

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const p = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'gitdiff-test-'));
  const run = (...args: string[]) => git(repo, ...args);

  await run('init', '-b', 'main');
  await run('config', 'user.email', 't@t');
  await run('config', 'user.name', 't');

  // Base commit.
  mkdirSync(join(repo, 'Cloud'), { recursive: true });
  mkdirSync(join(repo, 'Test'), { recursive: true });
  writeFileSync(join(repo, 'Cloud', 'A.al'), 'one\ntwo\nthree\nfour\nfive\n');
  writeFileSync(join(repo, 'Test', 'B.al'), 'alpha\nbeta\n');
  writeFileSync(join(repo, 'keep.txt'), 'untouched\n');
  await run('add', '.');
  await run('commit', '-m', 'base');
  sha['base'] = await run('rev-parse', 'HEAD');

  // The "source PR": edits two files, adds a third, leaves keep.txt alone.
  writeFileSync(join(repo, 'Cloud', 'A.al'), 'one\ntwo\nCHANGED\nfour\nfive\n');
  writeFileSync(join(repo, 'Test', 'B.al'), 'alpha\nbeta\ngamma\n');
  writeFileSync(join(repo, 'Cloud', 'New.al'), 'brand new\n');
  await run('add', '.');
  await run('commit', '-m', 'source head');
  sha['head'] = await run('rev-parse', 'HEAD');

  // A path with glob metacharacters, and a binary file, on their own commit —
  // still on main, so `head -> weird` is exactly this commit's own change.
  writeFileSync(join(repo, 'Cloud', 'Weird[1].al'), 'literal pathspec\n');
  writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 7]));
  await run('add', '.');
  await run('commit', '-m', 'glob path + binary');
  sha['weird'] = await run('rev-parse', 'HEAD');

  // The "port": the same two edits as `head`, but a DIFFERENT edit to A.al.
  // Deliberately on a side branch that is never pushed as a branch — that is what
  // makes it absent from a fresh clone below, standing in for a squash-merged
  // source PR whose branch was deleted.
  await run('checkout', '--quiet', '-b', 'divergent', sha['base']!);
  writeFileSync(join(repo, 'Cloud', 'A.al'), 'one\ntwo\nSOMETHING ELSE\nfour\nfive\n');
  writeFileSync(join(repo, 'Test', 'B.al'), 'alpha\nbeta\ngamma\n');
  writeFileSync(join(repo, 'Cloud', 'New.al'), 'brand new\n');
  await run('add', '.');
  await run('commit', '-m', 'divergent head');
  sha['divergent'] = await run('rev-parse', 'HEAD');
  await run('checkout', '--quiet', 'main');

  // Production clone shape: `entrypoint.sh` runs `git clone --branch <default>`,
  // which fetches `refs/heads/*` and NOTHING else. A commit that lives only under
  // `refs/pull/*` is therefore absent from a fresh clone — which is exactly what a
  // squash-merged source PR with a deleted branch leaves behind.
  bareOrigin = mkdtempSync(join(tmpdir(), 'gitdiff-origin-'));
  await run('init', '--bare', '-b', 'main', bareOrigin);
  await run('push', '--quiet', bareOrigin, 'main');
  // Park the divergent commit under refs/pull and nowhere else. It is not an
  // ancestor of `main`, and `refs/pull/*` is not `refs/heads/*`, so a clone does not
  // fetch it — the precondition the recovery tests below assert explicitly.
  await run('push', '--quiet', bareOrigin, `${sha['divergent']}:refs/pull/4242/merge`);

  cloneDir = mkdtempSync(join(tmpdir(), 'gitdiff-clone-'));
  await cloneFromOrigin(cloneDir);
});

/**
 * `--no-local` is load-bearing, not noise. Cloning a local PATH normally takes the
 * local shortcut and hardlinks the ENTIRE object database across, unreferenced
 * objects included — so the fixture's parked `refs/pull` commit would arrive anyway
 * and the recovery tests below would pass without the recovery ever running.
 * `--no-local` forces the real transport, which honours the refspec
 * (`refs/heads/*`) and leaves `refs/pull/*` behind, exactly like the container's
 * clone over https.
 */
async function cloneFromOrigin(dest: string): Promise<void> {
  const p = Bun.spawn(
    ['git', 'clone', '--quiet', '--no-local', '--branch', 'main', bareOrigin, dest],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  await p.exited;
}

afterAll(() => {
  for (const d of [repo, bareOrigin, cloneDir]) rmSync(d, { recursive: true, force: true });
});

describe('diffCommits', () => {
  test('returns one entry per changed file, with a real unified-diff patch', async () => {
    const r = await diffCommits(repo, sha['base']!, sha['head']!);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.files.map((f) => f.path).sort()).toEqual(['Cloud/A.al', 'Cloud/New.al', 'Test/B.al']);
    for (const f of r.files) expect(f.patch).toMatch(/^@@ /m);

    const a = r.files.find((f) => f.path === 'Cloud/A.al')!;
    expect(a.patch).toContain('-three');
    expect(a.patch).toContain('+CHANGED');
    // An unchanged file must not appear at all.
    expect(r.files.some((f) => f.path === 'keep.txt')).toBe(false);
  });

  test('paths are repo-relative with no a/ or b/ prefix, which is what compareDiffs normalises', async () => {
    // `normalisePath` strips a LEADING SLASH and flips backslashes; it does not
    // strip git's `a/`/`b/` prefixes. So the path must come from the file list,
    // never from parsing `diff --git a/X b/X` — otherwise every path would be
    // `a/Cloud/A.al` and every file would read as missing from both sides.
    const r = await diffCommits(repo, sha['base']!, sha['head']!);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const f of r.files) {
      expect(f.path.startsWith('a/')).toBe(false);
      expect(f.path.startsWith('b/')).toBe(false);
      expect(f.path.startsWith('/')).toBe(false);
    }
  });

  test('a path containing glob metacharacters resolves to exactly that file', async () => {
    // `:(top,literal)` is what stops git reading `Weird[1].al` as a character
    // class. Without it this file silently vanishes from the comparison.
    const r = await diffCommits(repo, sha['head']!, sha['weird']!);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files.map((f) => f.path)).toContain('Cloud/Weird[1].al');
  });

  test('a binary file is skipped rather than emitted with an unparseable patch', async () => {
    // Same semantics as the REST-shaped predecessor, which dropped entries with no
    // `patch`. It stays symmetric: source and port are read the same way.
    const r = await diffCommits(repo, sha['head']!, sha['weird']!);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files.some((f) => f.path === 'blob.bin')).toBe(false);
  });

  test('rejects anything that is not a 40-character sha instead of passing it to argv', async () => {
    // Stands in for `--end-of-options`, which is NOT used — for reasons that differ
    // per command, so neither is claimed here as a blanket version rule:
    //   `git diff --name-only --end-of-options A B` works on 2.39.5 and on 2.53;
    //   only misplacing it (after the revisions) fails, and it fails on BOTH.
    //   `git checkout --end-of-options <branch>` is the real version difference —
    //   2.39.5 reads it as a literal pathspec.
    // Validating the shape is stronger than either and version-independent.
    for (const bad of ['--upload-pack=evil', 'HEAD', '', 'a5d7a9ad', `${sha['base']!}^`]) {
      const r = await diffCommits(repo, bad, sha['head']!);
      expect(r.ok).toBe(false);
    }
  });

  test('reports an absent commit instead of throwing', async () => {
    // "Absent", not "unreachable": `git diff` cares about PRESENCE in the object
    // database, not reachability from a ref. A commit reachable from nothing still
    // diffs fine, which is why `cat-file -e` is the predicate rather than a
    // reachability check.
    const absent = '1234567890123456789012345678901234567890';
    const r = await diffCommits(repo, absent, sha['head']!);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(absent);
  });

  test('a broken cwd is reported as such, NOT as an absent commit', async () => {
    // `findMissing` reads only exit codes, so before the `rev-parse --git-dir`
    // probe both of these produced "commit(s) not present in the clone" — a message
    // that sends a human hunting through Azure DevOps for a commit that is fine.
    // The failure mode this guards is real: an earlier review of this feature caught
    // `sessionRoot` being passed where `sessionRoot/repoKey` was meant, which would
    // have made EVERY review report phantom missing commits.
    for (const badCwd of [tmpdir(), join(tmpdir(), 'definitely', 'not', 'here')]) {
      const r = await diffCommits(badCwd, sha['base']!, sha['head']!);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).not.toContain('not present in the clone');
        expect(r.error.toLowerCase()).toMatch(/not a git repository|no such file|enoent/);
      }
    }
  });

  test('two commits with no changes between them give an empty file list, not an error', async () => {
    const r = await diffCommits(repo, sha['head']!, sha['head']!);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files).toEqual([]);
  });
});

describe('recovering a commit that a fresh clone does not have', () => {
  test('a commit reachable only via refs/pull is missing until the recover ref is fetched', async () => {
    // Establish the precondition honestly: without the fallback this genuinely fails.
    const without = await diffCommits(cloneDir, sha['base']!, sha['divergent']!);
    expect(without.ok).toBe(false);
    if (!without.ok) expect(without.error).toContain(sha['divergent']!);
  });

  test('fetching refs/pull/<id>/merge makes it diffable', async () => {
    const r = await diffCommits(cloneDir, sha['base']!, sha['divergent']!, [
      'refs/pull/4242/merge',
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files.map((f) => f.path).sort()).toEqual(['Cloud/A.al', 'Cloud/New.al', 'Test/B.al']);
  });

  test('a recover ref that does not exist fails cleanly rather than throwing', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'gitdiff-clone2-'));
    await cloneFromOrigin(fresh);
    try {
      const r = await diffCommits(fresh, sha['base']!, sha['divergent']!, [
        'refs/pull/999999/merge',
      ]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('tried fetching');
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe('end to end: git output feeds compareDiffs', () => {
  // The join this whole fix exists to make work. `compareDiffs` was written
  // against a shape composed by the ADO MCP server; these assert that real `git
  // diff` output drives it to the right answers.

  test('a diff compared with itself is identical on every file', async () => {
    const r = await diffCommits(repo, sha['base']!, sha['head']!);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const c = compareDiffs(r.files, r.files);
    expect(c.missingFromPort).toEqual([]);
    expect(c.extraInPort).toEqual([]);
    expect(c.changedFiles.length).toBe(3);
    expect(c.changedFiles.every((f) => f.identical)).toBe(true);
  });

  test('a genuinely different edit to the same file reads as differing', async () => {
    const source = await diffCommits(repo, sha['base']!, sha['head']!);
    const port = await diffCommits(repo, sha['base']!, sha['divergent']!);
    expect(source.ok && port.ok).toBe(true);
    if (!source.ok || !port.ok) return;

    const c = compareDiffs(source.files, port.files);
    const a = c.changedFiles.find((f) => f.path === 'Cloud/A.al');
    expect(a?.identical).toBe(false);
    // The files both sides touched identically must still read as identical, so
    // the check discriminates rather than just flagging everything.
    expect(c.changedFiles.find((f) => f.path === 'Test/B.al')?.identical).toBe(true);
  });

  test('a file changed in the source but not the port shows up as missing', async () => {
    const source = await diffCommits(repo, sha['base']!, sha['head']!);
    expect(source.ok).toBe(true);
    if (!source.ok) return;

    const port = source.files.filter((f) => f.path !== 'Cloud/New.al');
    const c = compareDiffs(source.files, port);
    expect(c.missingFromPort).toEqual(['Cloud/New.al']);
    expect(c.extraInPort).toEqual([]);
  });

  test('line offsets alone do not make two ports differ', async () => {
    // The property `contentSignature` exists for: a port lands the same edit at a
    // different line because the target branch has drifted. Build that case with
    // real git rather than by hand — a shifted file whose CHANGE is identical.
    const shifted = mkdtempSync(join(tmpdir(), 'gitdiff-shift-'));
    try {
      const run = (...args: string[]) => git(shifted, ...args);
      await run('init', '-b', 'main');
      await run('config', 'user.email', 't@t');
      await run('config', 'user.name', 't');
      mkdirSync(join(shifted, 'Cloud'), { recursive: true });
      // Same file, but preceded by extra lines so every hunk header shifts.
      writeFileSync(join(shifted, 'Cloud', 'A.al'), 'pad\npad\npad\npad\none\ntwo\nthree\nfour\nfive\n');
      await run('add', '.');
      await run('commit', '-m', 'base');
      const b = await run('rev-parse', 'HEAD');
      writeFileSync(join(shifted, 'Cloud', 'A.al'), 'pad\npad\npad\npad\none\ntwo\nCHANGED\nfour\nfive\n');
      await run('add', '.');
      await run('commit', '-m', 'head');
      const h = await run('rev-parse', 'HEAD');

      const source = await diffCommits(repo, sha['base']!, sha['head']!);
      const port = await diffCommits(shifted, b, h);
      expect(source.ok && port.ok).toBe(true);
      if (!source.ok || !port.ok) return;

      // Sanity-check the premise: the raw patches really are different text.
      const srcA = source.files.find((f) => f.path === 'Cloud/A.al')!;
      const prtA = port.files.find((f) => f.path === 'Cloud/A.al')!;
      expect(srcA.patch).not.toBe(prtA.patch);

      const c = compareDiffs([srcA], [prtA]);
      expect(c.changedFiles).toEqual([{ path: 'Cloud/A.al', identical: true }]);
    } finally {
      rmSync(shifted, { recursive: true, force: true });
    }
  });
});
