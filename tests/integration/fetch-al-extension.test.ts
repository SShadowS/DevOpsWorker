import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SCRIPT = join(import.meta.dir, '../../docker/fetch-al-extension.sh');
const HOST = 'bin/linux/Microsoft.Dynamics.Nav.EditorServices.Host';
const PINNED_VERSION = '18.0.2498801';

/** ELF magic — the same check is_real_alc() uses inside the script. */
function isElf(path: string): boolean {
  const fd = readFileSync(path);
  return fd[0] === 0x7f && fd[1] === 0x45 && fd[2] === 0x4c && fd[3] === 0x46;
}

function runFetch(cacheDir: string, version?: string) {
  // Always start from an AL_EXTENSION_VERSION-free environment: an inherited
  // value from the caller's shell would otherwise leak in and silently
  // override the case being tested (the default-version case in particular
  // needs a guarantee that nothing is set, not just that we didn't set it).
  const env = { ...process.env };
  delete env.AL_EXTENSION_VERSION;
  if (version) env.AL_EXTENSION_VERSION = version;
  return Bun.spawnSync(['bash', SCRIPT, cacheDir], { env });
}

// These two tests download the real VSIX and extract it with
// `unzip "extension/bin/*"`, which relies on unzip matching that wildcard
// across the nested path (extension/bin/linux/...). Debian's unzip — what
// every production container ships — does that. The Cygwin/MSYS2 unzip
// bundled with Git for Windows does not, so on a bare Windows run these
// report a false failure against a correct fix (0 files extracted, host
// binary "missing"). That is a platform gap in the local unzip build, not a
// gap in the pin — skip them there rather than have a working fix look
// broken. CI runs ubuntu-latest, where extraction is unaffected. To verify
// these on Windows, run bun test inside a Linux container instead.
const SKIP_REASON_NON_LINUX =
  'skipped on non-Linux: Windows/Cygwin unzip cannot expand extension/bin/* across nested paths';
const skipDownloadTests = process.platform !== 'linux';

describe('fetch-al-extension: pinned version', () => {
  test.skipIf(skipDownloadTests)(
    `fetches the pinned version and it carries a Linux language server (${SKIP_REASON_NON_LINUX})`,
    () => {
      const cache = mkdtempSync(join(tmpdir(), 'al-ext-pin-'));
      try {
        const r = runFetch(cache, PINNED_VERSION);
        expect(r.exitCode).toBe(0);

        const host = join(cache, 'al-extension', HOST);
        expect(existsSync(host)).toBe(true);
        expect(isElf(host)).toBe(true);

        // The version marker records what was actually installed.
        expect(readFileSync(join(cache, 'al-extension', '.version'), 'utf8').trim())
          .toBe(PINNED_VERSION);
      } finally {
        rmSync(cache, { recursive: true, force: true });
      }
    },
    300_000
  );

  // Nothing else in the repo sets AL_EXTENSION_VERSION, so production always
  // takes the "${AL_EXTENSION_VERSION:-18.0.2498801}" default — the one
  // branch the test above never exercises, since it always passes a version
  // explicitly. A typo'd default (or a dropped ":-") would ship green
  // without this. Runs everywhere, including Windows: it never downloads or
  // unzips anything, so the platform gap above doesn't apply.
  test('resolves the default pinned version with no AL_EXTENSION_VERSION set, via the cache-skip path', () => {
    const cache = mkdtempSync(join(tmpdir(), 'al-ext-default-'));
    try {
      const extensionDir = join(cache, 'al-extension');
      const linuxBinDir = join(extensionDir, 'bin', 'linux');
      mkdirSync(linuxBinDir, { recursive: true });

      // Seed a cache that looks exactly like a completed install of the
      // pinned version. The script's own cache-skip comparison
      // (CACHED_VERSION = TARGET_VERSION) is then the thing proving what
      // AL_EXTENSION_VERSION defaults to — no download involved.
      writeFileSync(join(extensionDir, '.version'), `${PINNED_VERSION}\n`);
      const fakeAlc = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
      writeFileSync(join(linuxBinDir, 'alc'), fakeAlc);

      const startedAt = Date.now();
      const r = runFetch(cache); // no version argument — exercises the default
      const elapsedMs = Date.now() - startedAt;

      expect(r.exitCode).toBe(0);
      const stdout = r.stdout.toString();
      expect(stdout).toContain(`AL extension ${PINNED_VERSION} already cached`);
      expect(stdout).not.toContain('Downloading');

      // If the default resolved to anything other than PINNED_VERSION, the
      // marker wouldn't match and the script would fall through to a real
      // download instead of skipping it — this is what would actually catch
      // that regression, not just the stdout message above.
      expect(readFileSync(join(linuxBinDir, 'alc'))).toEqual(fakeAlc);
      expect(elapsedMs).toBeLessThan(5_000);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });
});

describe('fetch-al-extension: a bad payload must not destroy a good cache', () => {
  // Downloads and unzips the known-bad VSIX for real — same platform gap as
  // the pinned-version download test above (SKIP_REASON_NON_LINUX).
  test.skipIf(skipDownloadTests)(
    `keeps the existing cache and exits non-zero when the version has no Linux server (${SKIP_REASON_NON_LINUX})`,
    () => {
      const cache = mkdtempSync(join(tmpdir(), 'al-ext-bad-'));
      try {
        // Pre-populate a "known good" cache: an ELF-magic host plus alc.
        const binLinux = join(cache, 'al-extension', 'bin', 'linux');
        mkdirSync(binLinux, { recursive: true });
        const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
        writeFileSync(join(binLinux, 'Microsoft.Dynamics.Nav.EditorServices.Host'), elf);
        writeFileSync(join(binLinux, 'alc'), elf);
        writeFileSync(join(cache, 'al-extension', '.version'), '18.0.2498801\n');

        // 18.0.2668733 is Windows-only — the exact payload that broke production.
        const r = runFetch(cache, '18.0.2668733');

        expect(r.exitCode).not.toBe(0);

        // The good cache survives, byte-for-byte.
        const host = join(binLinux, 'Microsoft.Dynamics.Nav.EditorServices.Host');
        expect(existsSync(host)).toBe(true);
        expect(isElf(host)).toBe(true);
        // And the marker still names the version that is actually installed.
        expect(readFileSync(join(cache, 'al-extension', '.version'), 'utf8').trim())
          .toBe('18.0.2498801');
      } finally {
        rmSync(cache, { recursive: true, force: true });
      }
    },
    300_000
  );
});
