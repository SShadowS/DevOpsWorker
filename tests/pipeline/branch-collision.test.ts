import { describe, test, expect } from 'bun:test';
import {
  branchBelongsToWorkItem,
  parseRemoteBranches,
  isFreshCodingStart,
  classifyCollision,
  detectBranchCollision,
  type GitRunner,
  type RemoteBranch,
} from '../../src/pipeline/branch-collision.ts';
import type { PipelineState } from '../../src/types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// Three questions that look identical from the remote's side
//
// A branch matching the work item can mean a leftover from a wiped run, or this
// run's OWN branch after a rewind to planning threw the changeset away, or —
// inverted — a recorded branch that has since been merged and deleted. The
// remedies conflict: "delete the branch" is correct for the first and
// destructive for the second, since a pull request is probably still open on it.
// Every test here is about keeping those apart.
// ---------------------------------------------------------------------------

function state(overrides: Partial<PipelineState> = {}): PipelineState {
  return { currentStage: 'coding', ...overrides } as PipelineState;
}

const branch = (name: string, sha = 'a'.repeat(40)): RemoteBranch => ({ name, sha });

describe('branchBelongsToWorkItem', () => {
  test('matches both prefixes with a slug', () => {
    expect(branchBelongsToWorkItem('bug/#123-fix-posting', 123)).toBe(true);
    expect(branchBelongsToWorkItem('userstory/#123-add-thing', 123)).toBe(true);
  });

  test('matches a bare branch with no slug', () => {
    // A human typing the name by hand tends to stop at the number.
    expect(branchBelongsToWorkItem('bug/#123', 123)).toBe(true);
  });

  test('does not match a work item that merely starts with the same digits', () => {
    // The trap in a bare `#123` prefix test: 1234 starts with 123.
    expect(branchBelongsToWorkItem('bug/#1234-other', 123)).toBe(false);
  });

  test('does not match other branch namespaces', () => {
    expect(branchBelongsToWorkItem('release/#123-x', 123)).toBe(false);
    expect(branchBelongsToWorkItem('master', 123)).toBe(false);
  });
});

describe('parseRemoteBranches', () => {
  test('reads the tab-separated ls-remote shape and strips refs/heads/', () => {
    const out = `${'a'.repeat(40)}\trefs/heads/bug/#123-fix\n${'b'.repeat(40)}\trefs/heads/master\n`;

    expect(parseRemoteBranches(out)).toEqual([
      { sha: 'a'.repeat(40), name: 'bug/#123-fix' },
      { sha: 'b'.repeat(40), name: 'master' },
    ]);
  });

  test('empty output is an empty list, not an error', () => {
    // Exit 0 with nothing on stdout is a real answer: no such branch.
    expect(parseRemoteBranches('')).toEqual([]);
    expect(parseRemoteBranches('\n  \n')).toEqual([]);
  });

  test('skips a malformed line rather than throwing', () => {
    // This check must never be the reason a run dies.
    const out = `garbage\n${'c'.repeat(40)}\trefs/heads/bug/#9-x\n`;
    expect(parseRemoteBranches(out)).toEqual([{ sha: 'c'.repeat(40), name: 'bug/#9-x' }]);
  });
});

describe('isFreshCodingStart', () => {
  test('true with no changeset', () => {
    expect(isFreshCodingStart(state())).toBe(true);
  });

  test('false once a changeset names a branch', () => {
    expect(isFreshCodingStart(state({ changeset: { branchName: 'bug/#1-x' } as never }))).toBe(false);
  });
});

