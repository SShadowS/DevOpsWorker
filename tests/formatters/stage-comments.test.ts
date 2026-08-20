import { describe, test, expect } from 'bun:test';
import { STAGE_COMMENTS } from '../../src/formatters/stage-comments.ts';
import type { PipelineState } from '../../src/types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// The declared format has to match what the formatter actually emits
//
// Azure DevOps does not sniff the content. A Markdown comment posted as html
// renders `##` and table pipes literally and collapses every newline into one
// paragraph — the dev plan on work item 81098 arrived as an unreadable wall of
// text that way. These tests read each formatter's real output and check the
// table's declaration against it, so a new stage cannot be added with the wrong
// one and an existing one cannot be flipped by accident.
// ---------------------------------------------------------------------------

/** Syntax that only means anything when the comment is posted as markdown. */
function usesMarkdownSyntax(text: string): boolean {
  return /^#{1,6}\s/m.test(text) || /^\|\s*-{3,}/m.test(text) || /^\s*\|.+\|\s*$/m.test(text);
}

/** A comment built from HTML tags rather than markdown. */
function usesHtmlSyntax(text: string): boolean {
  return /^\s*<(h[1-6]|p|b|ul|ol|div)\b/i.test(text);
}

function stateFor(stage: string): PipelineState {
  const base = {
    currentStage: stage,
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: '2026-01-01T00:00:00.000Z',
  };
  const extras: Record<string, unknown> = {
    analyzer: {
      readiness: {
        verdict: 'proceed',
        summary: 'Ready for planning.',
        gaps: [],
        enrichedContext: {
          title: 'Duplicate dispatch',
          type: 'Bug',
          description: 'Two paths dispatch the same document.',
          acceptanceCriteria: 'Exactly one dispatch.',
          targetArea: 'dispatch',
          relatedWorkItems: [],
          codebaseInsights: [],
        },
      },
    },
    planning: {
      devPlan: {
        summary: 'Add a guard on the dispatch path.',
        objects: [{
          action: 'modify', objectType: 'codeunit', objectId: 6175375,
          objectName: 'Dispatcher', description: 'guard', filePath: 'src/Dispatcher.Codeunit.al',
        }],
        testScenarios: [{
          name: 'Guard fires once', description: 'Post and send once.',
          expectedOutcome: 'One dispatch', derivedFrom: 'AC1',
        }],
        riskAssessment: { level: 'low', factors: [], mitigations: [] },
        estimatedComplexity: 'simple',
        dependencies: [],
      },
    },
    coding: {
      convergenceEscalation: {
        loop: 'coding',
        issueCounts: [5, 5, 5],
        recurringFindings: ['the guard is not self-healing'],
        question: 'Which findings are real?',
      },
    },
  };
  return { ...base, ...(extras[stage] as object) } as unknown as PipelineState;
}

describe('STAGE_COMMENTS', () => {
  test('every stage produces a comment for the state that triggers it', () => {
    for (const stage of Object.keys(STAGE_COMMENTS)) {
      expect(STAGE_COMMENTS[stage]!.fn(81098, stateFor(stage))).toBeTruthy();
    }
  });

  test('a formatter that emits markdown is declared markdown', () => {
    for (const [stage, entry] of Object.entries(STAGE_COMMENTS)) {
      const text = entry.fn(81098, stateFor(stage));
      if (text && usesMarkdownSyntax(text)) {
        expect(`${stage}=${entry.format}`).toBe(`${stage}=markdown`);
      }
    }
  });

  test('a formatter built from HTML tags is declared html', () => {
    for (const [stage, entry] of Object.entries(STAGE_COMMENTS)) {
      const text = entry.fn(81098, stateFor(stage));
      if (text && usesHtmlSyntax(text)) {
        expect(`${stage}=${entry.format}`).toBe(`${stage}=html`);
      }
    }
  });

  test('the dev plan really is markdown — the case that broke', () => {
    const text = STAGE_COMMENTS['planning']!.fn(81098, stateFor('planning'))!;
    expect(text).toStartWith('## ');
    expect(text).toContain('| --- |');
    expect(STAGE_COMMENTS['planning']!.format).toBe('markdown');
  });
});

// ---------------------------------------------------------------------------
// Convergence escalation comments, per loop
//
// The escalation formatter reads state.convergenceEscalation regardless of
// which loop set it. Each stage entry must therefore gate on the LOOP NAME:
// after a /rerun-plan from a convergence:coding pause, the coding escalation
// marker is still in state when planning completes — without the guard the
// planning entry would post the coding escalation instead of the dev plan.
// ---------------------------------------------------------------------------

describe('STAGE_COMMENTS — convergence escalation routing', () => {
  const escalation = (loop: string) => ({
    loop,
    issueCounts: [11, 11, 11],
    recurringFindings: ['the same objection three rounds running'],
    question: `Reply with the loop-appropriate command for ${loop}.`,
  });

  test('planning escalation posts the escalation, not the plan', () => {
    const s = { ...stateFor('planning'), convergenceEscalation: escalation('planning') } as any;
    const out = STAGE_COMMENTS['planning']!.fn(81493, s)!;
    expect(out).toContain('not converging');
    expect(out).not.toContain('Dev Plan');
  });

  test('a stale coding escalation does not hijack the planning comment', () => {
    const s = { ...stateFor('planning'), convergenceEscalation: escalation('coding') } as any;
    const out = STAGE_COMMENTS['planning']!.fn(81493, s)!;
    expect(out).toContain('Dev Plan');
    expect(out).not.toContain('not converging');
  });

  test('coding entry is symmetric: fires only for its own loop', () => {
    const stale = { ...stateFor('coding'), convergenceEscalation: escalation('planning') } as any;
    expect(STAGE_COMMENTS['coding']!.fn(81493, stale)).toBeNull();
    const own = { ...stateFor('coding'), convergenceEscalation: escalation('coding') } as any;
    expect(STAGE_COMMENTS['coding']!.fn(81493, own)).toContain('not converging');
  });
});
