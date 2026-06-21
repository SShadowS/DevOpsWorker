import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ProposedRulesSchema, type ProposedRule, type ProposedRules } from '../agents/rule-learner/schema.ts';
import { AGENT_DIR, AGENT_NAME, ALLOWED_TOOLS, SHARED_PROMPT_FRAGMENTS } from '../agents/rule-learner/config.ts';
import { stageAgentWorkspace } from '../sdk/agent-workspace.ts';
import { buildSharedFragmentContent } from '../sdk/prompt-loader.ts';
import { fetchPRReviewComments } from '../sdk/azure-devops-client.ts';
import { AgentValidationError } from '../sdk/errors.ts';
import { loadConfig } from './config.ts';

// ---------------------------------------------------------------------------
// pipeline learn-rules --pr <pr-id>
// ---------------------------------------------------------------------------

export async function learnRules(args: string[]): Promise<void> {
  const { prId, json } = parseArgs(args);

  if (!json) console.log(`Analyzing review comments from PR #${prId}...`);

  // Load config (Azure DevOps settings come from env vars)
  const config = loadConfig('.');

  // Fetch PR review comments
  const allComments = await fetchPRReviewComments(prId, config);

  if (allComments.length === 0) {
    if (json) {
      process.stdout.write(JSON.stringify({ proposedRules: [], contradictions: [], alreadyCovered: [], summary: 'No review comments found on this PR.' }));
      return;
    }
    console.log('No review comments found on this PR.');
    return;
  }

  if (!json) console.log(`Found ${allComments.length} review comments. Running rule-learner agent...`);

  // Build the prompt with comment data
  const commentsText = allComments.map((c, i) => {
    const location = c.filePath
      ? ` on \`${c.filePath}${c.line ? `:${c.line}` : ''}\``
      : '';
    return `### Comment ${i + 1} (by ${c.author})${location}\n${c.content}`;
  }).join('\n\n');

  const prompt = [
    `## Task`,
    `Analyze the following PR review comments and propose generalizable AL review patterns.`,
    ``,
    `## PR Review Comments (${allComments.length} total)`,
    ``,
    commentsText,
    ``,
    `## Instructions`,
    `1. Read the existing review patterns file at \`src/prompts/al-review-patterns.md\``,
    `2. Analyze each comment for generalizable patterns`,
    `3. Propose new rules that aren't already covered`,
    `4. Flag any contradictions with existing rules`,
    `5. Note which comments are already covered by existing rules`,
  ].join('\n');

  // Stage workspace (CLAUDE.md + .claude/) and run agent
  const staged = await stageAgentWorkspace(AGENT_DIR, process.cwd());
  const sharedContent = buildSharedFragmentContent(SHARED_PROMPT_FRAGMENTS);

  try {
    let result: ProposedRules | null = null;

    for await (const message of query({
      prompt,
      options: {
        systemPrompt: {
          type: 'preset' as const,
          preset: 'claude_code' as const,
          ...(sharedContent ? { append: sharedContent } : {}),
        },
        settingSources: ['project'],
        outputFormat: {
          type: 'json_schema',
          schema: z.toJSONSchema(ProposedRulesSchema),
        },
        allowedTools: ALLOWED_TOOLS,
        model: 'claude-sonnet-4-6',
        cwd: process.cwd(),
        maxTurns: 20,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    })) {
      if (message.type === 'assistant') {
        process.stderr.write(`[${AGENT_NAME}] Processing...\n`);
      }

      if (message.type === 'result') {
        const costInfo = `$${message.total_cost_usd.toFixed(2)} | ${(message.duration_ms / 1000).toFixed(0)}s | ${message.num_turns} turns`;
        process.stderr.write(`[${AGENT_NAME}] Complete — ${costInfo}\n`);

        if (message.subtype === 'success' && message.structured_output) {
          const parsed = ProposedRulesSchema.safeParse(message.structured_output);
          if (parsed.success) {
            result = parsed.data;
          } else {
            throw new AgentValidationError(AGENT_NAME, parsed.error);
          }
        } else {
          console.error(`Agent failed: ${message.subtype}`);
          process.exit(1);
        }
      }
    }

    if (!result) {
      console.error('No result received from agent');
      process.exit(1);
    }

    if (json) {
      process.stdout.write(JSON.stringify(result));
    } else {
      displayResults(result);
    }
  } finally {
    await staged.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function displayResults(result: ProposedRules): void {
  console.log('\n' + '='.repeat(60));
  console.log('RULE LEARNING RESULTS');
  console.log('='.repeat(60));

  console.log(`\n${result.summary}\n`);

  if (result.proposedRules.length > 0) {
    console.log(`\n## Proposed Rules (${result.proposedRules.length})\n`);
    console.log('Copy approved rules into src/prompts/al-review-patterns.md:\n');

    for (const rule of result.proposedRules) {
      console.log(formatRule(rule));
    }
  } else {
    console.log('\nNo new rules proposed.');
  }

  if (result.contradictions.length > 0) {
    console.log(`\n## Contradictions Found (${result.contradictions.length})\n`);
    for (const c of result.contradictions) {
      console.log(`- **${c.existingRule}**: ${c.explanation}`);
      console.log(`  Comment: ${c.comment.substring(0, 200)}\n`);
    }
  }

  if (result.alreadyCovered.length > 0) {
    console.log(`\n## Already Covered (${result.alreadyCovered.length})\n`);
    for (const c of result.alreadyCovered) {
      console.log(`- ${c}`);
    }
  }
}

function formatRule(rule: ProposedRule): string {
  return [
    `---`,
    ``,
    `## Rule: ${rule.title}`,
    ``,
    `**Categories:** ${rule.categories.join(', ')}`,
    ``,
    `**Confidence:** ${rule.confidence}`,
    ``,
    `**Rationale:** ${rule.rationale}`,
    ``,
    `**BAD:**`,
    '```al',
    rule.badExample,
    '```',
    ``,
    `**GOOD:**`,
    '```al',
    rule.goodExample,
    '```',
    ``,
    `**Source comment:** ${rule.sourceComment.substring(0, 300)}`,
    ``,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(args: string[]): { prId: number; json: boolean } {
  let prId: number | undefined;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--pr' || arg === '-p') && args[i + 1]) {
      prId = parseInt(args[++i]!, 10);
    } else if (arg === '--json' || arg === '-j') {
      json = true;
    }
  }

  if (!prId || isNaN(prId)) {
    console.error('Error: --pr <id> is required');
    console.error('Usage: pipeline learn-rules --pr <pr-id> [--json]');
    process.exit(1);
  }

  return { prId, json };
}
