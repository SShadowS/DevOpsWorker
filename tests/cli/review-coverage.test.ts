import { describe, test, expect } from 'bun:test';
import { reviewCoverageLine, withCoverageLine, COVERAGE_MARKER } from '../../src/cli/review-pr.ts';
import { PR_SUB_AGENTS } from '../../src/agents/pr-reviewer/schema.ts';
import type { SubAgentUsage } from '../../src/types/pipeline.types.ts';

function ran(...names: string[]): Record<string, SubAgentUsage> {
  return Object.fromEntries(names.map((name) => [name, {
    name, turns: 3, toolCalls: {},
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  } as unknown as SubAgentUsage]));
}

describe('reviewCoverageLine', () => {
  test('all seven specialists ran', () => {
    expect(reviewCoverageLine('full', ran(...PR_SUB_AGENTS))).toBe('<sub>Specialists: 7 of 7 ran.</sub>');
  });

  test('some ran: names the ones that did not', () => {
    expect(reviewCoverageLine('full', ran('code-review-validator', 'code-quality-assessor', 'al-performance-analyzer')))
      .toBe('<sub>Specialists: 3 of 7 ran. Not run: al-error-pattern-analyzer, al-integration-analyzer, al-architecture-analyzer, security-edge-case-analyzer.</sub>');
  });

  test('none ran, including when telemetry is missing', () => {
    const none = '<sub>Specialists: none of 7 ran; the reviewer checked the change on its own.</sub>';
    expect(reviewCoverageLine('full', {})).toBe(none);
    expect(reviewCoverageLine('full', undefined)).toBe(none);
  });

  test('test-gap-analyzer is extra, not one of the seven', () => {
    expect(reviewCoverageLine('full', ran(...PR_SUB_AGENTS, 'test-gap-analyzer'))).toBe('<sub>Specialists: 7 of 7 ran.</sub>');
  });

  test('a cherry-pick sanity check says the specialist review is not repeated', () => {
    expect(reviewCoverageLine('sanity', {}))
      .toBe('<sub>Cherry-pick check: compared with the original PR; the specialist review is not repeated.</sub>');
  });
});

describe('withCoverageLine', () => {
  const line = '<sub>Specialists: 7 of 7 ran.</sub>';

  test('appends the line under a hidden marker', () => {
    expect(withCoverageLine('## Code Review — X\n\nBody', line))
      .toBe(`## Code Review — X\n\nBody\n\n${COVERAGE_MARKER}\n${line}`);
  });

  test('replaces an earlier line instead of stacking a second one', () => {
    const once = withCoverageLine('Body', '<sub>Specialists: 2 of 7 ran.</sub>');
    expect(withCoverageLine(once, line)).toBe(`Body\n\n${COVERAGE_MARKER}\n${line}`);
  });
});
