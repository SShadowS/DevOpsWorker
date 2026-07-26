// tests/agents/orchestrator-dedupe.test.ts
//
// Regression guard for the "orchestrators dispatch sub-agents by name" refactor.
// Before it, `code-reviewer/CLAUDE.md` inlined a full copy of each of its 8
// sub-agent prompts that ALSO shipped as `.claude/agents/*.md` — ~4,800 words of
// duplication that drifted (two reviewers' standalone files had strictly stronger
// rules than their inlined twins) and repeated the `.dependencies` paragraph 8×.
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

const CODE_REVIEWER = 'src/agents/code-reviewer/CLAUDE.md';
const PLAN_REVIEWER = 'src/agents/plan-reviewer/CLAUDE.md';

describe('orchestrators do not inline sub-agent prompts', () => {
  test('code-reviewer carries no "Full prompt to send" blocks', () => {
    const src = readFileSync(CODE_REVIEWER, 'utf-8');
    expect(src).not.toContain('**Full prompt to send:**');
  });

  test('code-reviewer no longer repeats the .dependencies paragraph', () => {
    const src = readFileSync(CODE_REVIEWER, 'utf-8');
    const count = (src.match(/Folders Are Normal Code/g) ?? []).length;
    expect(count).toBeLessThanOrEqual(1);
  });

  test('code-reviewer prompt is under 2500 words', () => {
    const words = readFileSync(CODE_REVIEWER, 'utf-8').split(/\s+/).length;
    expect(words).toBeLessThan(2500);
  });

  test('code-reviewer does not dispatch general-purpose', () => {
    expect(readFileSync(CODE_REVIEWER, 'utf-8')).not.toContain('general-purpose');
  });

  // Owned by the sibling plan-reviewer conversion task; flip to `test` there.
  test.skip('plan-reviewer does not dispatch general-purpose', () => {
    expect(readFileSync(PLAN_REVIEWER, 'utf-8')).not.toContain('general-purpose');
  });
});

describe('code-reviewer dispatch prompt carries the per-run context', () => {
  // Under name-dispatch the standalone file is the sub-agent's *system prompt*
  // (stable instructions) and the orchestrator's dispatch message is its first
  // *user turn* (per-run data). Nothing else carries these four values, so the
  // orchestrator must still name all four for every dispatch.
  test.each(['<BRANCH>', '<FILE_LIST>', '<DEV_PLAN_SUMMARY>', '<COMPILATION_ERRORS>'])(
    'names %s',
    (placeholder) => {
      expect(readFileSync(CODE_REVIEWER, 'utf-8')).toContain(placeholder);
    },
  );

  test('retains the AL Review Patterns distribution by category', () => {
    const src = readFileSync(CODE_REVIEWER, 'utf-8');
    expect(src).toContain('page-security');
    expect(src).toContain('authorization');
    expect(src).toContain('page-design');
    expect(src).toContain('property-interaction');
    expect(src).toContain('logic-error');
  });

  test('dispatches all 8 sub-agents by their frontmatter name', () => {
    const src = readFileSync(CODE_REVIEWER, 'utf-8');
    for (const name of [
      'correctness-reviewer',
      'architecture-reviewer',
      'performance-reviewer',
      'error-handling-reviewer',
      'integration-reviewer',
      'security-reviewer',
      'quality-reviewer',
      'devils-advocate-reviewer',
    ]) {
      expect(src).toContain(name);
    }
  });
});

describe('code-reviewer sub-agent files are self-sufficient', () => {
  const AGENT_DIR = 'src/agents/code-reviewer/.claude/agents';
  const ALL = [
    'correctness-reviewer',
    'architecture-reviewer',
    'performance-reviewer',
    'error-handling-reviewer',
    'integration-reviewer',
    'security-reviewer',
    'quality-reviewer',
    'devils-advocate-reviewer',
  ];

  test.each(ALL)('%s carries its own .dependencies guidance', (name) => {
    const src = readFileSync(`${AGENT_DIR}/${name}.md`, 'utf-8');
    expect(src).toContain('.dependencies');
  });

  test.each(ALL)('%s has no un-substituted placeholder tokens', (name) => {
    // Nothing walks these files replacing tokens any more — they are static
    // system prompts, so a literal `<BRANCH>` would reach the model verbatim.
    const src = readFileSync(`${AGENT_DIR}/${name}.md`, 'utf-8');
    for (const token of ['<BRANCH>', '<FILE_LIST>', '<DEV_PLAN_SUMMARY>', '<COMPILATION_ERRORS>']) {
      expect(src).not.toContain(token);
    }
  });
});
