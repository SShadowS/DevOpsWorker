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
 * `fallbackSha` handles the COMPLETED-PR shape. When a PR is completed with
 * `completionOptions.deleteSourceBranch: true` its source branch stops existing the
 * moment it merges, and no clone can check it out. Pass the PR's `lastMergeCommit`
 * and the checkout lands on the merged result instead — which
 * is a BETTER merge preview than the branch, since it is the actual merged tree rather
 * than a prediction of one. It also always resolves: the merge commit sits on the
 * TARGET branch, which is cloned, whereas the source head is usually absent after a
 * squash-merge.
 *
 * Without this the sanity path degrades to the full review for every completed PR.
 * That is the fail-safe direction, which is precisely why it stays invisible — the
 * broken and working paths look identical, except the broken one costs ~3x. It also
 * voids any A/B run over historical PRs, since every arm silently takes the fallback.
 *
 * The branch always wins when it exists: for an ACTIVE PR the branch is the live
 * merge preview and `lastMergeCommit` may be a stale precomputed merge.
 *
 * Never throws: the caller falls back to the full review, and a checkout failure
 * must not surface as an agent error.
 */
export async function checkoutBranch(
  cwd: string,
  ref: string,
  fallbackSha?: string,
): Promise<{ ok: true; sha: string; via: 'branch' | 'commit' } | { ok: false; error: string }> {
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
    const branchError = checkout.err.trim() || `git checkout ${branch} exited ${checkout.code}`;
    const viaCommit = await checkoutCommit(run, fallbackSha, branchError);
    if (viaCommit) return viaCommit;
    return { ok: false, error: branchError };
  }

  const rev = await run(['rev-parse', 'HEAD']);
  const sha = rev.out.trim();
  if (rev.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    return { ok: false, error: rev.err.trim() || 'could not resolve HEAD after checkout' };
  }
  return { ok: true, sha, via: 'branch' };
}

/**
 * Detached checkout of an explicit commit, for the deleted-source-branch case.
 * Returns `null` when there is nothing usable to fall back to, so the caller can
 * report the ORIGINAL branch error — that is the one a human needs to see.
 */
async function checkoutCommit(
  run: (args: string[]) => ReturnType<typeof runGit>,
  fallbackSha: string | undefined,
  branchError: string,
): Promise<{ ok: true; sha: string; via: 'commit' } | null> {
  if (!fallbackSha) return null;
  const sha = fallbackSha.trim();
  // Validate the shape before handing it to git. A non-sha string would otherwise be
  // interpreted as a ref name and could resolve to something unrelated.
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;

  // Presence, not reachability. `git checkout <sha>` needs only the object to exist
  // locally; a reachability test would be over-strict and reject valid commits. A
  // filtered (`--filter=blob:none`) clone lazily fetches on demand, so this can
  // succeed there for objects a full clone would not have — production clones are
  // unfiltered, and failing closed here just means the full review.
  const present = await run(['cat-file', '-e', `${sha}^{commit}`]);
  if (present.code !== 0) return null;

  const detach = await run(['checkout', '--quiet', '--detach', sha]);
  if (detach.code !== 0) return null;

  const rev = await run(['rev-parse', 'HEAD']);
  const head = rev.out.trim();
  if (rev.code !== 0 || head !== sha) return null;

  console.log(
    `[backport] source branch unavailable (${branchError.slice(0, 120)}); ` +
    `reviewing the merge commit ${sha.slice(0, 8)} instead`,
  );
  return { ok: true, sha, via: 'commit' };
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
