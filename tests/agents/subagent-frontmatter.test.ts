// tests/agents/subagent-frontmatter.test.ts
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { Glob } from 'bun';

// Keys the Claude Code sub-agent frontmatter schema actually supports.
// `allowed_tools` is NOT one of them — it was used in 12 files and silently ignored.
const VALID_KEYS = new Set(['name', 'description', 'model', 'tools', 'color', 'skills']);

function agentFiles(): string[] {
  const glob = new Glob('src/agents/*/.claude/agents/*.md');
  // dot: true is required — the pattern crosses a dot-directory (`.claude`),
  // which Bun's Glob excludes by default regardless of platform.
  return [...glob.scanSync({ cwd: '.', dot: true })];
}

function frontmatterKeys(path: string): string[] {
  const src = readFileSync(path, 'utf-8');
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m || m[1] === undefined) return [];
  return m[1]
    .split(/\r?\n/)
    .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(line))
    .map((line) => line.slice(0, line.indexOf(':')).trim());
}

describe('sub-agent frontmatter', () => {
  const files = agentFiles();

  test('finds the expected sub-agent files', () => {
    expect(files.length).toBeGreaterThanOrEqual(19);
  });

  test('every file uses only supported frontmatter keys', () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const key of frontmatterKeys(f)) {
        if (!VALID_KEYS.has(key)) offenders.push(`${f}: ${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('code-reviewer and plan-reviewer agents pin model: inherit (Phase 1A holds behaviour)', () => {
    const scoped = files.filter(
      (f) => f.includes('code-reviewer') || f.includes('plan-reviewer'),
    );
    expect(scoped.length).toBe(12);
    for (const f of scoped) {
      const src = readFileSync(f, 'utf-8');
      expect(src).toMatch(/^model:\s*inherit\s*$/m);
    }
  });

  test('code-reviewer and plan-reviewer agents declare no tools key in Phase 1A', () => {
    const scoped = files.filter(
      (f) => f.includes('code-reviewer') || f.includes('plan-reviewer'),
    );
    for (const f of scoped) {
      expect(frontmatterKeys(f)).not.toContain('tools');
    }
  });
});