describe('classifyCollision', () => {
  test('clean start with no matching branch proceeds', () => {
    expect(classifyCollision(state(), 123, [branch('master')])).toBeNull();
  });

  test('a normal resume proceeds when its branch is still there', () => {
    // THE REGRESSION GUARD. `/fix`, the `continue` tag and an error resume all
    // land here with the changeset intact, and all of them must run.
    const s = state({ changeset: { branchName: 'bug/#123-fix' } as never });

    expect(classifyCollision(s, 123, [branch('bug/#123-fix')])).toBeNull();
  });

  test('a fresh start onto a stranger branch is a leftover', () => {
    const c = classifyCollision(state(), 123, [branch('bug/#123-fix')]);

    expect(c?.kind).toBe('leftover');
    expect(c?.branch).toBe('bug/#123-fix');
    expect(c?.message).toContain('Rename');
  });

  test('a fresh start onto THIS run\'s own branch is a replan, not a leftover', () => {
    // `/rerun-plan` is armed at the pr-published checkpoint, so it fires exactly
    // when coding has already pushed. `planningResetState` then clears the
    // changeset, and without `priorBranches` this reads as a stranger's branch —
    // and the advice becomes "delete it", killing an open pull request.
    const s = state({ priorBranches: ['bug/#123-fix'] });

    const c = classifyCollision(s, 123, [branch('bug/#123-fix')]);

    expect(c?.kind).toBe('replanned');
    expect(c?.message).toContain('sent back for rework');
    expect(c?.message).toContain('still open');
  });

  test('a recorded branch that is gone from the remote is reported', () => {
    // Azure DevOps deletes the source branch when a pull request completes, and
    // `/fix` is armed at the pr-completed checkpoint — so this is what a `/fix`
    // on already-merged work looks like. Without this the coder is sent to check
    // out a branch that does not exist.
    const s = state({ changeset: { branchName: 'bug/#123-fix' } as never });

    const c = classifyCollision(s, 123, [branch('master')]);

    expect(c?.kind).toBe('branch-gone');
    expect(c?.branch).toBe('bug/#123-fix');
  });

  test('a resume ignores an unrelated branch for the same work item', () => {
    // Only the branch the changeset NAMES matters on the resume path; a
    // differently-slugged sibling is not this run's problem.
    const s = state({ changeset: { branchName: 'bug/#123-fix' } as never });

    expect(classifyCollision(s, 123, [branch('bug/#123-fix'), branch('bug/#123-other')])).toBeNull();
  });

  test('every collision message names the branch', () => {
    const cases = [
      classifyCollision(state(), 7, [branch('bug/#7-a')]),
      classifyCollision(state({ priorBranches: ['bug/#7-a'] }), 7, [branch('bug/#7-a')]),
      classifyCollision(state({ changeset: { branchName: 'bug/#7-a' } as never }), 7, []),
    ];

    for (const c of cases) expect(c?.message).toContain('bug/#7-a');
  });
});

describe('detectBranchCollision', () => {
  const ok = (stdout: string): GitRunner => () => ({ stdout, exitCode: 0 });

  test('passes the branch pattern to git as arguments, never through a shell', () => {
    // Branch names contain `#`. Passing them in an argument array removes the
    // quoting question entirely — the same reason branch-diff.ts exists.
    const seen: string[][] = [];
    const runner: GitRunner = (args) => {
      seen.push(args);
      return { stdout: '', exitCode: 0 };
    };

    detectBranchCollision(state(), 123, '/repo', undefined, runner);

    expect(seen[0]).toContain('refs/heads/bug/#123-*');
    expect(seen[0]).toContain('ls-remote');
  });

  test('exit 0 with no output is a pass, not a skip', () => {
    // The distinction that matters: "no such branch" is an answer. Conflating it
    // with "we could not find out" would make the check silently useless.
    expect(detectBranchCollision(state(), 123, '/repo', undefined, ok(''))).toBeNull();
  });

  test('a non-zero git exit fails open and says so', () => {
    // Failing closed would block every coding run whenever the remote hiccups —
    // a worse outage than the late push failure this prevents. But it must not
    // be silent: a guard that quietly did nothing has already cost this project
    // ~36 agent-hours.
    const logged: string[] = [];
    const failing: GitRunner = () => ({ stdout: '', exitCode: 128 });

    const c = detectBranchCollision(state(), 123, '/repo', (m) => logged.push(m), failing);

    expect(c).toBeNull();
    expect(logged.join(' ')).toContain('128');
  });

  test('a thrown runner fails open and says so', () => {
    const logged: string[] = [];
    const throwing: GitRunner = () => {
      throw new Error('spawn ENOENT');
    };

    expect(detectBranchCollision(state(), 123, '/repo', (m) => logged.push(m), throwing)).toBeNull();
    expect(logged.join(' ')).toContain('ENOENT');
  });

  test('finds a leftover branch end to end', () => {
    const out = `${'a'.repeat(40)}\trefs/heads/bug/#123-fix\n`;

    expect(detectBranchCollision(state(), 123, '/repo', undefined, ok(out))?.kind).toBe('leftover');
  });

  test('asks for the recorded branch by name when the work-item globs miss it', () => {
    // A changeset can name a branch whose slug the globs do not match; the
    // resume path must not report `branch-gone` just because the pattern missed.
    const calls: string[][] = [];
    const runner: GitRunner = (args) => {
      calls.push(args);
      return calls.length === 1
        ? { stdout: '', exitCode: 0 }
        : { stdout: `${'a'.repeat(40)}\trefs/heads/feature/odd-name\n`, exitCode: 0 };
    };
    const s = state({ changeset: { branchName: 'feature/odd-name' } as never });

    expect(detectBranchCollision(s, 123, '/repo', undefined, runner)).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('refs/heads/feature/odd-name');
  });
});
