import { describe, test, expect } from 'bun:test';
import {
  formatReadinessComment,
  formatPlanComment,
  formatChangesetSummary,
  formatErrorComment,
  formatTelemetrySummary,
  isPipelineComment,
} from '../../src/formatters/devops-comment.ts';
import { TransientAgentError } from '../../src/sdk/errors.ts';
import type { ReadinessReport } from '../../src/agents/analyzer/schema.ts';
import type { DevPlan } from '../../src/agents/planner/schema.ts';
import type { Changeset } from '../../src/agents/coder/schema.ts';
import type { TelemetryData } from '../../src/types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeReadinessReport(overrides?: Partial<ReadinessReport>): ReadinessReport {
  return {
    verdict: 'proceed',
    summary: 'Work item is ready for development.',
    gaps: [],
    enrichedContext: {
      title: 'Fix posting error',
      type: 'Bug',
      description: 'Posting fails on credit memos',
      acceptanceCriteria: 'Credit memos post without error',
      targetArea: 'Sales',
      relatedWorkItems: [],
      codebaseInsights: [],
    },
    ...overrides,
  };
}

function makeDevPlan(overrides?: Partial<DevPlan>): DevPlan {
  return {
    summary: 'Add caching codeunit for merge fields.',
    objects: [
      {
        objectType: 'codeunit',
        objectId: 6175370,
        objectName: 'CDO Merge Field Cache',
        action: 'create',
        description: 'New SingleInstance caching codeunit.',
        filePath: 'Cloud/AL/Codeunit/CDOMergeFieldCache.Codeunit.al',
      },
      {
        objectType: 'table',
        objectId: 6175275,
        objectName: 'CDO E-Mail Template MergeField',
        action: 'modify',
        description: 'Modify GetValue() to use cache.',
        filePath: 'Cloud/AL/Table/CDOEMailTemplateMergeField.Table.al',
      },
    ],
    testScenarios: [
      {
        name: 'Cache hit returns same value',
        description: 'Second call returns cached value.',
        expectedOutcome: 'Cached value matches first call.',
        derivedFrom: 'AC-1',
      },
    ],
    riskAssessment: { level: 'medium', factors: ['Shared table change'], mitigations: ['Add tests'] },
    estimatedComplexity: 'moderate',
    dependencies: [],
    ...overrides,
  };
}

function makeChangeset(overrides?: Partial<Changeset>): Changeset {
  return {
    branchName: 'bug/#66858-merge-field-cache',
    branchUrl: 'https://dev.azure.com/org/project/_git/repo?version=GBbug/%2366858',
    filesCreated: ['Cloud/AL/Codeunit/CDOMergeFieldCache.Codeunit.al'],
    filesModified: ['Cloud/AL/Table/CDOEMailTemplateMergeField.Table.al'],
    commitHash: 'abc1234',
    commitMessage: 'fix: add merge field cache (#66858)',
    ciRunId: 973,
    ciResult: 'passed',
    summary: 'Implemented merge field caching.',
  };
}

