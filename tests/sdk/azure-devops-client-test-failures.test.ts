import { describe, test, expect, afterEach, mock } from 'bun:test';
import { fetchTestCaseFailures } from '../../src/sdk/azure-devops-client.ts';
import type { PipelineConfig } from '../../src/types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testConfig(): PipelineConfig {
  return {
    azureDevOps: {
      organization: 'test-org',
      orgUrl: 'https://dev.azure.com/test-org',
      project: 'Test Project',
      repositoryId: 'repo-id',
      repositoryName: 'Test Repo',
      ciPipelineId: 1,
      cdPipelineId: 2,
      areaPath: 'Test',
      iterationPath: 'Test',
      pat: 'test-pat',
    },
    paths: { sessionRoot: '/tmp', targetRepo: '/tmp/doc', stateDir: '/tmp/state' },
    checkpoints: {
      planApproval: { tag: 'plan-approved', rerunCommand: '/rerun-plan', timeoutHours: 1 },
      prPublished: { fixCommand: '/fix', timeoutHours: 1 },
      pollIntervalMinutes: 1,
    },
    revisionLoops: { maxAttempts: 3 },
    models: { default: 'test' },
    costs: {},
    repoKey: 'DocumentOutput',
    layout: { appRoot: 'Cloud', source: 'Cloud/AL', testAppRoot: 'Test', test: 'Test/AL' },
  } as PipelineConfig;
}

const originalFetch = globalThis.fetch;
let callIndex = 0;
let responses: unknown[] = [];

