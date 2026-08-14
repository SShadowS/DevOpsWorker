// tests/agents/subagent-frontmatter.test.ts
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { Glob } from 'bun';

// Keys the Claude Code sub-agent frontmatter schema actually supports.
// `allowed_tools` is NOT one of them — it was used in 12 files and silently ignored.
//
// `disallowedTools` was added after checking the CLI binary's own frontmatter
// schema rather than assuming, given the `allowed_tools` history. The schema
// describes it as "Tools removed from the default set. Ignored if `tools` is
// set.", and the agent-file loader carries it through to the agent definition.
//
// camelCase ONLY in an agent file. The kebab-case `disallowed-tools` is an alias
// in the slash-command frontmatter schema and in the CLI flags — the agent-file
// loader reads the camelCase key alone, so a kebab spelling here would bind
// nothing. `frontmatterKeys()` cannot even extract a hyphenated key, so this
// allowlist would not flag it either: it would fail exactly as silently as
// `allowed_tools` did.
const VALID_KEYS = new Set([
  'name', 'description', 'model', 'tools', 'color', 'skills', 'disallowedTools',
]);

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
    // Sonnet cost meaningfully less than Opus (-45%) and made 31 Bash calls vs 124,
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

  test('the image normalises agent prompt line endings', () => {
    // Regression guard for 2026-07-29. A sub-agent is discovered by parsing the
    // frontmatter delimited by a line that must be exactly `---`. When the file
    // reaches the container CRLF, the delimiter is `---\r`, the parse fails, and
    // the Agent tool silently does not register that agent — no error, nothing in
    // the logs. Three pr-reviewer agents dropped out this way; the orchestrator
    // fell back to `general-purpose` and did their analysis itself, tripling its
    // own spend per review.
    //
    // .gitattributes stores these LF, but the Docker build context is the WORKING
    // TREE and `text=auto` checks them out CRLF on Windows. The Dockerfile step is
    // what makes the host's line endings irrelevant, so it must not be removed.
    //
    // This asserts the mechanism rather than the files: on Windows every agent .md
    // in the working tree is legitimately CRLF, so checking them here would fail
    // for the wrong reason.
    const dockerfile = readFileSync('Dockerfile', 'utf-8');
    expect(dockerfile).toMatch(/find src\/agents -name '\*\.md' -exec sed -i 's\/\\r\$\/\/' \{\} \+/);
  });

  test('every agent file has a parseable frontmatter block once CR is stripped', () => {
    // Complements the test above: the delimiters must be well-formed in the first
    // place, so normalisation is sufficient rather than merely necessary.
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf-8').replace(/\r/g, '');
      if (!/^---\n[\s\S]*?\n---\n/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
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
