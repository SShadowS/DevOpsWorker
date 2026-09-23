import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, statSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Runs docker/fetch-al-symbols.sh against the real, anonymous Microsoft MSSymbols feed
// (about 7 MB per fresh cache). Locally there is no flock, so these runs take the mkdir
// lock; the production image has flock.

const SCRIPT = join(import.meta.dir, '../../docker/fetch-al-symbols.sh');

function appJson(dir: string, fields: Record<string, string>): string {
  const p = join(dir, 'app.json');
  writeFileSync(p, JSON.stringify({ id: 'x', name: 'x', ...fields }));
  return p;
}

function run(tools: string, app: string, env: Record<string, string> = {}) {
  return Bun.spawnSync(['bash', SCRIPT, tools, app], { env: { ...process.env, ...env } });
}

function runAsync(tools: string, app: string) {
  return Bun.spawn(['bash', SCRIPT, tools, app], { stdout: 'pipe', stderr: 'pipe' });
}

// The script prints POSIX separators; Node's join uses backslashes on Windows.
const norm = (p: string) => p.trim().replaceAll('\\', '/');

const apps = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.app')).sort();

describe('fetch-al-symbols', () => {
  let tools: string;
  let app: string;
  let first: ReturnType<typeof run>;

  beforeAll(() => {
    tools = mkdtempSync(join(tmpdir(), 'al-sym-'));
    app = appJson(tools, { application: '28.0.0.0', platform: '28.0.0.0' });
    first = run(tools, app);
  }, 600_000);

  afterAll(() => rmSync(tools, { recursive: true, force: true }));

  test('caches exactly the five w1 packages of the app.json major and prints the dir', () => {
    expect(first.exitCode).toBe(0);
    const dir = join(tools, 'al-symbols', '28');
    expect(norm(first.stdout.toString())).toBe(norm(dir));
    const files = apps(dir);
    expect(files).toHaveLength(5);
    expect(files).toContain('System.app');
    const others = files.filter((f) => f !== 'System.app');
    for (const name of ['Application', 'Base Application', 'Business Foundation', 'System Application']) {
      expect(others.some((f) => f.startsWith(`Microsoft_${name}_28.`))).toBe(true);
    }
    // One minor for all four apps: no mixing inside the directory.
    const minors = new Set(others.map((f) => f.match(/_(28\.\d+\.\d+\.\d+)\.app$/)![1]));
    expect(minors.size).toBe(1);
    for (const f of files) expect(statSync(join(dir, f)).size).toBeGreaterThan(0);
    // Nothing left behind next to it.
    expect(readdirSync(join(tools, 'al-symbols')).filter((f) => f.startsWith('.staging') || f.startsWith('.old'))).toEqual([]);
  });

  test('a second run within a day uses the cache without touching the feed', () => {
    const r = run(tools, app, { AL_SYMBOLS_FEED: 'http://127.0.0.1:9/unreachable' });
    expect(r.exitCode).toBe(0);
    expect(norm(r.stdout.toString())).toBe(norm(join(tools, 'al-symbols', '28')));
  });

  test('a stale set is kept when the feed cannot be reached', () => {
    const marker = join(tools, 'al-symbols', '28', '.versions');
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    utimesSync(marker, old, old);
    const r = run(tools, app, { AL_SYMBOLS_FEED: 'http://127.0.0.1:9/unreachable' });
    expect(r.exitCode).toBe(0);
    expect(norm(r.stdout.toString())).toBe(norm(join(tools, 'al-symbols', '28')));
    expect(apps(join(tools, 'al-symbols', '28'))).toHaveLength(5);
  });

  test('a stale set with unchanged versions is re-dated, not re-downloaded', () => {
    const dir = join(tools, 'al-symbols', '28');
    const marker = join(dir, '.versions');
    const before = readFileSync(marker, 'utf8');
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    utimesSync(marker, old, old);
    const appMtime = statSync(join(dir, 'System.app')).mtimeMs;
    const r = run(tools, app);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe(before);
    expect(statSync(marker).mtimeMs).toBeGreaterThan(old.getTime());
    expect(statSync(join(dir, 'System.app')).mtimeMs).toBe(appMtime);
  }, 120_000);

  test('a major the feed does not have caches nothing and prints nothing', () => {
    const other = mkdtempSync(join(tmpdir(), 'al-sym-99-'));
    try {
      const r = run(other, appJson(other, { application: '99.0.0.0' }));
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout.toString().trim()).toBe('');
      expect(readdirSync(join(other, 'al-symbols'))).not.toContain('99');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  }, 120_000);

  test('falls back to "platform" when "application" is absent; no version at all is a skip', () => {
    const other = mkdtempSync(join(tmpdir(), 'al-sym-plat-'));
    try {
      const r = run(tools, appJson(other, { platform: '28.0.0.0' }));
      expect(norm(r.stdout.toString())).toBe(norm(join(tools, 'al-symbols', '28')));
      const none = run(tools, appJson(other, {}));
      expect(none.exitCode).not.toBe(0);
      expect(none.stdout.toString().trim()).toBe('');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test('concurrent first runs on an empty cache all succeed and leave one complete set', async () => {
    const shared = mkdtempSync(join(tmpdir(), 'al-sym-race-'));
    try {
      const a = appJson(shared, { application: '28.0.0.0' });
      const procs = [runAsync(shared, a), runAsync(shared, a), runAsync(shared, a)];
      const results = await Promise.all(procs.map(async (p) => ({ code: await p.exited, out: await new Response(p.stdout).text() })));
      const dir = join(shared, 'al-symbols', '28');
      for (const r of results) {
        expect(r.code).toBe(0);
        expect(norm(r.out)).toBe(norm(dir));
      }
      expect(apps(dir)).toHaveLength(5);
      expect(readdirSync(join(shared, 'al-symbols')).filter((f) => f.startsWith('.staging') || f.startsWith('.old'))).toEqual([]);
    } finally {
      rmSync(shared, { recursive: true, force: true });
    }
  }, 600_000);
});
