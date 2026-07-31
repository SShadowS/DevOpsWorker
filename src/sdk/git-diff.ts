import type { FileDiff } from './ado/backport.ts';
import { runGit } from './git-run.ts';

/**
 * Compute a PR's diff with git, inside the clone the container already has.
 *
 * Azure DevOps REST serves no unified diffs at ALL. The
 * `git/repositories/{id}/pullrequests/{id}/changes` endpoint this used to call does
 * not exist and answers 404 (verified live: `/pullrequests/52117/changes` -> 404,
 * `/pullrequests/52117/iterations` -> 200). The `{ files: [{ path, patch }] }` shape
 * is real but it is COMPOSED by the ADO MCP server, not served by the API.
 *
 * Git in the clone produces exactly the unified-diff format `contentSignature`
 * already parses, costs no API call per patch, and is deterministic — so the
 * pre-computed design the cost argument rests on survives intact.
 *
 * Never throws, same contract as `git-checkout.ts`: a failure here must fall the
 * caller back to the full review, not surface as an agent error.
 */
export type GitDiffResult =
  | { ok: true; files: FileDiff[] }
  | { ok: false; error: string };

const SHA = /^[0-9a-f]{40}$/;

/** `refs/pull/52117/merge` and friends — what may be handed to a fetch refspec. */
const SAFE_REF = /^refs\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Flags pinned against git **2.39.5**, the version in the container
 * (`debian:bookworm-slim`), NOT the 2.53 on a developer's Windows box. Every one
 * below was executed there before being written down.
 *
 * Deliberately absent: `--end-of-options` — and the reason is command-specific, so it
 * is written out rather than summarised. Measured on both gits:
 *
 *   - `git diff --name-only --end-of-options A B` works on 2.39.5 AND on 2.53.
 *     Placing it AFTER the revisions fails on BOTH ("option '--name-only' must come
 *     before non-option arguments"). For `diff` this is a placement rule, not a
 *     version difference.
 *   - `git checkout --end-of-options <branch>` IS a version difference: 2.53 accepts
 *     it, 2.39.5 treats it as a literal pathspec ("error: pathspec
 *     '--end-of-options' did not match any file(s) known to git"). That is why
 *     `git-checkout.ts` rejects a leading `-` by shape instead of reaching for it.
 *
 * Neither finding transfers to the other command, so neither is load-bearing here:
 * validating shas as 40-hex is a strictly stronger guard than `--end-of-options`
 * would be, and it holds on every git version.
 *
 * - `--no-renames` — rename detection is silently disabled by `diff.renameLimit`
 *   on large diffs, so a source PR and its port could be summarised differently
 *   purely because one is bigger. That asymmetry would surface as a phantom
 *   `missingFromPort`. Off on both sides is the only stable answer.
 * - `--no-ext-diff` / `--no-textconv` — a repo-configured diff driver or textconv
 *   filter would otherwise replace the unified diff `contentSignature` parses.
 * - `--no-color` — defensive; output is a pipe, but `color.ui = always` exists.
 */
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '-U3'];

/** Commits that are not present in the clone's object database. */
async function findMissing(cwd: string, shas: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const sha of shas) {
    // `cat-file -e` is an existence test proper: exit 0 when the object is there,
    // non-zero (128) when it is not. Verified on 2.39.5.
    const r = await runGit(cwd, ['cat-file', '-e', `${sha}^{commit}`]);
    if (r.code !== 0) missing.push(sha);
  }
  return missing;
}

/**
 * Fetch a ref into a namespace of our own.
 *
 * A backstop for an ACTIVE PR only, and deliberately a modest one. `git clone`
 * fetches `refs/heads/*` and nothing else, so a PR branch pushed after the clone
 * would be missing; `refs/pull/<id>/merge` recovers it.
 *
 * It does NOT rescue a completed PR, which is worth stating because the opposite is
 * the intuitive guess: this instance retains `refs/pull/*` only while a PR is open.
 * Measured — 4/4 active PRs had the ref, 2/2 completed ones did not, and the whole
 * repository held 11 of them. A completed PR is handled by diffing its merge commit
 * instead (see `fetchPRDiffCommits`), which is on the target branch and always
 * present.
 *
 * The objects are anchored under `refs/backport-diff/` rather than left on
 * FETCH_HEAD so nothing can collect them, and outside `refs/heads/` so they never
 * show up in the agent's `git branch`. `origin` is the remote name
 * `docker/entrypoint.sh` creates (`git clone <url> <dir>`) and already fetches from.
 */
