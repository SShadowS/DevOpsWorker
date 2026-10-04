import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// docker/companion-cache.sh runs inside the Linux image, where flock exists. Git Bash on
// Windows has no flock, so this only runs on Linux (e.g. `bun run test:container`).
const hasFlock = Bun.spawnSync(['sh', '-c', 'command -v flock']).exitCode === 0;
const SCRIPT = resolve(import.meta.dir, '../../docker/companion-cache.sh');

function sh(cmd: string, cwd?: string) {
  const r = Bun.spawnSync(['bash', '-c', cmd], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`${cmd}\n${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

describe.skipIf(!hasFlock)('companion cache (flock)', () => {
  let tmp: string;
  let origin: string;
  let root: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'companion-cache-'));
    origin = join(tmp, 'origin.git');
    root = join(tmp, 'repos');
    const work = join(tmp, 'work');
    mkdirSync(work);
    sh('git init -q -b main && git config user.email t@t && git config user.name t', work);
    writeFileSync(join(work, 'a.txt'), 'one');
    sh('git add . && git commit -qm one', work);
    sh(`git clone -q --bare "${work}" "${origin}"`);
  }, 60_000);

  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  async function runConcurrently(n: number) {
    const procs = Array.from({ length: n }, () =>
      Bun.spawn(['bash', '-c', `. "${SCRIPT}"; cache_companion BC "file://${origin}" main "${root}"`], {
        stdout: 'pipe', stderr: 'pipe',
        env: { ...process.env, GIT_RETRY_DELAY: '1' },
      }),
    );
    return Promise.all(procs.map(p => p.exited));
  }

  test('five simultaneous first-time clones all succeed and leave one valid repo', async () => {
    const codes = await runConcurrently(5);
    expect(codes).toEqual([0, 0, 0, 0, 0]);
    expect(sh('git rev-parse --is-inside-work-tree', join(root, 'BC'))).toBe('true');
  }, 60_000);

  test('a half-made folder left by a killed container is replaced, not fatal', async () => {
    rmSync(join(root, 'BC'), { recursive: true, force: true });
    mkdirSync(join(root, 'BC'));
    writeFileSync(join(root, 'BC', 'junk'), 'x');   // exists, not empty, no .git
    const codes = await runConcurrently(5);
    expect(codes).toEqual([0, 0, 0, 0, 0]);
    expect(existsSync(join(root, 'BC', '.git'))).toBe(true);
    expect(existsSync(join(root, 'BC', 'junk'))).toBe(false);
  }, 60_000);
});
