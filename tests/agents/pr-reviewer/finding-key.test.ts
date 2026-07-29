import { describe, test, expect } from 'bun:test';
import { findingKey, markerFor, extractKey } from '../../../src/sdk/ado/finding-key.ts';

describe('findingKey', () => {
  test('is stable for the same file and title', () => {
    expect(findingKey('a/B.al', 'Missing timeout')).toBe(findingKey('a/B.al', 'Missing timeout'));
  });

  test('ignores case, punctuation and whitespace in the title', () => {
    expect(findingKey('a/B.al', 'Missing  timeout!')).toBe(findingKey('a/B.al', 'missing timeout'));
  });

  test('differs by file', () => {
    expect(findingKey('a/B.al', 't')).not.toBe(findingKey('a/C.al', 't'));
  });

  test('is hex and short enough to embed', () => {
    expect(findingKey('a/B.al', 't')).toMatch(/^[0-9a-f]{16}$/);
  });

  test('a leading slash on the file does not change the identity', () => {
    // ADO's stored thread anchor and the model's repo-relative report are the
    // same finding — without this they silently forked into two threads.
    expect(findingKey('/App/x.al', 't')).toBe(findingKey('App/x.al', 't'));
  });

  test('backslashes in the file normalise to forward slashes', () => {
    expect(findingKey('App\\Sub\\x.al', 't')).toBe(findingKey('App/Sub/x.al', 't'));
  });
});

describe('marker round-trip', () => {
  test('extractKey recovers the key from a rendered comment body', () => {
    const key = findingKey('a/B.al', 'Missing timeout');
    const body = `${markerFor(key)}\n\n### Missing timeout\n\nSome prose.`;
    expect(extractKey(body)).toBe(key);
  });

  test('returns null when there is no marker (a human comment)', () => {
    expect(extractKey('Looks fine to me, shipping it')).toBeNull();
  });

  test('returns null for a marker-shaped string that is not ours', () => {
    // Full-length (16 hex) key, wrong tool prefix — isolates the `ai-finding:` literal check.
    expect(extractKey('<!-- some-other-tool:0123456789abcdef -->')).toBeNull();
    // Short key, wrong tool prefix — kept for the length-mismatch case too.
    expect(extractKey('<!-- some-other-tool:abc123 -->')).toBeNull();
  });
});
