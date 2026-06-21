import { query } from '@anthropic-ai/claude-agent-sdk';
import type { PipelineState } from '../types/pipeline.types.ts';
import type { PRReviewComment } from '../sdk/azure-devops-client.ts';

// ---------------------------------------------------------------------------
// summarizePRComments — LLM-generated narrative summary of PR review comments
// ---------------------------------------------------------------------------

const SUMMARIZE_PROMPT = `You are analyzing PR review comments to help a developer understand why their approach was rejected and what direction to take.

The comments are in chronological order. PR review discussions often evolve — early comments may fix specific code issues, while later comments may reject the entire approach. Your job is to identify this narrative arc.

Produce a concise summary (3-5 sentences) that:
1. Identifies whether reviewers want code fixes OR a fundamentally different approach
2. Captures the key architectural concerns (not code-level nits like naming or formatting)
3. Notes the final direction/consensus if one emerged
4. Highlights any specific alternatives the reviewers suggested

Comments:
`;

/**
 * Use Haiku to summarize PR review comments into an architectural narrative.
 * Returns a concise summary string, or undefined if summarization fails.
 */
export async function summarizePRComments(comments: PRReviewComment[]): Promise<string | undefined> {
  if (comments.length === 0) return undefined;

  const commentsText = comments
    .sort((a, b) => a.publishedDate.localeCompare(b.publishedDate))
    .map(c => {
      const location = c.filePath
        ? ` on \`${c.filePath}${c.line ? `:${c.line}` : ''}\``
        : '';
      return `[${c.author}]${location}: ${c.content}`;
    })
    .join('\n');

  const prompt = SUMMARIZE_PROMPT + commentsText;

  try {
    let summary: string | undefined;

    for await (const message of query({
      prompt,
      options: {
        model: 'claude-haiku-4-5-20251001',
        maxTurns: 1,
        allowedTools: [],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    })) {
      if (message.type === 'result' && message.subtype === 'success') {
        summary = message.result;
      }
    }

    return summary?.trim() || undefined;
  } catch (err) {
    console.warn(`[human-feedback] Warning: failed to summarize PR comments: ${err instanceof Error ? err.message : err}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// buildHumanFeedbackSection — renders humanFeedback into prompt lines
// ---------------------------------------------------------------------------

/**
 * Build prompt lines from state.humanFeedback (rerun comment + PR review comments).
 * Returns an empty array when no humanFeedback is present.
 *
 * @param mode - 'planning' renders commentSummary (narrative), 'coding' renders raw PR comments
 */
export function buildHumanFeedbackSection(state: PipelineState, mode: 'planning' | 'coding' = 'coding'): string[] {
  const hf = state.humanFeedback;
  if (!hf) return [];

  const parts: string[] = [
    ``,
    `## Human Feedback (from rerun request)`,
    ``,
    `> ${hf.rerunComment.replace(/\n/g, '\n> ')}`,
  ];

  if (mode === 'planning' && hf.commentSummary) {
    // Planning mode with summary: render the LLM-generated narrative
    parts.push(
      ``,
      `### PR Review Summary`,
      ``,
      hf.commentSummary,
    );
  } else {
    // Coding mode, or planning fallback when summary unavailable: render raw comments
    const comments = hf.prReviewComments;
    if (comments && comments.length > 0) {
      const heading = mode === 'planning'
        ? `### PR Review Comments (summary unavailable)`
        : `### PR Review Comments`;
      parts.push(``, heading);

      // Group comments by file path
      const byFile = new Map<string, typeof comments>();
      for (const c of comments) {
        const key = c.filePath ?? '(general)';
        if (!byFile.has(key)) byFile.set(key, []);
        byFile.get(key)!.push(c);
      }

      for (const [filePath, fileComments] of byFile) {
        parts.push(``, `**${filePath}**`);
        for (const c of fileComments) {
          const loc = c.line ? ` (line ${c.line})` : '';
          parts.push(`- ${c.author}${loc}: ${c.content}`);
        }
      }
    }
  }

  // Work item discussion comments (from other humans)
  const wiComments = hf.workItemComments;
  if (wiComments && wiComments.length > 0) {
    parts.push(``, `### Discussion Context`);
    parts.push(``, `Other comments on this work item since the last pipeline run:`);
    for (const c of wiComments) {
      const date = c.createdDate.split('T')[0];
      parts.push(`- **${c.author}** (${date}): ${c.text}`);
    }
  }

  return parts;
}