function makeTelemetry(overrides?: Partial<TelemetryData>): TelemetryData {
  return {
    totalCostUsd: 0.25,
    totalDurationMs: 45000,
    stages: [
      { name: 'analyzer', costUsd: 0.05, durationMs: 10000, turns: 5, model: 'opus', timestamp: '2026-01-01T00:00:00Z' },
      { name: 'planning', costUsd: 0.20, durationMs: 35000, turns: 12, model: 'opus', timestamp: '2026-01-01T00:01:00Z' },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// formatReadinessComment
// ---------------------------------------------------------------------------

describe('formatReadinessComment', () => {
  test('includes heading with work item id and proceed icon', () => {
    const html = formatReadinessComment(42, makeReadinessReport());
    expect(html).toContain('<h2>✅ Readiness Assessment — Work Item #42</h2>');
  });

  test('uses reject icon when verdict is reject', () => {
    const html = formatReadinessComment(42, makeReadinessReport({ verdict: 'reject' }));
    expect(html).toContain('<h2>❌ Readiness Assessment');
  });

  test('includes verdict and summary', () => {
    const html = formatReadinessComment(1, makeReadinessReport());
    expect(html).toContain('<b>Verdict:</b> proceed');
    expect(html).toContain('Work item is ready for development.');
  });

  test('renders gaps table when gaps exist', () => {
    const report = makeReadinessReport({
      gaps: [
        { field: 'Acceptance Criteria', severity: 'blocking', question: 'What is expected?', resolvedByAgent: false },
      ],
    });
    const html = formatReadinessComment(1, report);
    expect(html).toContain('<h3>Gaps Found</h3>');
    expect(html).toContain('<th>Field</th>');
    expect(html).toContain('<b>Acceptance Criteria</b>');
    expect(html).toContain('⚠️ Needs input');
    expect(html).toContain('What is expected?');
    expect(html).toContain('<td>-</td>');
  });

  test('shows resolved status and resolution text for resolved gaps', () => {
    const report = makeReadinessReport({
      gaps: [
        { field: 'Scope', severity: 'needs-clarification', question: 'Which module?', resolvedByAgent: true, resolution: 'Found in Sales module' },
      ],
    });
    const html = formatReadinessComment(1, report);
    expect(html).toContain('✅ Resolved');
    expect(html).toContain('Found in Sales module');
  });

  test('omits gaps section when no gaps', () => {
    const html = formatReadinessComment(1, makeReadinessReport({ gaps: [] }));
    expect(html).not.toContain('Gaps Found');
  });

  test('renders codebase insights when present', () => {
    const report = makeReadinessReport({
      enrichedContext: {
        ...makeReadinessReport().enrichedContext,
        codebaseInsights: ['Table 18 has 500+ fields', 'Existing cache in CU 80'],
      },
    });
    const html = formatReadinessComment(1, report);
    expect(html).toContain('<h3>Codebase Insights</h3>');
    expect(html).toContain('<li>Table 18 has 500+ fields</li>');
    expect(html).toContain('<li>Existing cache in CU 80</li>');
  });

  test('omits codebase insights when empty', () => {
    const html = formatReadinessComment(1, makeReadinessReport());
    expect(html).not.toContain('Codebase Insights');
  });

  test('HTML-escapes special characters', () => {
    const report = makeReadinessReport({ summary: 'Fix <script>alert("xss")</script>' });
    const html = formatReadinessComment(1, report);
    expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  test('includes footer', () => {
    const html = formatReadinessComment(1, makeReadinessReport());
    expect(html).toContain('<hr><em>Generated by DevOps Pipeline</em>');
  });
});

// ---------------------------------------------------------------------------
// formatPlanComment
// ---------------------------------------------------------------------------

describe('formatPlanComment', () => {
  test('includes markdown heading with work item id', () => {
    const md = formatPlanComment(66858, makeDevPlan());
    expect(md).toContain('## 🤖 Dev Plan — Work Item #66858');
  });

  test('includes plan summary', () => {
    const md = formatPlanComment(1, makeDevPlan());
    expect(md).toContain('Add caching codeunit for merge fields.');
  });

  test('objects markdown table has four columns (no Description)', () => {
    const md = formatPlanComment(1, makeDevPlan());
    expect(md).toContain('| Action | Type | ID | Name |');
    expect(md).not.toContain('Description |');
  });

  test('table shows create/modify with correct emojis', () => {
    const md = formatPlanComment(1, makeDevPlan());
    expect(md).toContain('| 🆕 create | codeunit | 6175370 | CDO Merge Field Cache |');
    expect(md).toContain('| ✏️ modify |');
  });

  test('heading says "create/modify" when objects include creates', () => {
    const md = formatPlanComment(1, makeDevPlan());
    expect(md).toContain('Objects to create/modify');
  });

  test('heading says "modify" when only modifications', () => {
    const plan = makeDevPlan({
      objects: [
        { objectType: 'table', objectId: 18, objectName: 'Customer', action: 'modify', description: 'Add field', filePath: 'x.al' },
      ],
    });
    const md = formatPlanComment(1, plan);
    expect(md).toContain('Objects to modify');
    expect(md).not.toContain('create/modify');
  });

  test('per-object detail collapsibles appear after the table', () => {
    const md = formatPlanComment(1, makeDevPlan());
    const tableEnd = md.indexOf('### Object details');
    const detailSection = md.indexOf('<summary><b>CDO Merge Field Cache</b> — 🆕 codeunit 6175370</summary>');
    expect(tableEnd).toBeGreaterThan(-1);
    expect(detailSection).toBeGreaterThan(tableEnd);
  });

  test('detail collapsibles include description text', () => {
    const md = formatPlanComment(1, makeDevPlan());
    expect(md).toContain('New SingleInstance caching codeunit.');
    expect(md).toContain('Modify GetValue() to use cache.');
    expect(md).toContain('<details>');
  });

  test('detail summaries use correct emoji per action', () => {
    const md = formatPlanComment(1, makeDevPlan());
    expect(md).toContain('<b>CDO Merge Field Cache</b> — 🆕 codeunit');
    expect(md).toContain('<b>CDO E-Mail Template MergeField</b> — ✏️');
  });

  test('shows (new) for objects without an id', () => {
    const plan = makeDevPlan({
      objects: [
        { objectType: 'codeunit', objectName: 'New CU', action: 'create', description: 'Desc', filePath: 'x.al' },
      ],
    });
    const md = formatPlanComment(1, plan);
    expect(md).toContain('| 🆕 create | codeunit | (new) | New CU |');
    expect(md).toContain('<b>New CU</b> — 🆕 codeunit (new)');
  });

  test('includes risk assessment', () => {
    const md = formatPlanComment(1, makeDevPlan());
    expect(md).toContain('### Risk: medium');
    expect(md).toContain('- Shared table change');
  });

  test('includes test scenarios as a numbered list', () => {
    const md = formatPlanComment(1, makeDevPlan());
    expect(md).toContain('Test Scenarios');
    expect(md).toContain('1. **Cache hit returns same value**');
  });

  test('includes complexity', () => {
    const md = formatPlanComment(1, makeDevPlan());
    expect(md).toContain('**Complexity:** moderate');
  });

  test('includes approval instructions + pipeline signature', () => {
    const md = formatPlanComment(1, makeDevPlan());
    expect(md).toContain('`plan-approved`');
    expect(md).toContain('`/rerun-plan`');
    expect(md).toContain('Generated by DevOps Pipeline');
  });

  test('object descriptions pass through verbatim (markdown renders lists natively)', () => {
    const plan = makeDevPlan({
      objects: [
        {
          objectType: 'codeunit', objectId: 99, objectName: 'Test CU', action: 'create',
          description: 'Test codeunit.\n\nTest methods:\n1. First test\n2. Second test\n3. Third test',
          filePath: 'x.al',
        },
      ],
    });
    const md = formatPlanComment(1, plan);
    expect(md).toContain('1. First test');
    expect(md).toContain('2. Second test');
    expect(md).toContain('3. Third test');
  });

  test('HTML-escapes object names in the <summary> (HTML inside markdown)', () => {
    const plan = makeDevPlan({
      objects: [
        { objectType: 'codeunit', objectId: 1, objectName: 'CU <Test>', action: 'create', description: 'Handles tags', filePath: 'x.al' },
      ],
    });
    const md = formatPlanComment(1, plan);
    expect(md).toContain('<b>CU &lt;Test&gt;</b>');
  });
});

// ---------------------------------------------------------------------------
// formatChangesetSummary
// ---------------------------------------------------------------------------

describe('formatChangesetSummary', () => {
  test('includes branch name', () => {
    const md = formatChangesetSummary(makeChangeset());
    expect(md).toContain('`bug/#66858-merge-field-cache`');
  });

  test('lists created files', () => {
    const md = formatChangesetSummary(makeChangeset());
    expect(md).toContain('**Files created:**');
    expect(md).toContain('- `Cloud/AL/Codeunit/CDOMergeFieldCache.Codeunit.al`');
  });

  test('lists modified files', () => {
    const md = formatChangesetSummary(makeChangeset());
    expect(md).toContain('**Files modified:**');
    expect(md).toContain('- `Cloud/AL/Table/CDOEMailTemplateMergeField.Table.al`');
  });

  test('omits created section when no files created', () => {
    const cs = { ...makeChangeset(), filesCreated: [] as string[] };
    const md = formatChangesetSummary(cs);
    expect(md).not.toContain('Files created');
  });

  test('omits modified section when no files modified', () => {
    const cs = { ...makeChangeset(), filesModified: [] as string[] };
    const md = formatChangesetSummary(cs);
    expect(md).not.toContain('Files modified');
  });

  test('shows passed CI status with run id', () => {
    const md = formatChangesetSummary(makeChangeset());
    expect(md).toContain('**CI Pipeline:** ✅ Passed (Run #973)');
  });

  test('shows failed CI status', () => {
    const cs = { ...makeChangeset(), ciResult: 'failed' as const, ciRunId: 100 };
    const md = formatChangesetSummary(cs);
    expect(md).toContain('**CI Pipeline:** ❌ Failed (Run #100)');
  });

  test('shows not-run CI status without run id', () => {
    const cs = { ...makeChangeset(), ciResult: 'not-run' as const, ciRunId: undefined };
    const md = formatChangesetSummary(cs);
    expect(md).toContain('**CI Pipeline:** ⏸️ Not run');
    expect(md).not.toContain('Run #');
  });

  test('shows not-run when ciResult is undefined', () => {
    const cs = { ...makeChangeset(), ciResult: undefined, ciRunId: undefined };
    const md = formatChangesetSummary(cs);
    expect(md).toContain('⏸️ Not run');
  });

  test('shows CI status as clickable link when ciRunUrl is provided', () => {
    const md = formatChangesetSummary(makeChangeset(), 'https://dev.azure.com/org/proj/_build/results?buildId=973');
    expect(md).toContain('**CI Pipeline:** [✅ Passed](https://dev.azure.com/org/proj/_build/results?buildId=973)');
  });

  test('falls back to plain text when ciRunUrl is not provided', () => {
    const md = formatChangesetSummary(makeChangeset());
    expect(md).toContain('**CI Pipeline:** ✅ Passed (Run #973)');
  });
});

// ---------------------------------------------------------------------------
// formatErrorComment
// ---------------------------------------------------------------------------

describe('formatErrorComment', () => {
  test('shows dashboard continue as first recovery option', () => {
    const html = formatErrorComment(42, 'coder', new Error('Process crashed'));
    expect(html).toContain('<h2>🚨 Pipeline Error — Work Item #42</h2>');
    expect(html).toContain('<code>coder</code>');
    expect(html).toContain('Process crashed');
    const dashboardIdx = html.indexOf('dashboard');
    const cliIdx = html.indexOf('CLI resume');
    const analyseIdx = html.indexOf('analyse');
    expect(dashboardIdx).toBeGreaterThan(-1);
    expect(cliIdx).toBeGreaterThan(dashboardIdx);
    expect(analyseIdx).toBeGreaterThan(cliIdx);
  });

  test('shows CLI continue command with work item ID', () => {
    const html = formatErrorComment(99, 'planner', new Error('Timeout'));
    expect(html).toContain('bun run pipeline -- continue --work-item 99');
  });

  test('shows analyse as last resort', () => {
    const html = formatErrorComment(1, 'analyzer', new Error('Oops'));
    expect(html).toContain('last resort');
    expect(html).toContain('<code>analyse</code>');
  });

  test('shows retry count for TransientAgentError', () => {
    const inner = new Error('Connection dropped');
    const err = new TransientAgentError('coder', 3, inner);
    const html = formatErrorComment(42, 'coder', err);
    expect(html).toContain('<b>Retry attempts:</b> 3');
  });

  test('does not show retry count for non-TransientAgentError', () => {
    const html = formatErrorComment(42, 'coder', new Error('Bug'));
    expect(html).not.toContain('Retry attempts');
  });

  test('HTML-escapes error message', () => {
    const html = formatErrorComment(1, 'test', new Error('<script>alert("xss")</script>'));
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  test('converts markdown bullet list in error message to HTML list', () => {
    const msg = 'Analyzer needs human input before proceeding:\n\n- **Acceptance Criteria**: What are the testable criteria?\n- **Scope**: Which document types are in scope?';
    const html = formatErrorComment(1, 'analyzer', new Error(msg));
    expect(html).toContain('<ul>');
    expect(html).toContain('<li><b>Acceptance Criteria</b>: What are the testable criteria?</li>');
    expect(html).toContain('<li><b>Scope</b>: Which document types are in scope?</li>');
    expect(html).toContain('</ul>');
  });

  test('preserves paragraph structure in multi-line error messages', () => {
    const msg = 'Something went wrong.\n\nDetails follow here.';
    const html = formatErrorComment(1, 'test', new Error(msg));
    expect(html).toContain('<p>Something went wrong.</p>');
    expect(html).toContain('<p>Details follow here.</p>');
  });

  test('converts numbered list in error message to HTML ordered list', () => {
    const msg = 'Steps to fix:\n\n1. Check the config\n2. Restart the service\n3. Verify the output';
    const html = formatErrorComment(1, 'test', new Error(msg));
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>Check the config</li>');
    expect(html).toContain('<li>Restart the service</li>');
    expect(html).toContain('<li>Verify the output</li>');
    expect(html).toContain('</ol>');
  });
});

// ---------------------------------------------------------------------------
// isPipelineComment — moved here from the ADO transport client (task 11):
// the signatures encode what THIS module's formatters emit, so detecting
// them belongs here, not in the HTTP layer.
// ---------------------------------------------------------------------------

describe('isPipelineComment', () => {
  test('is importable from formatters (not the ADO transport client)', () => {
    expect(typeof isPipelineComment).toBe('function');
  });

  test('recognizes output produced by formatReadinessComment', () => {
    const html = formatReadinessComment(1, makeReadinessReport());
    expect(isPipelineComment(html)).toBe(true);
  });

  test('recognizes output produced by formatPlanComment', () => {
    const md = formatPlanComment(1, makeDevPlan());
    expect(isPipelineComment(md)).toBe(true);
  });

  test('recognizes output produced by formatErrorComment', () => {
    const html = formatErrorComment(1, 'coder', new Error('boom'));
    expect(isPipelineComment(html)).toBe(true);
  });

  test('does not flag ordinary human comments', () => {
    expect(isPipelineComment('This looks good, but use pattern X')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatTelemetrySummary
// ---------------------------------------------------------------------------

describe('formatTelemetrySummary', () => {
  test('includes total cost and duration', () => {
    const out = formatTelemetrySummary(makeTelemetry());
    expect(out).toContain('$0.2500');
    expect(out).toContain('45.0s');
  });

  test('includes column headers', () => {
    const out = formatTelemetrySummary(makeTelemetry());
    expect(out).toContain('Stage');
    expect(out).toContain('Cost');
    expect(out).toContain('Duration');
    expect(out).toContain('Turns');
  });

  test('includes per-stage rows', () => {
    const out = formatTelemetrySummary(makeTelemetry());
    expect(out).toContain('analyzer');
    expect(out).toContain('$0.0500');
    expect(out).toContain('10.0s');
    expect(out).toContain('planning');
    expect(out).toContain('$0.2000');
    expect(out).toContain('35.0s');
  });

  test('handles zero-cost stages', () => {
    const telemetry = makeTelemetry({
      totalCostUsd: 0,
      totalDurationMs: 0,
      stages: [{ name: 'noop', costUsd: 0, durationMs: 0, turns: 0, model: 'haiku', timestamp: '' }],
    });
    const out = formatTelemetrySummary(telemetry);
    expect(out).toContain('$0.0000');
    expect(out).toContain('0.0s');
  });
});
