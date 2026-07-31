import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkoutBranch, resolveRef } from '../../src/sdk/git-checkout.ts';

let repo: string;
let bareOrigin: string;
let cloneDir: string;
let sessionRoot: string;
const REPO_KEY = 'TestRepo';

/** The branch HEAD is attached to, or '' when HEAD is detached. */
const headBranch = async (cwd: string): Promise<string> => {
  const p = Bun.spawn(['git', 'symbolic-ref', '--short', '-q', 'HEAD'], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'checkout-test-'));
  const run = async (...args: string[]) => {
    const p = Bun.spawn(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' });
    await p.exited;
  };
  await run('init', '-b', 'main');
  await run('config', 'user.email', 't@t');
  await run('config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'main\n');
  await run('add', '.');
  await run('commit', '-m', 'main');
  await run('branch', 'bug/x-on-hotfix-28.3.2');

  // Fixture for the "real clone shape" test: `entrypoint.sh:69` runs
  // `git clone --branch <default>` with no `--single-branch`/`--depth` — a full clone, but
  // only the default branch (`main`) gets a local branch out of the box. Every other branch,
  // including a PR's source branch, exists solely as a remote-tracking ref
  // (`origin/bug/x-...`), so `git checkout bug/x-...` has to DWIM-create the local branch.
  // `repo` above has both branches locally already, so build a bare "origin" from it and
  // clone that fresh to get the shape production actually hands `checkoutBranch`.
  bareOrigin = mkdtempSync(join(tmpdir(), 'checkout-origin-'));
  await run('init', '--bare', '-b', 'main', bareOrigin);
  await run('push', '--quiet', bareOrigin, 'main', 'bug/x-on-hotfix-28.3.2');

  cloneDir = mkdtempSync(join(tmpdir(), 'checkout-clone-'));
  const clone = Bun.spawn(
    ['git', 'clone', '--quiet', '--branch', 'main', bareOrigin, cloneDir],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  await clone.exited;

  // Mirrors the production directory shape exactly: `docker/entrypoint.sh:64`
  // sets `MAIN_REPO_DIR="${SESSION_ROOT}/${REPO_KEY}"` and clones there — the
  // session root itself is never a git repository. A caller that runs
  // `checkoutBranch`/`resolveRef` against the session root directly (instead of
  // session root + repo key) fails EVERY checkout, silently: `route` falls back
  // to the full review, which looks exactly like the fail-safe working as
  // designed. `sessionRoot` here has nothing in it but the `REPO_KEY` clone,
  // same as a fresh container.
  sessionRoot = mkdtempSync(join(tmpdir(), 'checkout-sessionroot-'));
  const nestedClone = Bun.spawn(
    ['git', 'clone', '--quiet', '--branch', 'main', bareOrigin, join(sessionRoot, REPO_KEY)],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  await nestedClone.exited;
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(bareOrigin, { recursive: true, force: true });
  rmSync(cloneDir, { recursive: true, force: true });
  rmSync(sessionRoot, { recursive: true, force: true });
});

describe('checkoutBranch', () => {
  test('checks out a short branch name and returns its sha', async () => {
    const r = await checkoutBranch(repo, 'bug/x-on-hotfix-28.3.2');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test('accepts a full ref, strips refs/heads/, and leaves HEAD attached to the branch', async () => {
    const r = await checkoutBranch(repo, 'refs/heads/bug/x-on-hotfix-28.3.2');
    expect(r.ok).toBe(true);
    // `git checkout refs/heads/X` succeeds too, but detaches HEAD — asserting only `ok: true`
    // cannot tell stripped from unstripped. The caller runs LSP and `git log` against this
    // tree, so an attached branch (not just the right commit) is what actually matters.
    expect(await headBranch(repo)).toBe('bug/x-on-hotfix-28.3.2');
  });

  test('reports a missing branch instead of throwing', async () => {
    const r = await checkoutBranch(repo, 'does/not/exist');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });

  test('reports a non-repository path instead of throwing', async () => {
    const r = await checkoutBranch(tmpdir(), 'main');
    expect(r.ok).toBe(false);
  });

  test('DWIM-creates a local branch from a remote-tracking ref (the real clone shape)', async () => {
    const r = await checkoutBranch(cloneDir, 'bug/x-on-hotfix-28.3.2');
    expect(r.ok).toBe(true);
    expect(await headBranch(cloneDir)).toBe('bug/x-on-hotfix-28.3.2');
  });

  test('refuses a branch name starting with "-" instead of letting git parse it as a flag', async () => {
    const r = await checkoutBranch(repo, '-weird-branch');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('-weird-branch');
  });
});

describe('resolveRef', () => {
  test('resolves a remote-tracking branch to its commit sha', async () => {
    const sha = await resolveRef(cloneDir, 'origin/main');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test('agrees with the sha checkoutBranch reports for the same branch', async () => {
    const checkout = await checkoutBranch(repo, 'bug/x-on-hotfix-28.3.2');
    expect(checkout.ok).toBe(true);
    const resolved = await resolveRef(repo, 'bug/x-on-hotfix-28.3.2');
    if (checkout.ok) expect(resolved).toBe(checkout.sha);
  });

  test('reports null for a ref that does not exist, instead of throwing', async () => {
    const sha = await resolveRef(repo, 'origin/does-not-exist');
    expect(sha).toBeNull();
  });

  test('reports null for a non-repository path instead of throwing', async () => {
    const sha = await resolveRef(tmpdir(), 'main');
    expect(sha).toBeNull();
  });
});

describe('the production directory shape — repo lives one level below the session root', () => {
  // Caught by review: `review-pr.ts` originally passed `config.paths.sessionRoot`
  // (the container's `/workspace/session`) directly to `checkoutBranch`/`resolveRef`,
  // but the entrypoint clones the repo into `${SESSION_ROOT}/${REPO_KEY}` — one level
  // down. The session root itself never has a `.git`. These tests pin the SHAPE
  // rather than a string: the repo subdirectory checks out fine, the session root
  // alone does not.
  test('checking out the repo subdirectory (sessionRoot/repoKey) succeeds', async () => {
    const r = await checkoutBranch(join(sessionRoot, REPO_KEY), 'bug/x-on-hotfix-28.3.2');
    expect(r.ok).toBe(true);
  });

  test('checking out the session root itself fails — it has no .git of its own', async () => {
    const r = await checkoutBranch(sessionRoot, 'bug/x-on-hotfix-28.3.2');
    expect(r.ok).toBe(false);
  });

  test('resolveRef agrees: resolves inside the repo subdirectory, null against the bare session root', async () => {
    const inRepoSubdir = await resolveRef(join(sessionRoot, REPO_KEY), 'origin/main');
    const inSessionRootItself = await resolveRef(sessionRoot, 'origin/main');
    expect(inRepoSubdir).toMatch(/^[0-9a-f]{40}$/);
    expect(inSessionRootItself).toBeNull();
  });
});
