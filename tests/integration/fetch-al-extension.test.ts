import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SCRIPT = join(import.meta.dir, '../../docker/fetch-al-extension.sh');
const HOST = 'bin/linux/Microsoft.Dynamics.Nav.EditorServices.Host';

/** ELF magic — the same check is_real_alc() uses inside the script. */
function isElf(path: string): boolean {
  const fd = readFileSync(path);
  return fd[0] === 0x7f && fd[1] === 0x45 && fd[2] === 0x4c && fd[3] === 0x46;
}

function runFetch(cacheDir: string, version?: string) {
  return Bun.spawnSync(['bash', SCRIPT, cacheDir], {
    env: { ...process.env, ...(version ? { AL_EXTENSION_VERSION: version } : {}) },
  });
}

describe('fetch-al-extension: pinned version', () => {
  test('fetches the pinned version and it carries a Linux language server', () => {
    const cache = mkdtempSync(join(tmpdir(), 'al-ext-pin-'));
    try {
      const r = runFetch(cache, '18.0.2498801');
      expect(r.exitCode).toBe(0);

      const host = join(cache, 'al-extension', HOST);
      expect(existsSync(host)).toBe(true);
      expect(isElf(host)).toBe(true);

      // The version marker records what was actually installed.
      expect(readFileSync(join(cache, 'al-extension', '.version'), 'utf8').trim())
        .toBe('18.0.2498801');
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  }, 300_000);
});
