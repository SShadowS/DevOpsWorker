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

// Fixture for the completed-PR shape: the PR's source branch is GONE and only the
// merge commit survives. See the describe block at the bottom for why.
let deletedBranchClone: string;
let deletedBranchOrigin: string;
let mergeSha = '';
const DELETED_BRANCH = 'bug/x-ported-to-development';

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

  // ---- Completed-PR fixture -------------------------------------------------
  // Azure DevOps completes PRs here with `deleteSourceBranch: true` and
  // `squashMerge: true`. Reproduce exactly that: build the change on a branch,
  // squash it onto main (so the branch's own commits are NOT in main's history),
  // then delete the branch from the origin before cloning.
  const runIn = async (cwd: string, ...args: string[]) => {
    const p = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    await p.exited;
  };
  const capture = async (cwd: string, ...args: string[]): Promise<string> => {
    const p = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out.trim();
  };

  await runIn(repo, 'checkout', '--quiet', 'main');
  await runIn(repo, 'checkout', '--quiet', '-b', DELETED_BRANCH);
  writeFileSync(join(repo, 'ported.txt'), 'ported change\n');
  await runIn(repo, 'add', '.');
  await runIn(repo, 'commit', '-m', 'the ported change');
  await runIn(repo, 'checkout', '--quiet', 'main');
  // Squash, so the branch tip is unreachable from main — same as a squash-merged PR.
  await runIn(repo, 'merge', '--squash', DELETED_BRANCH);
  await runIn(repo, 'commit', '-m', `Merged PR 99999: ${DELETED_BRANCH}`);
  mergeSha = await capture(repo, 'rev-parse', 'HEAD');

  // A LATER commit on main, after the merge. Without this, main's tip IS the merge
  // commit, so "the ported file exists" is true whether or not the fallback checkout
  // ran at all — the assertion would pass for the wrong reason. `later.txt` exists
  // only at main's tip, so its ABSENCE proves HEAD really moved to the merge commit.
  writeFileSync(join(repo, 'later.txt'), 'work that landed after the merge\n');
  await runIn(repo, 'add', '.');
  await runIn(repo, 'commit', '-m', 'later work on main');

  deletedBranchOrigin = mkdtempSync(join(tmpdir(), 'checkout-deleted-origin-'));
  await runIn(repo, 'init', '--bare', '-b', 'main', deletedBranchOrigin);
  // Push main ONLY — the source branch never reaches this origin, which is what a
  // deleted-on-completion branch looks like to any later clone.
  await runIn(repo, 'push', '--quiet', deletedBranchOrigin, 'main');

  deletedBranchClone = mkdtempSync(join(tmpdir(), 'checkout-deleted-clone-'));
  const delClone = Bun.spawn(
    ['git', 'clone', '--quiet', '--branch', 'main', deletedBranchOrigin, deletedBranchClone],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  await delClone.exited;

  await runIn(repo, 'checkout', '--quiet', 'main');
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(bareOrigin, { recursive: true, force: true });
  rmSync(cloneDir, { recursive: true, force: true });
  rmSync(sessionRoot, { recursive: true, force: true });
  rmSync(deletedBranchOrigin, { recursive: true, force: true });
  rmSync(deletedBranchClone, { recursive: true, force: true });
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

describe('the completed-PR shape — source branch deleted, merge commit survives', () => {
  // Measured on PR 52308: `status: 3` (completed) with
  // `completionOptions.deleteSourceBranch: true`. Azure DevOps deletes the source
  // branch at merge, so NO clone can ever check it out. Without a fallback the
  // sanity path degrades to the full seven-agent review for every completed PR —
  // the fail-safe direction, which is exactly why it is invisible: a broken path
  // and a working one look identical, except the broken one costs ~3x.
  //
  // It also silently voids the A/B matrix, which replays historical (= completed)
  // PRs: every arm would take the fallback and the run would look like data.

  test('the fixture really is the broken shape — the branch is absent from the clone', async () => {
    // Guards the tests below from passing for the wrong reason: if the branch were
    // present, the fallback would never be exercised and every assertion here would
    // still be green.
    const r = await checkoutBranch(deletedBranchClone, DELETED_BRANCH);
    expect(r.ok).toBe(false);
  });

  test('falls back to the merge commit when the branch is gone', async () => {
    const r = await checkoutBranch(deletedBranchClone, DELETED_BRANCH, mergeSha);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.sha).toBe(mergeSha);
      expect(r.via).toBe('commit');
    }
  });

  test('the fallback moves the working tree TO the merge commit, not just anywhere', async () => {
    // `ok: true` only proves a checkout happened. What matters is that the tree
    // becomes the merged result the reviewer reads.
    //
    // Both assertions are needed. `ported.txt` alone would pass even if no checkout
    // ran, because the clone starts on main and main contains the squashed change.
    // `later.txt` landed on main AFTER the merge, so its absence is what actually
    // proves HEAD moved off main's tip and onto the merge commit.
    await checkoutBranch(deletedBranchClone, DELETED_BRANCH, mergeSha);
    expect(await Bun.file(join(deletedBranchClone, 'ported.txt')).exists()).toBe(true);
    expect(await Bun.file(join(deletedBranchClone, 'later.txt')).exists()).toBe(false);
  });

  test('the fixture discriminates — main tip carries later.txt, so the check above can fail', async () => {
    // Negative control for the test above: on main both files are present, so an
    // absent-later.txt assertion is a real signal rather than a tautology.
    const restore = await checkoutBranch(deletedBranchClone, 'main');
    expect(restore.ok).toBe(true);
    expect(await Bun.file(join(deletedBranchClone, 'later.txt')).exists()).toBe(true);
    expect(await Bun.file(join(deletedBranchClone, 'ported.txt')).exists()).toBe(true);
  });

  test('prefers the branch over the fallback when the branch DOES exist', async () => {
    // The fallback must not quietly take over the normal (active PR) path — an
    // active PR's branch is the merge preview and stays authoritative.
    const r = await checkoutBranch(cloneDir, 'bug/x-on-hotfix-28.3.2', mergeSha);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.via).toBe('branch');
      expect(r.sha).not.toBe(mergeSha);
    }
    expect(await headBranch(cloneDir)).toBe('bug/x-on-hotfix-28.3.2');
  });

  test('reports failure when the branch is gone AND the fallback sha is not in the clone', async () => {
    const absent = 'd'.repeat(40);
    const r = await checkoutBranch(deletedBranchClone, DELETED_BRANCH, absent);
    expect(r.ok).toBe(false);
  });

  test('a malformed fallback sha is rejected, not passed to git as a ref', async () => {
    const r = await checkoutBranch(deletedBranchClone, DELETED_BRANCH, 'not-a-sha');
    expect(r.ok).toBe(false);
  });

  test('still fails when no fallback is offered — unchanged prior behaviour', async () => {
    const r = await checkoutBranch(deletedBranchClone, DELETED_BRANCH, undefined);
    expect(r.ok).toBe(false);
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
