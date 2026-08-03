import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { containerDatabaseUrl } from '../../src/sdk/docker.ts';

// ---------------------------------------------------------------------------
// containerDatabaseUrl
//
// `.env` holds a host-facing DATABASE_URL because that is right for anything run
// on the host. Handing it to a spawned container points that container at
// itself: the review completes normally, the store swallows the connection
// failure, and the row is never written. Eight arms once ran that way — a whole
// matrix's worth of spend, zero rows, and nothing in the logs to say so.
// ---------------------------------------------------------------------------

describe('containerDatabaseUrl', () => {
  test('rewrites localhost to the compose service, keeping the port', () => {
    expect(containerDatabaseUrl('postgres://pipeline:pw@localhost:5432/pipeline'))
      .toBe('postgres://pipeline:pw@postgres:5432/pipeline');
  });

  test('rewrites 127.0.0.1 and host.docker.internal too', () => {
    expect(containerDatabaseUrl('postgres://u:p@127.0.0.1:5432/db'))
      .toBe('postgres://u:p@postgres:5432/db');
    expect(containerDatabaseUrl('postgres://u:p@host.docker.internal:5432/db'))
      .toBe('postgres://u:p@postgres:5432/db');
  });

  test('leaves an already-internal URL alone — idempotent', () => {
    const internal = 'postgres://pipeline:pw@postgres:5432/pipeline';
    expect(containerDatabaseUrl(internal)).toBe(internal);
  });

  test('does not touch a genuinely remote host', () => {
    const remote = 'postgres://u:p@db.example.com:5432/pipeline';
    expect(containerDatabaseUrl(remote)).toBe(remote);
  });

  test('handles a missing port', () => {
    expect(containerDatabaseUrl('postgres://u:p@localhost/db'))
      .toBe('postgres://u:p@postgres/db');
  });

  test('a password containing "localhost" is not mistaken for the host', () => {
    // The rewrite anchors on `@`, so only the host segment can match.
    expect(containerDatabaseUrl('postgres://u:localhost@localhost:5432/db'))
      .toBe('postgres://u:localhost@postgres:5432/db');
  });

  test('empty stays empty rather than becoming a bogus URL', () => {
    expect(containerDatabaseUrl('')).toBe('');
  });

  test('honours a custom service name', () => {
    expect(containerDatabaseUrl('postgres://u:p@localhost:5432/db', 'pg'))
      .toBe('postgres://u:p@pg:5432/db');
  });
});

// ---------------------------------------------------------------------------
// buildDockerArgs must not clobber a caller-supplied DATABASE_URL
//
// It used to append `-e DATABASE_URL=<host value>` AFTER the config.env loop.
// Docker takes the LAST -e for a key, so a caller that had deliberately
// rewritten the URL for in-container use silently got the host value back —
// which would have defeated the containerDatabaseUrl fix entirely.
// ---------------------------------------------------------------------------

import { buildDockerArgs } from '../../src/sdk/docker.ts';

function dbUrlsIn(args: string[]): string[] {
  return args
    .map((a, i) => (a === '-e' ? args[i + 1] ?? '' : ''))
    .filter(v => v.startsWith('DATABASE_URL='))
    .map(v => v.slice('DATABASE_URL='.length));
}

const baseCfg = {
  workItemId: 0,
  repoKey: 'r',
  repo: { url: 'https://example/r', branch: 'main' } as never,
  command: 'review-pr' as const,
  stateVolume: 'sv',
  workspaceVolume: 'wv',
  imageName: 'img',
  extraArgs: [],
};

describe('buildDockerArgs DATABASE_URL handling', () => {
  const saved = process.env['DATABASE_URL'];
  beforeEach(() => { process.env['DATABASE_URL'] = 'postgres://u:p@localhost:5432/db'; });
  afterEach(() => { if (saved === undefined) delete process.env['DATABASE_URL']; else process.env['DATABASE_URL'] = saved; });

  test('a caller-supplied URL is the only one passed', () => {
    const args = buildDockerArgs({ ...baseCfg, env: { DATABASE_URL: 'postgres://u:p@postgres:5432/db' } });
    expect(dbUrlsIn(args)).toEqual(['postgres://u:p@postgres:5432/db']);
  });

  test('falls back to the process env when the caller supplies none', () => {
    const args = buildDockerArgs({ ...baseCfg, env: { FOO: 'bar' } });
    expect(dbUrlsIn(args)).toEqual(['postgres://u:p@localhost:5432/db']);
  });
});
