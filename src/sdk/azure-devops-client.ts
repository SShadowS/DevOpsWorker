import type { PipelineConfig, WorkItem, TestCaseFailure, TestCaseFailureStep } from '../types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// Azure DevOps-specific error (not a PipelineError — the orchestrator wraps
// any thrown Error into the state error object with the correct stage name)
// ---------------------------------------------------------------------------

export class AzureDevOpsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AzureDevOpsError';
  }
}

// ---------------------------------------------------------------------------
// Azure DevOps REST client
// ---------------------------------------------------------------------------

// Private response types

interface AzureDevOpsWorkItemResponse {
  id: number;
  fields: Record<string, unknown>;
}

interface AzureDevOpsWorkItemWithRelationsResponse {
  id: number;
  fields: Record<string, unknown>;
  relations?: Array<{
    rel: string;
    url: string;
    attributes?: Record<string, unknown>;
  }>;
}

export interface WorkItemComment {
  id: number;
  text: string;
  createdDate: string;
  createdBy?: { displayName: string; uniqueName: string };
}

interface WorkItemCommentsResponse {
  comments: WorkItemComment[];
}

interface PRComment {
  id: number;
  content?: string;
  publishedDate: string;
  author?: { displayName: string; uniqueName: string };
  commentType?: string;
}

interface PRThread {
  id: number;
  comments: PRComment[];
  publishedDate: string;
  threadContext?: {
    filePath?: string;
    rightFileStart?: { line: number; offset: number };
    rightFileEnd?: { line: number; offset: number };
  };
}

interface PRThreadsResponse {
  value: PRThread[];
}

interface PullRequestResponse {
  pullRequestId: number;
  isDraft: boolean;
  status: string; // 'active' | 'completed' | 'abandoned'
}

interface WiqlResponse {
  workItems: { id: number; url?: string }[];
}

// Build timeline types (for CI verification)

interface BuildTimelineRecord {
  name: string;
  type: string;
  state: string;
  result: string;
  errorCount: number;
  warningCount: number;
  issues: { type: string; message: string }[];
}

interface BuildTimelineResponse {
  records: BuildTimelineRecord[];
}

export interface BuildTaskError {
  name: string;
  errorCount: number;
  issues: { type: 'error'; message: string }[];
}

// ---------------------------------------------------------------------------
// Internal fetch helper
// ---------------------------------------------------------------------------

type AdoConfig = PipelineConfig['azureDevOps'];

