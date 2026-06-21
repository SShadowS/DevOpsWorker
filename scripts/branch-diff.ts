#!/usr/bin/env bun
/**
 * branch-diff.ts — Show what a feature branch changed vs its base, in one call.
 *
 * Replaces the recurring 3-way fallback the coder agent writes by hand:
 *
 *   git diff master...userstory/#75360 2>/dev/null \
 *     || git diff master..."userstory/#75360" 2>/dev/null \
 *     || git log --oneline -5
 *
 * That dance exists for two reasons this script removes:
 *   1. Branch names contain `#`, which the shell mangles unless quoted. We pass
 *      the branch as a single argv element to git (execFileSync, no shell), so
 *      `#` is never interpreted — no quoting guesswork.
 *   2. The branch may exist locally OR only as origin/<branch>. We probe both
 *      with `rev-parse --verify` and diff whichever resolves.
 *
 * Usage:
 *   bun scripts/branch-diff.ts <branch> [--repo <dir>] [--base <ref>]
 *                              [--stat | --name-only] [--head <N>]
 *
 * Defaults:
 *   --base master   --head 500   (mode: full patch)
 *   --head 0        = no line cap
 *
 * Run from the target extension repo, or pass --repo to point at it.
 *
 * Exit codes:
 *   0 — diff produced (or empty diff — branch resolved, no changes)
 *   2 — branch could not be resolved locally or on origin (recent log printed)
 *   3 — usage error
 */

import { execFileSync } from 'child_process';

export type DiffMode = 'patch' | 'stat' | 'name-only';

export interface BranchDiffArgs {
  branch: string;
  repo?: string;
  base: string;
  mode: DiffMode;
  head: number;
}

// ---------------------------------------------------------------------------
// Pure core (unit-tested)
// ---------------------------------------------------------------------------

export function parseBranchDiffArgs(argv: string[]): BranchDiffArgs {
  let branch: string | undefined;
  let repo: string | undefined;
  let base = 'master';
  let mode: DiffMode = 'patch';
  let head = 500;

  const nextValue = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined) throw new Error(`${flag} requires a value`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case '--stat':
        mode = 'stat';
        break;
      case '--name-only':
        mode = 'name-only';
        break;
      case '--repo':
        repo = nextValue(++i, '--repo');
        break;
      case '--base':
        base = nextValue(++i, '--base');
        break;
      case '--head':
        head = parseInt(nextValue(++i, '--head'), 10);
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
        if (branch === undefined) branch = arg;
        else throw new Error(`Unexpected positional argument: ${arg}`);
    }
  }

  if (!branch) throw new Error('Usage: branch-diff <branch> [--repo <dir>] [--base <ref>] [--stat|--name-only] [--head <N>]');
  if (Number.isNaN(head)) throw new Error('--head must be a number');

  return { branch, repo, base, mode, head };
}

/**
 * Resolve the diff target. Tries the branch as-given first (local ref), then
 * `origin/<branch>`. Returns the first ref that `exists()` accepts, or null.
 * Already-qualified `origin/...` branches are not double-prefixed.
 */
export function pickRef(branch: string, exists: (ref: string) => boolean): string | null {
  const candidates = branch.startsWith('origin/')
    ? [branch]
    : [branch, `origin/${branch}`];
  return candidates.find(exists) ?? null;
}

/** Build the git argv (after the `git` program name) for the chosen mode. */
export function buildDiffArgs(base: string, ref: string, mode: DiffMode): string[] {
  const args = ['diff', `${base}...${ref}`];
  if (mode === 'stat') args.push('--stat');
  else if (mode === 'name-only') args.push('--name-only');
  return args;
}

/** Cap output to `head` lines (0 = unlimited), appending a footer when cut. */
export function truncateOutput(text: string, head: number): string {
  if (head <= 0) return text;
  const lines = text.split('\n');
  if (lines.length <= head) return text;
  const remaining = lines.length - head;
  return [...lines.slice(0, head), `… (truncated — ${remaining} more line${remaining === 1 ? '' : 's'}; re-run with --head 0 for full output)`].join('\n');
}

// ---------------------------------------------------------------------------
// git plumbing (thin, not unit-tested — exercised via integration/manual)
// ---------------------------------------------------------------------------

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function refExists(ref: string, cwd?: string): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function main(): void {
  let args: BranchDiffArgs;
  try {
    args = parseBranchDiffArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`ERROR: ${(e as Error).message}`);
    process.exit(3);
  }

  const { branch, repo, base, mode, head } = args;

  const ref = pickRef(branch, (r) => refExists(r, repo));
  if (!ref) {
    console.error(`ERROR: branch '${branch}' not found locally or on origin (base '${base}').`);
    try {
      console.error('\nRecent history on HEAD:');
      console.error(git(['log', '--oneline', '-5'], repo));
    } catch {
      /* repo may be invalid; nothing more to show */
    }
    process.exit(2);
  }

  const out = git(buildDiffArgs(base, ref, mode), repo);
  const trimmed = out.replace(/\n$/, '');
  if (trimmed === '') {
    console.log(`(no changes in ${base}...${ref})`);
    return;
  }
  console.log(truncateOutput(trimmed, head));
}

if (import.meta.main) main();
