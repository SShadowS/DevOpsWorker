import { describe, test, expect, mock, afterEach } from 'bun:test';
import { fetchFileAtCommit } from '../../../src/sdk/ado/items.ts';
import type { PipelineConfig } from '../../../src/types/pipeline.types.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const config = {
  azureDevOps: {
    orgUrl: 'https://dev.azure.com/o',
    project: 'proj',
    repositoryId: 'repo-guid',
    pat: 'test-pat',
  },
} as unknown as PipelineConfig;

/**
 * The endpoint answers with the FILE, not JSON. Measured live on 2026-08-14:
 * `200`, `content-type: application/octet-stream; api-version=7.0`, body = the
 * file's own bytes. Mocking a `{ content }` envelope here would make every test
 * below pass against an implementation that returns null in production.
 */
function mockRaw(body: string, status = 200) {
  const calls: string[] = [];
  const inits: RequestInit[] = [];
  globalThis.fetch = mock((url: string, init: RequestInit = {}) => {
    calls.push(String(url));
    inits.push(init);
    return Promise.resolve(
      new Response(body, {
        status,
        headers: { 'content-type': 'application/octet-stream; api-version=7.0' },
      }),
    );
  }) as unknown as typeof fetch;
  return { calls, inits };
}

describe('fetchFileAtCommit', () => {
  test('returns the file text as served, not a parsed envelope', async () => {
    mockRaw('line one\nline two\n');
    const text = await fetchFileAtCommit('/App/X.al', 'abc123', config);
    expect(text).toBe('line one\nline two\n');
  });

  test('returns AL source unchanged — the case JSON.parse would have thrown on', async () => {
    mockRaw('codeunit 68968 "CDO X"\n{\n}\n');
    const text = await fetchFileAtCommit('/App/X.al', 'abc123', config);
    expect(text).toBe('codeunit 68968 "CDO X"\n{\n}\n');
  });

  test('returns a JSON file verbatim — not the object it happens to describe', async () => {
    mockRaw('{"content":"decoy"}');
    expect(await fetchFileAtCommit('/app.json', 'abc123', config)).toBe('{"content":"decoy"}');
  });

  test('asks for the content of that exact commit', async () => {
    const { calls } = mockRaw('');
    await fetchFileAtCommit('/App/X.al', 'abc123', config);
    expect(calls[0]).toContain('versionDescriptor.version=abc123');
    expect(calls[0]).toContain('versionDescriptor.versionType=commit');
    expect(calls[0]).toContain('includeContent=true');
  });

  test('asks for text, so no JSON envelope comes back', async () => {
    const { inits } = mockRaw('');
    await fetchFileAtCommit('/App/X.al', 'abc123', config);
    expect((inits[0]!.headers as Record<string, string>)['Accept']).toBe('text/plain');
  });

  test('adds the leading slash a repo-relative path lacks', async () => {
    const { calls } = mockRaw('');
    await fetchFileAtCommit('App/X.al', 'abc123', config);
    expect(calls[0]).toContain(encodeURIComponent('/App/X.al'));
  });

  test('returns null when the file is missing, rather than throwing', async () => {
    mockRaw('not found', 404);
    expect(await fetchFileAtCommit('/App/Gone.al', 'abc123', config)).toBeNull();
  });

  test('returns null on a server error', async () => {
    mockRaw('boom', 500);
    expect(await fetchFileAtCommit('/App/X.al', 'abc123', config)).toBeNull();
  });

  test('returns null when the network call rejects', async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error('socket hang up'))) as unknown as typeof fetch;
    expect(await fetchFileAtCommit('/App/X.al', 'abc123', config)).toBeNull();
  });
});
