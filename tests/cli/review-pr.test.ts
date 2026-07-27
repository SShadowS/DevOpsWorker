import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { maybeInjectToolRule, maybeOverrideSubAgentModel, SUBAGENT_TOOL_RULE } from '../../src/cli/review-pr.ts';

// ---------------------------------------------------------------------------
// EVAL-ONLY A/B hooks
//
// Both mutate sub-agent definition files on disk, so what matters most is that
// they are TRUE no-ops unless explicitly switched on — a production PR review
// must never have its prompts or pinned models rewritten underneath it.
// ---------------------------------------------------------------------------

function withEnv(key: string) {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[key]; delete process.env[key]; });
  afterEach(() => { if (saved === undefined) delete process.env[key]; else process.env[key] = saved; });
}

describe('maybeInjectToolRule', () => {
  withEnv('PR_REVIEW_SUBAGENT_TOOL_RULE');

  test('is a no-op when unset — production runs must not be mutated', () => {
    expect(maybeInjectToolRule()).toBe(0);
  });

  test('is a no-op for any value other than "1"', () => {
    process.env['PR_REVIEW_SUBAGENT_TOOL_RULE'] = 'true';
    expect(maybeInjectToolRule()).toBe(0);
    process.env['PR_REVIEW_SUBAGENT_TOOL_RULE'] = '0';
    expect(maybeInjectToolRule()).toBe(0);
    process.env['PR_REVIEW_SUBAGENT_TOOL_RULE'] = '';
    expect(maybeInjectToolRule()).toBe(0);
  });
});

describe('maybeOverrideSubAgentModel', () => {
  withEnv('PR_REVIEW_SUBAGENT_MODEL');

  test('is a no-op when unset', () => {
    expect(maybeOverrideSubAgentModel()).toBe(0);
  });

  test('is a no-op for an empty or whitespace value', () => {
    process.env['PR_REVIEW_SUBAGENT_MODEL'] = '   ';
    expect(maybeOverrideSubAgentModel()).toBe(0);
  });
});

describe('SUBAGENT_TOOL_RULE', () => {
  test('routes toward tools rather than forbidding Bash', () => {
    // Negative framing is measured to backfire on this codebase: telling an
    // agent what NOT to do suppresses the tool entirely instead of redirecting.
    expect(SUBAGENT_TOOL_RULE).not.toMatch(/\bNEVER\b|\bDo NOT\b|\bdon't use\b/i);
  });

  test('names specific LSP operations, not just "use LSP"', () => {
    // Four of the seven sub-agents already mention LSP once, in passing — and
    // made zero LSP calls. A bare mention is not steering.
    for (const op of ['goToDefinition', 'findReferences', 'hover', 'documentSymbol', 'incomingCalls']) {
      expect(SUBAGENT_TOOL_RULE).toContain(op);
    }
  });

  test('gives the cost reason, which is the persuasive part', () => {
    expect(SUBAGENT_TOOL_RULE).toContain('stays in your context');
  });

  test('points Read at partial reads — the exact sed use it replaces', () => {
    expect(SUBAGENT_TOOL_RULE).toContain('`Read` with `offset`/`limit`');
  });
});