function setSequentialResponses(...bodies: unknown[]) {
  callIndex = 0;
  responses = bodies;
  globalThis.fetch = mock(() => {
    const body = responses[callIndex] ?? {};
    callIndex++;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        statusText: 'OK',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Test data builders
// ---------------------------------------------------------------------------

function parentWorkItemWithTestedBy(testCaseId: number) {
  return {
    id: 1001,
    fields: {
      'System.Title': 'Parent Work Item',
      'System.WorkItemType': 'Bug',
      'System.State': 'Active',
    },
    relations: [
      {
        rel: 'Microsoft.VSTS.Common.TestedBy-Forward',
        url: `https://dev.azure.com/test-org/Test%20Project/_apis/wit/workItems/${testCaseId}`,
        attributes: {},
      },
    ],
  };
}

function testCaseWorkItem(testCaseId: number, title: string, stepsXml: string) {
  return {
    id: testCaseId,
    fields: {
      'System.Title': title,
      'System.WorkItemType': 'Test Case',
      'System.State': 'Active',
      'Microsoft.VSTS.TCM.Steps': stepsXml,
    },
    relations: [],
  };
}

function testResultsResponse(resultId: number, runId: number, outcome: string) {
  return {
    resultsForGroup: [
      {
        results: [
          {
            id: resultId,
            outcome,
            testRun: { id: String(runId) },
          },
        ],
      },
    ],
  };
}

function emptyTestResultsResponse() {
  return { resultsForGroup: [{ results: [] }] };
}

function testIterationsResponse(
  actionResults: Array<{
    stepIdentifier?: string;
    actionPath?: string;
    outcome: string;
    errorMessage?: string;
  }>,
  comment?: string,
) {
  return {
    value: [
      {
        actionResults,
        comment,
      },
    ],
  };
}

const SIMPLE_STEPS_XML = `
<steps>
  <step id="1" type="ValidateStep">
    <parameterizedString>Navigate to the sales order page</parameterizedString>
    <parameterizedString>Sales order page is displayed</parameterizedString>
  </step>
  <step id="2" type="ValidateStep">
    <parameterizedString>Click Post button</parameterizedString>
    <parameterizedString>Order is posted successfully</parameterizedString>
  </step>
  <step id="3" type="ValidateStep">
    <parameterizedString>Verify the posted invoice</parameterizedString>
    <parameterizedString>Invoice number is shown</parameterizedString>
  </step>
</steps>
`.trim();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetchTestCaseFailures', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns empty array when work item has no TestedBy relations', async () => {
    setSequentialResponses({
      id: 1001,
      fields: { 'System.Title': 'Parent WI', 'System.WorkItemType': 'Bug', 'System.State': 'Active' },
      relations: [],
    });

    const result = await fetchTestCaseFailures(1001, testConfig());
    expect(result).toEqual([]);
  });

  test('returns failures for test cases with failed steps', async () => {
    const stepsXml = SIMPLE_STEPS_XML;

    setSequentialResponses(
      // 1. Parent WI with TestedBy relation → test case ID 5001
      parentWorkItemWithTestedBy(5001),
      // 2. Test case WI (title + steps XML)
      testCaseWorkItem(5001, 'Verify Sales Order Posting', stepsXml),
      // 3. Latest test result query → Failed
      testResultsResponse(9001, 42, 'Failed'),
      // 4. Iterations with failed step 2
      testIterationsResponse([
        { stepIdentifier: '1', outcome: 'Passed' },
        { stepIdentifier: '2', outcome: 'Failed', errorMessage: 'Button not found' },
        { stepIdentifier: '3', outcome: 'Failed', errorMessage: 'Invoice not found' },
      ]),
    );

    const result = await fetchTestCaseFailures(1001, testConfig());

    expect(result).toHaveLength(1);
    const failure = result[0]!;
    expect(failure.testCaseId).toBe(5001);
    expect(failure.title).toBe('Verify Sales Order Posting');
    expect(failure.outcome).toBe('Failed');
    expect(failure.failedSteps).toHaveLength(2);

    const step2 = failure.failedSteps[0]!;
    expect(step2.stepNumber).toBe(2);
    expect(step2.action).toBe('Click Post button');
    expect(step2.expectedResult).toBe('Order is posted successfully');
    expect(step2.comment).toBe('Button not found');

    const step3 = failure.failedSteps[1]!;
    expect(step3.stepNumber).toBe(3);
    expect(step3.action).toBe('Verify the posted invoice');
    expect(step3.expectedResult).toBe('Invoice number is shown');
    expect(step3.comment).toBe('Invoice not found');
  });

  test('skips test cases with no test run results', async () => {
    setSequentialResponses(
      // 1. Parent WI with TestedBy relation
      parentWorkItemWithTestedBy(5002),
      // 2. Test case WI
      testCaseWorkItem(5002, 'Empty Results Test', SIMPLE_STEPS_XML),
      // 3. Latest test result query → empty
      emptyTestResultsResponse(),
    );

    const result = await fetchTestCaseFailures(1001, testConfig());
    expect(result).toEqual([]);
  });

  test('skips test cases whose latest run outcome is Passed', async () => {
    setSequentialResponses(
      // 1. Parent WI with TestedBy relation
      parentWorkItemWithTestedBy(5003),
      // 2. Test case WI
      testCaseWorkItem(5003, 'Passing Test', SIMPLE_STEPS_XML),
      // 3. Latest test result query → Passed
      testResultsResponse(9002, 43, 'Passed'),
    );

    const result = await fetchTestCaseFailures(1001, testConfig());
    expect(result).toEqual([]);
  });

  test('handles hex actionPath for step ID matching', async () => {
    // step id="3" in XML, actionPath '3' parsed as hex = 3
    const stepsXml = `
<steps>
  <step id="3" type="ValidateStep">
    <parameterizedString>Verify totals</parameterizedString>
    <parameterizedString>Totals are correct</parameterizedString>
  </step>
</steps>
    `.trim();

    setSequentialResponses(
      // 1. Parent WI
      parentWorkItemWithTestedBy(5004),
      // 2. Test case WI
      testCaseWorkItem(5004, 'Hex Path Test', stepsXml),
      // 3. Latest test result → Failed
      testResultsResponse(9003, 44, 'Failed'),
      // 4. Iterations with actionPath (hex) instead of stepIdentifier
      testIterationsResponse([
        { actionPath: '3', outcome: 'Failed', errorMessage: 'Total mismatch' },
      ]),
    );

    const result = await fetchTestCaseFailures(1001, testConfig());

    expect(result).toHaveLength(1);
    const failure = result[0]!;
    expect(failure.testCaseId).toBe(5004);
    expect(failure.failedSteps).toHaveLength(1);

    const step = failure.failedSteps[0]!;
    expect(step.stepNumber).toBe(3);
    expect(step.action).toBe('Verify totals');
    expect(step.expectedResult).toBe('Totals are correct');
    expect(step.comment).toBe('Total mismatch');
  });
});