async function adoFetch<T>(
  config: AdoConfig,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${config.orgUrl}/${encodeURIComponent(config.project)}/_apis/${path}`;
  const auth = Buffer.from(':' + config.pat).toString('base64');

  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new AzureDevOpsError(
      `Azure DevOps API: ${res.status} ${res.statusText} — ${path}\n${body}`,
    );
  }

  return res.json() as Promise<T>;
}

/**
 * Build a direct URL to a pipeline run in Azure DevOps.
 */
export function buildPipelineRunUrl(config: PipelineConfig, runId: number): string {
  return `${config.azureDevOps.orgUrl}/${encodeURIComponent(config.azureDevOps.project)}/_build/results?buildId=${runId}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a work item by ID with all fields expanded.
 */
export async function fetchWorkItem(
  workItemId: number,
  config: PipelineConfig,
): Promise<WorkItem> {
  const response = await adoFetch<AzureDevOpsWorkItemResponse>(
    config.azureDevOps,
    `wit/workitems/${workItemId}?$expand=all&api-version=7.0`,
  );

  const f = response.fields;
  console.log(`[fetchWorkItem] System.Tags raw value: ${JSON.stringify(f['System.Tags'])}`);
  console.log(`[fetchWorkItem] All field keys: ${Object.keys(f).join(', ')}`);
  const tagsRaw = (f['System.Tags'] as string | undefined) ?? '';
  const tags = tagsRaw ? tagsRaw.split(';').map(t => t.trim()).filter(Boolean) : [];

  return {
    id: response.id,
    title: (f['System.Title'] as string) ?? '',
    type: (f['System.WorkItemType'] as string) ?? '',
    state: (f['System.State'] as string) ?? '',
    description: (f['System.Description'] as string) ?? undefined,
    acceptanceCriteria: (f['Microsoft.VSTS.Common.AcceptanceCriteria'] as string) ?? undefined,
    tags,
    areaPath: (f['System.AreaPath'] as string) ?? '',
    iterationPath: (f['System.IterationPath'] as string) ?? '',
    assignedTo: (f['System.AssignedTo'] as { displayName?: string })?.displayName ?? undefined,
    fields: f,
  };
}

/**
 * Check whether a work item has a specific tag.
 */
export async function checkWorkItemTag(
  workItemId: number,
  tag: string,
  config: PipelineConfig,
): Promise<boolean> {
  const workItem = await fetchWorkItem(workItemId, config);
  console.log(`[tag-check] Raw tags for #${workItemId}: ${JSON.stringify(workItem.tags)}`);
  return workItem.tags?.some(t => t.toLowerCase() === tag.toLowerCase()) ?? false;
}

/**
 * Check if a pull request has been published (isDraft → false).
 */
export async function checkPullRequestPublished(
  prId: number,
  config: PipelineConfig,
): Promise<boolean> {
  const pr = await adoFetch<PullRequestResponse>(
    config.azureDevOps,
    `git/repositories/${config.azureDevOps.repositoryId}/pullrequests/${prId}?api-version=7.0`,
  );
  return !pr.isDraft;
}

/**
 * Check if a pull request is still active (not completed or abandoned).
 * Returns the PR status string, or null if the PR cannot be fetched.
 */
export async function getPullRequestStatus(
  prId: number,
  config: PipelineConfig,
): Promise<{ status: string; isDraft: boolean } | null> {
  try {
    const pr = await adoFetch<PullRequestResponse>(
      config.azureDevOps,
      `git/repositories/${config.azureDevOps.repositoryId}/pullrequests/${prId}?api-version=7.0`,
    );
    return { status: pr.status, isDraft: pr.isDraft };
  } catch {
    return null;
  }
}

/**
 * Scan work item comments for a /rerun-* command.
 * Returns the comment text (as feedback) if found, null otherwise.
 */
export async function findRerunCommandInComments(
  workItemId: number,
  command: string,
  config: PipelineConfig,
  since?: string,
): Promise<string | null> {
  const response = await adoFetch<WorkItemCommentsResponse>(
    config.azureDevOps,
    `wit/workItems/${workItemId}/comments?api-version=7.0-preview.3`,
  );

  // Iterate newest-first (API returns in chronological order)
  const comments = [...response.comments].reverse();
  for (const comment of comments) {
    if (since && comment.createdDate <= since) continue;
    // Strip HTML tags — DevOps comments are HTML-formatted
    const plainText = comment.text.replace(/<[^>]+>/g, '').trim();
    const commandRegex = new RegExp(`(?:^|\\n)\\s*${command.replace('/', '\\/')}`, 'm');
    if (commandRegex.test(plainText)) {
      return plainText;
    }
  }
  return null;
}

/**
 * Scan pull request thread comments for a /rerun-* command.
 * Returns the comment text (as feedback) if found, null otherwise.
 */
export async function findRerunCommandInPRComments(
  prId: number,
  command: string,
  config: PipelineConfig,
  since?: string,
): Promise<string | null> {
  const response = await adoFetch<PRThreadsResponse>(
    config.azureDevOps,
    `git/repositories/${config.azureDevOps.repositoryId}/pullrequests/${prId}/threads?api-version=7.0`,
  );

  // Flatten all comments from all threads, newest-first
  const allComments: PRComment[] = [];
  for (const thread of response.value) {
    for (const comment of thread.comments) {
      // commentType "text" = human comment; skip "system" (vote/ref/status changes have no content)
      if (comment.commentType != null && comment.commentType !== 'text') continue;
      if (comment.content == null) continue;
      allComments.push(comment);
    }
  }
  allComments.sort((a, b) => b.publishedDate.localeCompare(a.publishedDate));

  for (const comment of allComments) {
    if (since && comment.publishedDate <= since) continue;
    const commandRegex = new RegExp(`(?:^|\\n)\\s*${command.replace('/', '\\/')}`, 'm');
    const plainText = comment.content!.replace(/<[^>]+>/g, '').trim();
    if (commandRegex.test(plainText)) {
      return plainText;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pipeline comment detection — used to filter out bot-generated comments
// ---------------------------------------------------------------------------

/** HTML signatures that identify pipeline-generated comments */
const PIPELINE_COMMENT_SIGNATURES = [
  'Generated by DevOps Pipeline',
  'Readiness Assessment',
  'Dev Plan',
  'Pipeline Error',
  'Recovery Options',
];

function isPipelineComment(htmlText: string): boolean {
  return PIPELINE_COMMENT_SIGNATURES.some(sig => htmlText.includes(sig));
}

/**
 * Fetch all human discussion comments on a work item since a timestamp.
 * Filters out pipeline-generated comments and any comment containing a rerun command.
 */
export async function fetchWorkItemCommentsSince(
  workItemId: number,
  since: string,
  config: PipelineConfig,
  excludeCommand?: string,
): Promise<WorkItemComment[]> {
  const response = await adoFetch<WorkItemCommentsResponse>(
    config.azureDevOps,
    `wit/workItems/${workItemId}/comments?api-version=7.0-preview.3`,
  );

  return response.comments.filter(comment => {
    // Only comments after the checkpoint timestamp
    if (comment.createdDate <= since) return false;
    // Filter out pipeline-generated comments
    if (isPipelineComment(comment.text)) return false;
    // Filter out the rerun command comment itself (already captured separately)
    if (excludeCommand) {
      const plainText = comment.text.replace(/<[^>]+>/g, '').trim();
      const commandRegex = new RegExp(`(?:^|\\n)\\s*${excludeCommand.replace('/', '\\/')}`, 'm');
      if (commandRegex.test(plainText)) return false;
    }
    return true;
  });
}

/**
 * Run a WIQL query and return matching work item IDs.
 */
export async function queryWorkItems(
  wiql: string,
  config: PipelineConfig,
): Promise<number[]> {
  const response = await adoFetch<WiqlResponse>(
    config.azureDevOps,
    'wit/wiql?api-version=7.0',
    { method: 'POST', body: JSON.stringify({ query: wiql }) },
  );
  return response.workItems.map(wi => wi.id);
}

/**
 * Add tags to a work item (preserves existing tags).
 */
export async function addWorkItemTags(
  workItemId: number,
  tags: string[],
  config: PipelineConfig,
): Promise<void> {
  const workItem = await fetchWorkItem(workItemId, config);
  const existing = workItem.tags ?? [];
  const existingLower = new Set(existing.map(t => t.toLowerCase()));
  const merged = [...existing, ...tags.filter(t => !existingLower.has(t.toLowerCase()))];

  await adoFetch<unknown>(
    config.azureDevOps,
    `wit/workitems/${workItemId}?api-version=7.0`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify([
        { op: 'replace', path: '/fields/System.Tags', value: merged.join('; ') },
      ]),
    },
  );
}

/**
 * Remove tags from a work item (preserves other tags).
 */
export async function removeWorkItemTags(
  workItemId: number,
  tags: string[],
  config: PipelineConfig,
): Promise<void> {
  const workItem = await fetchWorkItem(workItemId, config);
  const existing = workItem.tags ?? [];
  const removeLower = new Set(tags.map(t => t.toLowerCase()));
  const filtered = existing.filter(t => !removeLower.has(t.toLowerCase()));

  if (filtered.length === existing.length) return; // nothing to remove

  await adoFetch<unknown>(
    config.azureDevOps,
    `wit/workitems/${workItemId}?api-version=7.0`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify([
        { op: 'replace', path: '/fields/System.Tags', value: filtered.join('; ') },
      ]),
    },
  );
}

/**
 * Update arbitrary fields on a work item via JSON-patch.
 */
export async function updateWorkItemFields(
  workItemId: number,
  fields: Record<string, string>,
  config: PipelineConfig,
): Promise<void> {
  const ops = Object.entries(fields).map(([field, value]) => ({
    op: 'replace',
    path: `/fields/${field}`,
    value,
  }));

  await adoFetch<unknown>(
    config.azureDevOps,
    `wit/workitems/${workItemId}?api-version=7.0`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify(ops),
    },
  );
}

/**
 * Post a comment to a work item.
 */
export async function postWorkItemComment(
  workItemId: number,
  text: string,
  config: PipelineConfig,
): Promise<void> {
  await adoFetch<unknown>(
    config.azureDevOps,
    `wit/workItems/${workItemId}/comments?api-version=7.0-preview.3`,
    {
      method: 'POST',
      body: JSON.stringify({ text }),
    },
  );
}

/**
 * Update an existing work item comment.
 */
export async function updateWorkItemComment(
  workItemId: number,
  commentId: number,
  text: string,
  config: PipelineConfig,
): Promise<void> {
  await adoFetch<unknown>(
    config.azureDevOps,
    `wit/workItems/${workItemId}/comments/${commentId}?api-version=7.0-preview.3`,
    {
      method: 'PATCH',
      body: JSON.stringify({ text }),
    },
  );
}

// ---------------------------------------------------------------------------
// PR review comment types (public — used by learn-rules CLI)
// ---------------------------------------------------------------------------

export interface PRReviewComment {
  threadId: number;
  commentId: number;
  author: string;
  content: string;
  publishedDate: string;
  filePath?: string;
  line?: number;
}

/**
 * Fetch all human review comments from a pull request.
 * Filters out system-generated comments (commentType !== "text").
 */
export async function fetchPRReviewComments(
  prId: number,
  config: PipelineConfig,
): Promise<PRReviewComment[]> {
  const response = await adoFetch<PRThreadsResponse>(
    config.azureDevOps,
    `git/repositories/${config.azureDevOps.repositoryId}/pullrequests/${prId}/threads?api-version=7.0`,
  );

  const comments: PRReviewComment[] = [];
  for (const thread of response.value) {
    for (const comment of thread.comments) {
      // commentType "text" = human comment, skip "system" and other types
      if (comment.commentType != null && comment.commentType !== 'text') continue;
      if (comment.content == null) continue;
      comments.push({
        threadId: thread.id,
        commentId: comment.id,
        author: comment.author?.displayName ?? 'Unknown',
        content: comment.content.replace(/<[^>]+>/g, '').trim(),
        publishedDate: comment.publishedDate,
        filePath: thread.threadContext?.filePath,
        line: thread.threadContext?.rightFileEnd?.line
          ?? thread.threadContext?.rightFileStart?.line,
      });
    }
  }
  return comments;
}

/**
 * Post a comment thread on a pull request.
 * Uses status=4 (closed) so it shows as informational without requiring resolution.
 */
export async function postPRComment(
  prId: number,
  text: string,
  config: PipelineConfig,
): Promise<void> {
  await adoFetch<unknown>(
    config.azureDevOps,
    `git/repositories/${config.azureDevOps.repositoryId}/pullrequests/${prId}/threads?api-version=7.0`,
    {
      method: 'POST',
      body: JSON.stringify({
        comments: [{ content: text, commentType: 1 }],
        status: 4,
      }),
    },
  );
}

// ---------------------------------------------------------------------------
// Test case failure resolution
// ---------------------------------------------------------------------------

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

/**
 * Fetch pipeline build timeline and return tasks that have errors.
 * Filters to Task-type records with errorCount > 0, extracting only error-level issues.
 */
export async function getBuildTimeline(
  buildId: number,
  config: PipelineConfig,
): Promise<BuildTaskError[]> {
  const response = await adoFetch<BuildTimelineResponse>(
    config.azureDevOps,
    `build/builds/${buildId}/timeline?api-version=7.1`,
  );

  return response.records
    .filter((r) => r.type === 'Task' && r.errorCount > 0)
    .map((r) => ({
      name: r.name,
      errorCount: r.errorCount,
      issues: r.issues
        .filter((i) => i.type === 'error')
        .map((i) => ({ type: 'error' as const, message: i.message })),
    }));
}
