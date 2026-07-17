import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest, resolvePrivateDir, resetManifestCache, resolveAgentOverlayDir } from '../../src/overlay/loader.ts';

const tmpDirs: string[] = [];

/** Create a throwaway overlay dir, optionally writing a manifest.ts with given body. */
function makeOverlayDir(manifestBody?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'overlay-test-'));
  tmpDirs.push(dir);
  if (manifestBody !== undefined) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.ts'), manifestBody);
  }
  return dir;
}

afterEach(() => {
  resetManifestCache();
  delete process.env['PRIVATE_DIR'];
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe('resolvePrivateDir', () => {
  test('returns null when the directory does not exist', () => {
    expect(resolvePrivateDir(join(tmpdir(), 'definitely-not-here-xyz'))).toBeNull();
  });

  test('returns the absolute path when the directory exists', () => {
    const dir = makeOverlayDir('export default {};');
    expect(resolvePrivateDir(dir)).toBe(dir);
  });

  test('honours PRIVATE_DIR env var', () => {
    const dir = makeOverlayDir('export default {};');
    process.env['PRIVATE_DIR'] = dir;
    expect(resolvePrivateDir()).toBe(dir);
  });
});

describe('loadManifest', () => {
  test('returns an empty manifest when no overlay directory exists', async () => {
    const manifest = await loadManifest({ dir: join(tmpdir(), 'nope-xyz'), force: true });
    expect(manifest).toEqual({});
  });

  test('returns an empty manifest when the directory has no manifest.ts', async () => {
    const dir = makeOverlayDir(); // dir exists, no manifest file
    const manifest = await loadManifest({ dir, force: true });
    expect(manifest).toEqual({});
  });

  test('loads the default export from manifest.ts', async () => {
    const dir = makeOverlayDir(
      `export default { agents: { coder: { model: 'sonnet' } }, pipeline: [] };`,
    );
    const manifest = await loadManifest({ dir, force: true });
    expect(manifest.agents).toEqual({ coder: { model: 'sonnet' } });
  });

  test('throws when the manifest does not default-export an object', async () => {
    const dir = makeOverlayDir(`export default 42;`);
    await expect(loadManifest({ dir, force: true })).rejects.toThrow(/OverlayManifest object/i);
  });

  test('memoises the result until reset', async () => {
    const dir = makeOverlayDir(`export default { agents: { coder: { model: 'a' } } };`);
    const first = await loadManifest({ dir, force: true });
    // Second call without force returns the cached value regardless of dir.
    const second = await loadManifest({ dir: join(tmpdir(), 'nope-xyz') });
    expect(second).toBe(first);
  });
});

describe('resolveAgentOverlayDir', () => {
  test('returns the agent overlay dir when private/agents/<name> exists', () => {
    const dir = makeOverlayDir('export default {};');
    mkdirSync(join(dir, 'agents', 'coder'), { recursive: true });
    expect(resolveAgentOverlayDir('coder', dir)).toBe(join(dir, 'agents', 'coder'));
  });

  test('returns null when the agent has no overlay dir', () => {
    const dir = makeOverlayDir('export default {};'); // no agents/ subtree
    expect(resolveAgentOverlayDir('coder', dir)).toBeNull();
  });

  test('returns null when no private dir exists at all', () => {
    expect(resolveAgentOverlayDir('coder', join(tmpdir(), 'definitely-absent-xyz'))).toBeNull();
  });
});
