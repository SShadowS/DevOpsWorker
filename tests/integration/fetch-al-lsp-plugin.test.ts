import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SCRIPT = join(import.meta.dir, '../../docker/fetch-al-lsp-plugin.sh');

// With no AL_LSP_PLUGIN_REF the script resolves the newest v* release to its
// commit. Computed here the same way, so the test follows new releases instead of
// pinning one.
function newestReleaseCommit(): string {
  const out = Bun.spawnSync(['git', 'ls-remote', '--tags', 'https://github.com/SShadowS/claude-code-lsps.git', 'v*'])
    .stdout.toString().trim().split(/\r?\n/).map((l) => l.split(/\s+/));
  const plain = new Map<string, string>();
  const peeled = new Map<string, string>();
  for (const [sha, ref] of out) {
    const name = ref!.replace('refs/tags/', '');
    if (name.endsWith('^{}')) peeled.set(name.slice(0, -3), sha!);
    else plain.set(name, sha!);
  }
  const byVersion = (a: string, b: string) => Bun.semver.order(a.replace(/^v/, ''), b.replace(/^v/, ''));
  const newest = [...plain.keys()].sort(byVersion).at(-1)!;
  return peeled.get(newest) ?? plain.get(newest)!;
}
const NEWEST = newestReleaseCommit();

// An older, non-tip commit from v1.12.2 — used to prove the script can land on
// a ref that is not whatever the clone already has checked out.
//
// v1.12.2 is an ANNOTATED tag: `git ls-remote --tags` reports two SHAs for
// it — a25d0192d3bb08131c8894c2e856c47130222b43 for `refs/tags/v1.12.2` (the
// tag OBJECT) and 77a74292840a0c1f8032a5754314b14099e11f38 for
// `refs/tags/v1.12.2^{}` (the commit it points to). `git cat-file -t` on the
// former returns `tag`, not `commit`. Passing the tag object as
// AL_LSP_PLUGIN_REF makes `git checkout --detach` resolve it to the commit,
// so `rev-parse HEAD` afterward reports the commit SHA — which then never
// equals the tag-object ref the script was asked to pin, and the script's
// own verification step correctly rejects it (exit 1). That is a real
// behaviour worth having, but it means the tag object SHA cannot be used as
// a "valid older ref" in a test expecting success. Use the peeled commit SHA.
const OLDER_VALID_COMMIT = '77a74292840a0c1f8032a5754314b14099e11f38';

// The tag OBJECT SHA itself — see the comment above. Passing this as
// AL_LSP_PLUGIN_REF is the one bad-ref case the all-zeros test below cannot
// reach: `git checkout --detach` on it SUCCEEDS (verified directly:
// `git cat-file -t` reports `tag`, and `checkout --detach` exits 0), landing
// HEAD on OLDER_VALID_COMMIT rather than on this SHA. Only the script's
// post-checkout `rev-parse HEAD` == `PLUGIN_REF` comparison catches that
// mismatch and refuses to install it. The all-zeros ref, by contrast, fails
// at `checkout` itself under `set -e` and never reaches that comparison, so
// it cannot prove the verification block is doing anything.
const TAG_OBJECT_SHA = 'a25d0192d3bb08131c8894c2e856c47130222b43';

function run(cacheDir: string, ref?: string) {
  return Bun.spawnSync(['bash', SCRIPT, cacheDir], {
    env: { ...process.env, ...(ref ? { AL_LSP_PLUGIN_REF: ref } : {}) },
  });
}

function headSha(repoDir: string): string {
  return Bun.spawnSync(['git', '-C', repoDir, 'rev-parse', 'HEAD'])
    .stdout.toString().trim();
}

function isShallow(repoDir: string): boolean {
  return Bun.spawnSync(['git', '-C', repoDir, 'rev-parse', '--is-shallow-repository'])
    .stdout.toString().trim() === 'true';
}

