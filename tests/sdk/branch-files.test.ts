import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { branchFiles } from '../../src/sdk/git-diff.ts';

// Real git, no mocks: a clone with origin/master, and a feature branch that adds,
// edits and deletes files. Issue #27: the coder's own list missed 6 of 10 files.
let origin: string;
let clone: string;

const git = async (cwd: string, ...args: string[]) => {
  const p = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  await p.exited;
};

beforeAll(async () => {
  origin = mkdtempSync(join(tmpdir(), 'branchfiles-origin-'));
  await git(origin, 'init', '-b', 'master');
  await git(origin, 'config', 'user.email', 't@t');
  await git(origin, 'config', 'user.name', 't');
  writeFileSync(join(origin, 'Edit.al'), 'a\n');
  writeFileSync(join(origin, 'Gone.al'), 'b\n');
  await git(origin, 'add', '.');
  await git(origin, 'commit', '-m', 'base');

  clone = mkdtempSync(join(tmpdir(), 'branchfiles-clone-'));
  await git(clone, 'clone', origin, '.');
  await git(clone, 'config', 'user.email', 't@t');
  await git(clone, 'config', 'user.name', 't');
  await git(clone, 'checkout', '-b', 'feature/#1-x');
  writeFileSync(join(clone, 'Edit.al'), 'a changed\n');
  writeFileSync(join(clone, 'New Page.al'), 'c\n');
  unlinkSync(join(clone, 'Gone.al'));
  await git(clone, 'add', '-A');
  await git(clone, 'commit', '-m', 'feature');
});

afterAll(() => {
  rmSync(origin, { recursive: true, force: true });
  rmSync(clone, { recursive: true, force: true });
});

describe('branchFiles', () => {
  test('lists what the branch changed since it left the base branch', async () => {
    const files = await branchFiles(clone, 'master');
    expect(files).toEqual({ filesCreated: ['New Page.al'], filesModified: ['Edit.al', 'Gone.al'] });
  });

  test('returns null when the base branch is not on origin', async () => {
    expect(await branchFiles(clone, 'no-such-branch')).toBeNull();
  });
});
