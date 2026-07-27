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

  test('code-reviewer and plan-reviewer agents pin model: claude-sonnet-5 (Phase 1B activates real values)', () => {
    const scoped = files.filter(
      (f) => f.includes('code-reviewer') || f.includes('plan-reviewer'),
    );
    expect(scoped.length).toBe(12);
    for (const f of scoped) {
      const src = readFileSync(f, 'utf-8');
      expect(src).toMatch(/^model:\s*claude-sonnet-5\s*$/m);
    }
  });

  test('pr-reviewer agents pin model: claude-sonnet-5 — measured, not assumed', () => {
    // Was `model: opus` on all 7. A/B on PR 52081 (2026-07-27, n=1 per arm):
    // Sonnet cost $10.65 vs Opus $19.46 (-45%) and made 31 Bash calls vs 124,
    // while producing the SAME seven core findings plus one the Opus arms
    // missed entirely (no HTTP timeout on the path — a hang inside an open
    // write transaction). Both arms returned `request changes` with 1 critical.
    //
    // Flipping these back to opus costs ~45% more per review for no measured
    // gain. If you do it, bring evidence.
    const scoped = files.filter((f) => f.includes('pr-reviewer'));
    expect(scoped.length).toBe(7);
    for (const f of scoped) {
      expect(readFileSync(f, 'utf-8')).toMatch(/^model:\s*claude-sonnet-5\s*$/m);
    }
  });

  test('code-reviewer and plan-reviewer agents declare a scoped tools key as a comma-separated string (Phase 1B)', () => {
    const scoped = files.filter(
      (f) => f.includes('code-reviewer') || f.includes('plan-reviewer'),
    );
    for (const f of scoped) {
      expect(frontmatterKeys(f)).toContain('tools');
      const src = readFileSync(f, 'utf-8');
      const m = src.match(/^tools:\s*(.+)\s*$/m);
      expect(m).not.toBeNull();
      // Must be a comma-separated string, not a YAML array — a `[` here would mean
      // the old broken `allowed_tools` array format crept back in under the new key.
      expect(m![1]).not.toContain('[');
    }
  });
});
