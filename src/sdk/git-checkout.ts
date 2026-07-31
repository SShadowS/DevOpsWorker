import { runGit } from './git-run.ts';

/**
 * Check a clone out to a branch, returning a result rather than throwing.
 *
 * Review containers clone the repo registry's DEFAULT branch
 * (`docker.ts` sets `REPO_BRANCH=${config.repo.branch}`), not the PR's branch. A
 * backport's own branch is cut from its target with the ported commit applied, so
 * checking it out is what makes the working tree a merge preview — which is what
 * symbol resolution and coverage checks need. Reading them from the default
 * branch would answer from a different release line and look verified.
 *
 * Never throws: the caller falls back to the full review, and a checkout failure
 * must not surface as an agent error.
 */
export async function checkoutBranch(
  cwd: string,
  ref: string,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  const branch = ref.replace(/^refs\/heads\//, '');
  if (!branch) return { ok: false, error: 'empty ref' };
  // A leading `-` would be parsed as a flag by `git checkout`. `--end-of-options` would
  // solve this portably in a modern git, but the container ships git 2.39.5, which does
  // not support that flag on `checkout` (confirmed: it treats it as a literal pathspec
  // and fails) — so reject the shape directly instead. Real branches can't have this
  // shape anyway (`check-ref-format` refuses a leading `-`) and these names come from
  // Azure DevOps, not free-form input, but the check is nearly free.
  if (branch.startsWith('-')) {
    return { ok: false, error: `refusing a branch name that starts with '-': ${branch}` };
  }

  // `runGit` is the never-throws spawn wrapper shared with `git-diff.ts`; it
  // returns output RAW, so anything read as a token is trimmed here.
  const run = (args: string[]) => runGit(cwd, args);

  const checkout = await run(['checkout', '--quiet', branch]);
  if (checkout.code !== 0) {
    return { ok: false, error: checkout.err.trim() || `git checkout ${branch} exited ${checkout.code}` };
  }

  const rev = await run(['rev-parse', 'HEAD']);
  const sha = rev.out.trim();
  if (rev.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    return { ok: false, error: rev.err.trim() || 'could not resolve HEAD after checkout' };
  }
  return { ok: true, sha };
}

/**
 * Resolve a ref to its commit sha in the given working tree, or `null` when it
 * cannot be resolved — a missing remote-tracking branch, a bad `cwd`, or `git`
 * itself failing.
 *
 * Never throws, same contract as `checkoutBranch`. Feeds the merge-preview
 * staleness check: an unresolved ref must count as "stale" rather than let the
 * caller assume the preview is current when it might not be.
 *
 * `--verify --quiet` is what keeps a missing ref a clean `null` instead of a
 * `fatal: ...` on stderr this function would otherwise have to parse.
 */
export async function resolveRef(cwd: string, ref: string): Promise<string | null> {
  try {
    const p = Bun.spawn(['git', 'rev-parse', '--verify', '--quiet', ref], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = (await new Response(p.stdout).text()).trim();
    const code = await p.exited;
    return code === 0 && /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}
