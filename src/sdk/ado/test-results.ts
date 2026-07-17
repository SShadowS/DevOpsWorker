import type { PipelineConfig, TestCaseFailure, TestCaseFailureStep } from '../../types/pipeline.types.ts';
import { adoFetch, AzureDevOpsError } from './http.ts';

// ---------------------------------------------------------------------------
// Test case failure resolution
// ---------------------------------------------------------------------------

interface AzureDevOpsWorkItemWithRelationsResponse {
  id: number;
  fields: Record<string, unknown>;
  relations?: Array<{
    rel: string;
    url: string;
    attributes?: Record<string, unknown>;
  }>;
}

async function fetchWorkItemWithRelations(
  workItemId: number,
  config: PipelineConfig,
): Promise<AzureDevOpsWorkItemWithRelationsResponse> {
  return adoFetch<AzureDevOpsWorkItemWithRelationsResponse>(
    config.azureDevOps,
    `wit/workitems/${workItemId}?$expand=all&api-version=7.0`,
  );
}

function workItemIdFromUrl(url: string): number {
  const match = url.match(/\/workItems\/(\d+)$/i);
  if (!match) throw new AzureDevOpsError(`Cannot parse work item ID from URL: ${url}`);
  return parseInt(match[1]!, 10);
}

function parseStepsXml(
  stepsXml: string,
): Array<{ stepId: number; action: string; expectedResult: string }> {
  const steps: Array<{ stepId: number; action: string; expectedResult: string }> = [];

  const stepRegex = /<step\s[^>]*id="(\d+)"[^>]*>([\s\S]*?)<\/step>/gi;
  let stepMatch: RegExpExecArray | null;
  while ((stepMatch = stepRegex.exec(stepsXml)) !== null) {
    const stepId = parseInt(stepMatch[1]!, 10);
    const stepContent = stepMatch[2]!;

    const paramRegex = /<parameterizedString[^>]*>([\s\S]*?)<\/parameterizedString>/gi;
    const params: string[] = [];
    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = paramRegex.exec(stepContent)) !== null) {
      params.push(paramMatch[1]!);
    }

    const cleanText = (html: string): string =>
      html
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .trim();

    steps.push({
      stepId,
      action: cleanText(params[0] ?? ''),
      expectedResult: cleanText(params[1] ?? ''),
    });
  }

  return steps;
}

interface TestResultQueryResponse {
  resultsForGroup?: Array<{
    results?: Array<{
      id: number;
      outcome: string;
      testRun: { id: string };
    }>;
  }>;
}

async function queryLatestTestResult(
  testCaseId: number,
  config: PipelineConfig,
): Promise<{ resultId: number; runId: number; outcome: string } | null> {
  const response = await adoFetch<TestResultQueryResponse>(
    config.azureDevOps,
    'test/runs/results?api-version=7.0',
    {
      method: 'POST',
      body: JSON.stringify({
        resultsFilter: { automatedTestName: '', testCaseId, resultsCount: 1 },
      }),
    },
  );

  const result = response.resultsForGroup?.[0]?.results?.[0];
  if (!result) return null;

  return {
    resultId: result.id,
    runId: parseInt(result.testRun.id, 10),
    outcome: result.outcome,
  };
}

interface TestIterationActionResult {
  stepIdentifier?: string;
  actionPath?: string;
  outcome: string;
  errorMessage?: string;
}

interface TestIteration {
  actionResults?: TestIterationActionResult[];
  comment?: string;
}

interface TestIterationsResponse {
  value?: TestIteration[];
}

async function fetchTestIterations(
  runId: number,
  resultId: number,
  config: PipelineConfig,
): Promise<Array<{ stepIdentifier?: string; actionPath?: string; outcome: string; errorMessage?: string }>> {
  const response = await adoFetch<TestIterationsResponse>(
    config.azureDevOps,
    `test/runs/${runId}/results/${resultId}/iterations?includeActionResults=true&api-version=7.0`,
  );

  const iterations = response.value ?? [];
  if (iterations.length === 0) return [];

  // Use last iteration
  const last = iterations[iterations.length - 1]!;
  const actionResults = last.actionResults ?? [];

  // Fall back to iteration comment for non-Passed steps without errorMessage
  return actionResults.map(ar => ({
    stepIdentifier: ar.stepIdentifier,
    actionPath: ar.actionPath,
    outcome: ar.outcome,
    errorMessage: ar.errorMessage ?? (ar.outcome !== 'Passed' ? last.comment ?? undefined : undefined),
  }));
}

/**
 * Resolve test case failures for a work item.
 * Follows: parent WI → TestedBy relations → test case WIs → test results → failed steps.
 */
export async function fetchTestCaseFailures(
  workItemId: number,
  config: PipelineConfig,
): Promise<TestCaseFailure[]> {
  const parentWi = await fetchWorkItemWithRelations(workItemId, config);

  const testedByRelations = (parentWi.relations ?? []).filter(
    r => r.rel === 'Microsoft.VSTS.Common.TestedBy-Forward',
  );

  if (testedByRelations.length === 0) return [];

  const failures: TestCaseFailure[] = [];

  for (const relation of testedByRelations) {
    const testCaseId = workItemIdFromUrl(relation.url);

    // Fetch test case work item for title + steps XML
    const testCaseWi = await fetchWorkItemWithRelations(testCaseId, config);
    const title = (testCaseWi.fields['System.Title'] as string) ?? '';
    const stepsXml = (testCaseWi.fields['Microsoft.VSTS.TCM.Steps'] as string) ?? '';

    // Query latest test result
    const latestResult = await queryLatestTestResult(testCaseId, config);
    if (!latestResult) continue;
    if (latestResult.outcome === 'Passed') continue;

    // Fetch iterations
    const actionResults = await fetchTestIterations(latestResult.runId, latestResult.resultId, config);

    // Parse steps XML
    const steps = parseStepsXml(stepsXml);
    const stepsById = new Map(steps.map(s => [s.stepId, s]));

    // Merge: only include Failed steps
    const failedSteps: TestCaseFailureStep[] = [];
    for (const ar of actionResults) {
      if (ar.outcome !== 'Failed') continue;

      // Resolve step ID from stepIdentifier (decimal) or actionPath (hex)
      let stepId: number | null = null;
      if (ar.stepIdentifier !== undefined && ar.stepIdentifier !== '') {
        stepId = parseInt(ar.stepIdentifier, 10);
      } else if (ar.actionPath !== undefined && ar.actionPath !== '') {
        stepId = parseInt(ar.actionPath, 16);
      }

      if (stepId === null) continue;

      const step = stepsById.get(stepId);
      if (!step) continue;

      failedSteps.push({
        stepNumber: stepId,
        action: step.action,
        expectedResult: step.expectedResult,
        comment: ar.errorMessage ?? null,
      });
    }

    if (failedSteps.length > 0) {
      failures.push({
        testCaseId,
        title,
        outcome: latestResult.outcome,
        failedSteps,
      });
    }
  }

  return failures;
}
