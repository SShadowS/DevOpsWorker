import { describe, test, expect, mock, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveSuggestion } from '../../src/cli/review-pr.ts';
import type { PRFinding } from '../../src/agents/pr-reviewer/schema.ts';
import type { PipelineConfig } from '../../src/types/pipeline.types.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const config = {
  azureDevOps: { orgUrl: 'https://dev.azure.com/o', project: 'proj', repositoryId: 'repo', pat: 'p' },
} as unknown as PipelineConfig;

// Trailing newline throughout: `suggestionApplies` refuses a range ending on the
// file's last line, so a fixture without one cannot exercise its own last line.
const FILE = 'line one\n    if A < B then\nline three\n';

/** Raw text, matching what the items endpoint actually serves. Pass null for "unreadable". */
function mockFile(content: string | null) {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      content === null
        ? new Response('not found', { status: 404 })
        : new Response(content, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
    ),
  ) as unknown as typeof fetch;
}

const finding: PRFinding = {
  severity: 'major',
  title: 'Wrong operator',
  body: 'off by one',
  file: 'App/X.al',
  line: 2,
  replacesText: '    if A < B then',
  suggestedFix: '    if A <= B then',
};

describe('resolveSuggestion', () => {
  test('returns a block and end anchor when the claimed text matches', async () => {
    mockFile(FILE);
    const got = await resolveSuggestion(finding, 'commit-sha', config);
    expect(got).not.toBeNull();
    expect(got!.endLine).toBe(3);
    expect(got!.block).toBe('```suggestion\n    if A <= B then\n\n```');
  });

  test('returns null when the claimed text no longer matches the file', async () => {
    mockFile('line one\n    if A <= B then\nline three\n');
    expect(await resolveSuggestion(finding, 'commit-sha', config)).toBeNull();
  });

  test('returns null when the file cannot be read', async () => {
    mockFile(null);
    expect(await resolveSuggestion(finding, 'commit-sha', config)).toBeNull();
  });

  test('returns null when there is no source commit to verify against', async () => {
    mockFile(FILE);
    expect(await resolveSuggestion(finding, undefined, config)).toBeNull();
  });

  test('returns null when only one of the two fields is present', async () => {
    mockFile(FILE);
    const partial = { ...finding, replacesText: undefined };
    expect(await resolveSuggestion(partial, 'commit-sha', config)).toBeNull();
  });

  test('does not call the API at all when the finding carries no suggestion', async () => {
    let calls = 0;
    globalThis.fetch = mock(() => {
      calls++;
      return Promise.resolve(new Response('', { status: 200 }));
    }) as unknown as typeof fetch;
    const plain = { ...finding, replacesText: undefined, suggestedFix: undefined };
    expect(await resolveSuggestion(plain, 'commit-sha', config)).toBeNull();
    expect(calls).toBe(0);
  });

  test('anchors a two-line replacement two lines further down', async () => {
    mockFile('a\nb\nc\nd\n');
    const twoLine: PRFinding = { ...finding, line: 2, replacesText: 'b\nc', suggestedFix: 'B\nC' };
    const got = await resolveSuggestion(twoLine, 'commit-sha', config);
    expect(got!.endLine).toBe(4);
  });

  test('returns null when the replacement contains a fence that would break the block', async () => {
    mockFile(FILE);
    const fenced = { ...finding, suggestedFix: '    if A <= B then\n```\nnot code' };
    expect(await resolveSuggestion(fenced, 'commit-sha', config)).toBeNull();
  });

  test('refuses a replacement of the file’s last line', async () => {
    mockFile('a\nb');
    const lastLine = { ...finding, line: 2, replacesText: 'b', suggestedFix: 'B' };
    expect(await resolveSuggestion(lastLine, 'commit-sha', config)).toBeNull();
  });
});

describe('applyInlineFindings source pins', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/cli/review-pr.ts', import.meta.url)), 'utf-8');

  test('the update branch posts no suggestion — its anchor cannot be re-verified', () => {
    // A suggestion attaches to a thread's ANCHOR, which an update cannot change,
    // and Azure DevOps re-anchors threads across iterations. So a re-raised
    // finding deliberately loses its Apply button rather than keeping one that
    // points at lines this gate never checked. Pinned because the fix looks like
    // an oversight to anyone reading the update branch on its own.
    const update = src.match(/await updateThreadComment\(([^;]*)\);/);
    expect(update).not.toBeNull();
    expect(update![1]).toContain('buildCommentBody(finding, key)');
    expect(update![1]).not.toContain('suggestion');
  });

  test('the source commit is read inside applyInlineFindings, not taken from the caller', () => {
    // The caller's prMetadata was read before the agent ran and can be minutes
    // stale. See the note at the top of this task.
    const fn = src.slice(src.indexOf('export async function applyInlineFindings'));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toContain('fetchPRMetadata(prId, config)');
  });
});