describe('fetch-al-lsp-plugin', () => {
  test('with no override, checks out the newest release commit', () => {
    const cache = mkdtempSync(join(tmpdir(), 'al-lsp-pin-'));
    try {
      const r = run(cache);
      expect(r.exitCode).toBe(0);
      const repo = join(cache, 'al-lsp-plugin');
      expect(existsSync(join(repo, '.git'))).toBe(true);
      expect(headSha(repo)).toBe(NEWEST);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  }, 300_000);

  test('a second run stays on the newest release', () => {
    const cache = mkdtempSync(join(tmpdir(), 'al-lsp-idem-'));
    try {
      expect(run(cache).exitCode).toBe(0);
      expect(run(cache).exitCode).toBe(0);
      expect(headSha(join(cache, 'al-lsp-plugin'))).toBe(NEWEST);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  }, 300_000);

  test('an older cached plugin moves up to the newest release', () => {
    const cache = mkdtempSync(join(tmpdir(), 'al-lsp-upgrade-'));
    try {
      expect(run(cache, OLDER_VALID_COMMIT).exitCode).toBe(0);
      expect(run(cache).exitCode).toBe(0);
      expect(headSha(join(cache, 'al-lsp-plugin'))).toBe(NEWEST);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  }, 300_000);

  test('fails loudly when the ref does not exist', () => {
    const cache = mkdtempSync(join(tmpdir(), 'al-lsp-bad-'));
    try {
      const r = run(cache, '0000000000000000000000000000000000000000');
      expect(r.exitCode).not.toBe(0);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  }, 300_000);

  // Regression test for the post-checkout verification block. Unlike the
  // all-zeros ref above — which dies at `checkout` and never reaches
  // verification — an annotated tag OBJECT's SHA makes `checkout --detach`
  // succeed onto the tag's target commit, so only the script's own
  // `rev-parse HEAD` == `PLUGIN_REF` check catches the mismatch. Deleting
  // that check would leave every other test in this file green; this is the
  // one that actually depends on it.
  test('rejects an annotated tag object even though checkout succeeds onto its target commit', () => {
    const cache = mkdtempSync(join(tmpdir(), 'al-lsp-tagobj-'));
    try {
      const r = run(cache, TAG_OBJECT_SHA);
      expect(r.exitCode).not.toBe(0);
      const output = r.stdout.toString() + r.stderr.toString();
      // Distinguishes "verification block caught the mismatch" from any
      // other reason the script might exit non-zero (e.g. a network or
      // checkout failure), so a passing test actually pins down which
      // failure occurred.
      expect(output).toContain('refusing to install it');
      expect(output).toContain(OLDER_VALID_COMMIT);
      expect(output).toContain(TAG_OBJECT_SHA);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  }, 300_000);

  // Regression test for a shallow-clone failure. Old /state caches were
  // created by a former entrypoint's `git clone --depth 1`, so they are
  // shallow. `git fetch origin` on a shallow repo does not deepen it, so
  // checking out a commit that isn't the shallow tip fails with "fatal:
  // unable to read tree" — confirmed against the pre-fix script (commit
  // a3f80df): exit 128.
  test('recovers from a pre-existing shallow clone when the ref is not the shallow tip', () => {
    const cache = mkdtempSync(join(tmpdir(), 'al-lsp-shallow-'));
    try {
      const repo = join(cache, 'al-lsp-plugin');
      const seed = Bun.spawnSync([
        'git', 'clone', '--quiet', '--depth', '1',
        'https://github.com/SShadowS/claude-code-lsps.git', repo,
      ]);
      expect(seed.exitCode).toBe(0);
      // The two properties the test depends on: a shallow clone, checked out
      // somewhere other than OLDER_VALID_COMMIT.
      expect(isShallow(repo)).toBe(true);
      expect(headSha(repo)).not.toBe(OLDER_VALID_COMMIT);

      const r = run(cache, OLDER_VALID_COMMIT);
      expect(r.exitCode).toBe(0);
      expect(headSha(repo)).toBe(OLDER_VALID_COMMIT);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  }, 300_000);

  test('honours AL_LSP_PLUGIN_REF for a valid non-default ref on a fresh cache', () => {
    const cache = mkdtempSync(join(tmpdir(), 'al-lsp-override-'));
    try {
      const r = run(cache, OLDER_VALID_COMMIT);
      expect(r.exitCode).toBe(0);
      const head = headSha(join(cache, 'al-lsp-plugin'));
      expect(head).toBe(OLDER_VALID_COMMIT);
      expect(head).not.toBe(NEWEST);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  }, 300_000);
});
