import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readPromptFile, buildSharedFragmentContent } from '../../src/sdk/prompt-loader.ts';

const tmpDirs: string[] = [];

/** Create a temp PRIVATE_DIR, optionally with a prompts/<name> override file. */
function overlayWith(name?: string, content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-loader-test-'));
  tmpDirs.push(dir);
  if (name) {
    mkdirSync(join(dir, 'prompts'), { recursive: true });
    writeFileSync(join(dir, 'prompts', name), content ?? '');
  }
  return dir;
}

afterEach(() => {
  delete process.env['PRIVATE_DIR'];
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('readPromptFile — public fallback', () => {
  test('reads a fragment from src/prompts when the overlay has no override', () => {
    // PRIVATE_DIR points at a temp dir WITHOUT the fragment → falls back to src/.
    process.env['PRIVATE_DIR'] = overlayWith();
    const content = readPromptFile('prompts/tdd.md');
    expect(content.length).toBeGreaterThan(0);
  });

  test('throws a descriptive error for a missing fragment (no override, not in src)', () => {
    process.env['PRIVATE_DIR'] = overlayWith();
    expect(() => readPromptFile('prompts/this-does-not-exist.md')).toThrow(/Failed to read prompt file/);
  });
});

describe('readPromptFile — overlay OVERRIDE', () => {
  test('overlay prompts/<name> wins over src/prompts/<name>', () => {
    process.env['PRIVATE_DIR'] = overlayWith('project-context.md', '# OVERLAY WINS\nmarker-12345');
    const content = readPromptFile('prompts/project-context.md');
    expect(content).toContain('marker-12345');
    expect(content).toContain('OVERLAY WINS');
  });

  test('content is trimmed', () => {
    process.env['PRIVATE_DIR'] = overlayWith('x.md', '\n\n  hello overlay  \n\n');
    expect(readPromptFile('prompts/x.md')).toBe('hello overlay');
  });

  test('override only applies to prompts/ paths, not other relative paths', () => {
    // An overlay file under prompts/ must NOT be returned for a non-prompts path.
    const dir = overlayWith('agents-prompt.md', 'should-not-be-used');
    process.env['PRIVATE_DIR'] = dir;
    // A non-prompts path skips overlay resolution and reads from src/ (missing → throws).
    expect(() => readPromptFile('agents/nonexistent-agent/prompt.md')).toThrow(/Failed to read prompt file/);
  });
});

describe('buildSharedFragmentContent', () => {
  test('returns empty string for no fragments', () => {
    expect(buildSharedFragmentContent([])).toBe('');
  });

  test('concatenates multiple fragments with a separator', () => {
    const out = buildSharedFragmentContent(['tdd.md', 'sdd.md']);
    expect(out).toContain('---');
    expect(out.length).toBeGreaterThan(10);
  });

  test('a single overridden fragment flows through buildSharedFragmentContent', () => {
    process.env['PRIVATE_DIR'] = overlayWith('tdd.md', 'OVERRIDDEN-TDD-marker');
    expect(buildSharedFragmentContent(['tdd.md'])).toBe('OVERRIDDEN-TDD-marker');
  });
});
