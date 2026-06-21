import { describe, test, expect } from 'bun:test';
import {
  formatReadinessComment,
  formatPlanComment,
  formatChangesetSummary,
  formatErrorComment,
  formatTelemetrySummary,
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
  test('includes heading with work item id', () => {
    const html = formatPlanComment(66858, makeDevPlan());
    expect(html).toContain('<h2>🤖 Dev Plan — Work Item #66858</h2>');
  });

  test('includes plan summary', () => {
    const html = formatPlanComment(1, makeDevPlan());
    expect(html).toContain('Add caching codeunit for merge fields.');
  });

  test('objects table has four columns (no Description)', () => {
    const html = formatPlanComment(1, makeDevPlan());
    expect(html).toContain('<th>Action</th><th>Type</th><th>ID</th><th>Name</th>');
    // The table header should NOT include Description
    expect(html).not.toMatch(/<th>Description<\/th>/);
  });

  test('table shows create/modify with correct emojis', () => {
    const html = formatPlanComment(1, makeDevPlan());
    expect(html).toContain('<td>🆕 create</td>');
    expect(html).toContain('<td>✏️ modify</td>');
  });

  test('table shows object type, id, and name', () => {
    const html = formatPlanComment(1, makeDevPlan());
    expect(html).toContain('<td>codeunit</td>');
    expect(html).toContain('<td>6175370</td>');
    expect(html).toContain('<td>CDO Merge Field Cache</td>');
  });

  test('heading says "create/modify" when objects include creates', () => {
    const html = formatPlanComment(1, makeDevPlan());
    expect(html).toContain('Objects to create/modify');
  });

  test('heading says "modify" when only modifications', () => {
    const plan = makeDevPlan({
      objects: [
        { objectType: 'table', objectId: 18, objectName: 'Customer', action: 'modify', description: 'Add field', filePath: 'x.al' },
      ],
    });
    const html = formatPlanComment(1, plan);
    expect(html).toContain('Objects to modify');
    expect(html).not.toContain('create/modify');
  });

  test('per-object detail sections appear after the table', () => {
    const html = formatPlanComment(1, makeDevPlan());
    const tableEnd = html.indexOf('</table>');
    const detailSection = html.indexOf('<h4>🆕 CDO Merge Field Cache (codeunit 6175370)</h4>');
    expect(tableEnd).toBeGreaterThan(-1);
    expect(detailSection).toBeGreaterThan(tableEnd);
  });

  test('detail sections include description text', () => {
    const html = formatPlanComment(1, makeDevPlan());
    expect(html).toContain('<p>New SingleInstance caching codeunit.</p>');
    expect(html).toContain('<p>Modify GetValue() to use cache.</p>');
  });

  test('detail sections use correct emoji per action', () => {
    const html = formatPlanComment(1, makeDevPlan());
    expect(html).toContain('<h4>🆕 CDO Merge Field Cache');
    expect(html).toContain('<h4>✏️ CDO E-Mail Template MergeField');
  });

  test('shows (new) for objects without an id', () => {
    const plan = makeDevPlan({
      objects: [
        { objectType: 'codeunit', objectName: 'New CU', action: 'create', description: 'Desc', filePath: 'x.al' },
      ],
    });
    const html = formatPlanComment(1, plan);
    expect(html).toContain('<td>(new)</td>');
    expect(html).toContain('(codeunit (new))');
  });

  test('includes risk assessment', () => {
    const html = formatPlanComment(1, makeDevPlan());
    expect(html).toContain('<h3>Risk Assessment: medium</h3>');
    expect(html).toContain('<li>Shared table change</li>');
  });

  test('includes test scenarios as ordered list', () => {
    const html = formatPlanComment(1, makeDevPlan());
    expect(html).toContain('<h3>Test Scenarios</h3>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<b>Cache hit returns same value</b>');
  });

  test('includes complexity', () => {
    const html = formatPlanComment(1, makeDevPlan());
    expect(html).toContain('<b>Complexity:</b> moderate');
  });

  test('includes approval instructions', () => {
    const html = formatPlanComment(1, makeDevPlan());
    expect(html).toContain('<code>plan-approved</code>');
    expect(html).toContain('<code>/rerun-plan</code>');
  });

  test('converts numbered lists in object descriptions to ordered lists', () => {
    const plan = makeDevPlan({
      objects: [
        {
          objectType: 'codeunit', objectId: 99, objectName: 'Test CU', action: 'create',
          description: 'Test codeunit.\n\nTest methods:\n1. First test\n2. Second test\n3. Third test',
          filePath: 'x.al',
        },
      ],
    });
    const html = formatPlanComment(1, plan);
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>First test</li>');
    expect(html).toContain('<li>Second test</li>');
    expect(html).toContain('<li>Third test</li>');
    expect(html).toContain('</ol>');
  });

  test('HTML-escapes object names and descriptions', () => {
    const plan = makeDevPlan({
      objects: [
        { objectType: 'codeunit', objectId: 1, objectName: 'CU <Test>', action: 'create', description: 'Handles "quotes" & <tags>', filePath: 'x.al' },
      ],
    });
    const html = formatPlanComment(1, plan);
    expect(html).toContain('CU &lt;Test&gt;');
    expect(html).toContain('Handles &quot;quotes&quot; &amp; &lt;tags&gt;');
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
