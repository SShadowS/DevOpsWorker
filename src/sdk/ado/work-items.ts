import type { PipelineConfig, WorkItem } from '../../types/pipeline.types.ts';
import { isPipelineComment } from '../../formatters/devops-comment.ts';
import { adoFetch } from './http.ts';

// ---------------------------------------------------------------------------
// Private response types
// ---------------------------------------------------------------------------

interface AzureDevOpsWorkItemResponse {
  id: number;
  fields: Record<string, unknown>;
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

interface WiqlResponse {
  workItems: { id: number; url?: string }[];
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
  return workItem.tags?.some(t => t.toLowerCase() === tag.toLowerCase()) ?? false;
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
  format: 'html' | 'markdown' = 'html',
): Promise<void> {
  // `format` is a QUERY-STRING parameter (CommentFormat enum: markdown|html), NOT a
  // body field — see the Add Work Item Comment REST API. Markdown comments render
  // real heading hierarchy + <details> collapsibles; once posted as markdown a
  // comment can't be converted back to html (one-way — fine, we post each once).
  await adoFetch<unknown>(
    config.azureDevOps,
    `wit/workItems/${workItemId}/comments?format=${format}&api-version=7.1-preview.4`,
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
