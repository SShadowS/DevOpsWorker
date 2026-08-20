import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SCRIPT = join(import.meta.dir, '../../docker/fetch-al-lsp-plugin.sh');
const PINNED = '5e1c8ec78c76fce5dc5d29a625f08ce69ef82ae2';

function run(cacheDir: string, ref?: string) {
  return Bun.spawnSync(['bash', SCRIPT, cacheDir], {
    env: { ...process.env, ...(ref ? { AL_LSP_PLUGIN_REF: ref } : {}) },
  });
}

function headSha(repoDir: string): string {
  return Bun.spawnSync(['git', '-C', repoDir, 'rev-parse', 'HEAD'])
    .stdout.toString().trim();
}

describe('fetch-al-lsp-plugin', () => {
  test('checks out exactly the pinned ref', () => {
    const cache = mkdtempSync(join(tmpdir(), 'al-lsp-pin-'));
    try {
      const r = run(cache);
      expect(r.exitCode).toBe(0);
      const repo = join(cache, 'al-lsp-plugin');
      expect(existsSync(join(repo, '.git'))).toBe(true);
      expect(headSha(repo)).toBe(PINNED);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  }, 300_000);

  test('a second run does not move HEAD off the pin', () => {
    const cache = mkdtempSync(join(tmpdir(), 'al-lsp-idem-'));
    try {
      expect(run(cache).exitCode).toBe(0);
      expect(run(cache).exitCode).toBe(0);
      expect(headSha(join(cache, 'al-lsp-plugin'))).toBe(PINNED);
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
});