async function recoverFromRef(cwd: string, ref: string): Promise<void> {
  if (!SAFE_REF.test(ref) || ref.includes('..')) return;
  const dest = `refs/backport-diff/${ref.replace(/^refs\/pull\//, '')}`;
  await runGit(cwd, ['fetch', '--quiet', 'origin', `+${ref}:${dest}`]);
}

/**
 * The diff between two commits, one `FileDiff` per changed file.
 *
 * `recoverRefs` are tried in order, and only while a commit is still missing.
 */
export async function diffCommits(
  cwd: string,
  base: string,
  head: string,
  recoverRefs: string[] = [],
): Promise<GitDiffResult> {
  if (!SHA.test(base) || !SHA.test(head)) {
    return { ok: false, error: `expected two 40-character commit shas, got base="${base}" head="${head}"` };
  }

  // Establish that `cwd` IS a repository before asking it about objects.
  // `findMissing` reads only exit codes, so without this a broken `cwd` — a wrong
  // path, a directory with no `.git`, git missing from PATH — is indistinguishable
  // from a genuinely absent commit, and the caller persists "commit(s) not present
  // in the clone" into `review_path`. That sends a human hunting through Azure
  // DevOps for a commit that is fine, when the real fault is local. Not
  // hypothetical: an earlier review of this feature caught exactly this shape,
  // `sessionRoot` being passed where `sessionRoot/repoKey` was meant.
  const inRepo = await runGit(cwd, ['rev-parse', '--git-dir']);
  if (inRepo.code !== 0) {
    return { ok: false, error: inRepo.err.trim() || `not a git repository: ${cwd}` };
  }

  let missing = await findMissing(cwd, [base, head]);
  for (const ref of recoverRefs) {
    if (missing.length === 0) break;
    await recoverFromRef(cwd, ref);
    missing = await findMissing(cwd, [base, head]);
  }
  if (missing.length > 0) {
    const tried = recoverRefs.length ? ` (tried fetching ${recoverRefs.join(', ')})` : '';
    return { ok: false, error: `commit(s) not present in the clone: ${missing.join(', ')}${tried}` };
  }

  // `-z` NUL-separates the names AND disables git's path quoting, so a path with a
  // space, a quote, or a non-ASCII character arrives verbatim instead of as
  // `"a/pa\thth"`. That is why the file list is read separately rather than parsed
  // out of the combined patch's `diff --git a/X b/X` headers, which are ambiguous
  // for exactly those paths.
  const names = await runGit(cwd, ['diff', '--name-only', '-z', '--no-renames', base, head]);
  if (names.code !== 0) {
    return { ok: false, error: names.err.trim() || `git diff --name-only exited ${names.code}` };
  }
  const paths = names.out.split('\0').filter((p) => p.length > 0);

  // One `git diff` per file rather than one combined diff split on `diff --git`.
  // Splitting would have to re-derive each path from the patch header — the exact
  // ambiguity `-z` above exists to avoid — and a desync between the name list and
  // the section order would attach patches to the WRONG files, silently. That is
  // the failure mode this whole fix exists to remove, so it is not reintroduced to
  // save subprocesses on a diff that is read at most twice per review.
  const files: FileDiff[] = [];
  for (const path of paths) {
    const d = await runGit(cwd, [
      'diff', ...DIFF_FLAGS, base, head,
      // `:(top,literal)` stops git reading a path that contains `*`, `?` or `[` as a
      // glob (verified on 2.39.5: a literal `src/cli/*` matches nothing, the
      // non-literal form matches two files) and anchors it to the repo root
      // regardless of `cwd`.
      '--', `:(top,literal)${path}`,
    ]);
    if (d.code !== 0) {
      // A single-file failure is systemic (a broken repo, git gone), not per-file —
      // so fail the whole diff and let the caller fall back, rather than silently
      // returning a comparison that is missing a file.
      return { ok: false, error: d.err.trim() || `git diff of ${path} exited ${d.code}` };
    }
    // No hunk means nothing to compare: a binary file, or a mode-only change. The
    // REST-shaped predecessor skipped these too (entries with no `patch`), so the
    // comparison keeps the semantics it was written against — and it stays
    // symmetric, since the source and the port are read the same way.
    if (!/^@@ /m.test(d.out)) continue;
    files.push({ path, patch: d.out });
  }

  return { ok: true, files };
}
