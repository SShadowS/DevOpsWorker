import type {
  Stage,
  PipelineState,
  PipelineContext,
  PipelineConfig,
  CheckpointConfig,
  TestCaseFailure,
} from '../types/pipeline.types.ts';
import {
  checkWorkItemTag,
  checkPullRequestPublished,
  getPullRequestStatus,
  findRerunCommandInComments,
  findRerunCommandInPRComments,
  fetchPRReviewComments,
  fetchWorkItemCommentsSince,
  removeWorkItemTags,
  fetchTestCaseFailures,
} from '../sdk/azure-devops-client.ts';
import { summarizePRComments } from './human-feedback.ts';

// ---------------------------------------------------------------------------
// checkpoint — human approval gate with polling
// ---------------------------------------------------------------------------

/**
 * Result of checking a checkpoint condition.
 */
export interface CheckpointResult {
  /** Whether the checkpoint condition is satisfied */
  satisfied: boolean;
  /** Human revision feedback detected (e.g. /rerun-plan comment) */
  revisionFeedback?: {
    source: 'work-item-comment' | 'pr-comment';
    feedback: string;
    targetStage: string;
  };
}

function getPrId(state: PipelineState): number | undefined {
  return state.draftPR?.id;
}

/**
 * Check if a tag exists on a work item.
 */
async function checkTag(
  workItemId: number,
  tag: string,
  config: PipelineConfig,
): Promise<boolean> {
  console.log(`[checkpoint] Checking tag "${tag}" on work item #${workItemId}...`);
  return checkWorkItemTag(workItemId, tag, config);
}

/**
 * Check if a draft PR has been published (isDraft → false).
 */
async function checkPRPublished(
  state: PipelineState,
  config: PipelineConfig,
): Promise<boolean> {
  const prId = getPrId(state);
  if (!prId) {
    console.log(`[checkpoint] No draft PR ID in state, cannot check publish status`);
    return false;
  }
  console.log(`[checkpoint] Checking if PR #${prId} has been published...`);
  return checkPullRequestPublished(prId, config);
}

/**
 * Check for /rerun-* commands in DevOps comments (both work item and PR).
 * Uses checkpoint state timestamp as the `since` filter.
 */
async function checkRerunCommand(
  workItemId: number,
  command: string,
  config: PipelineConfig,
  state: PipelineState,
): Promise<string | null> {
  const since = state.checkpoint?.enteredAt;

  // Check work item comments
  const wiResult = await findRerunCommandInComments(workItemId, command, config, since);
  if (wiResult) return wiResult;

  // Check PR comments if a draft PR exists
  const prId = getPrId(state);
  if (prId) {
    const prResult = await findRerunCommandInPRComments(prId, command, config, since);
    if (prResult) return prResult;
  }

  return null;
}

/**
 * Resolve the effective rerun commands from a CheckpointConfig.
 * Supports both the new `rerunCommands` array and the deprecated `rerunCommand`/`rewindToStage` fields.
 */
function resolveRerunCommands(config: CheckpointConfig): Array<{
  command: string;
  rewindToStage: string;
  rerunMode?: string;
  removeTag?: string;
  summarizeComments?: boolean;
}> {
  if (config.rerunCommands && config.rerunCommands.length > 0) {
    return config.rerunCommands.filter(c => c.command != null);
  }
  // Fallback to deprecated single-command fields
  if (config.rerunCommand) {
    return [{
      command: config.rerunCommand,
      rewindToStage: config.rewindToStage ?? config.name,
    }];
  }
  return [];
}

/**
 * Creates a checkpoint Stage that gates on human approval.
 *
 * When executed:
 * - Checks the detection condition (tag or PR published)
 * - If satisfied: returns state with checkpoint cleared
 * - If not satisfied: records checkpoint state and returns
 *   (the orchestrator will persist and exit; `pipeline continue` re-checks)
 * - Also checks for /rerun-* commands that trigger revision feedback
 */
export function checkpoint(config: CheckpointConfig): Stage {
  return {
    name: `checkpoint:${config.name}`,

    canRun(_state: PipelineState): boolean {
      // Checkpoints can always run — they just check conditions
      return true;
    },

    async execute(state: PipelineState, context: PipelineContext): Promise<PipelineState> {
      const now = new Date().toISOString();
      const logger = context.logger;

      // Check for revision feedback (only on resume — first entry has no time window)
      const rerunCommands = resolveRerunCommands(config);
      if (rerunCommands.length > 0 && state.checkpoint?.enteredAt) {
        // Check each command in order — first match wins
        for (const cmd of rerunCommands) {
          logger?.log(`Checking for rerun command "${cmd.command}"...`);
          const feedback = await checkRerunCommand(
            context.workItemId,
            cmd.command,
            context.config,
            state,
          );

          if (feedback) {
            logger?.log(`Rerun detected — rewinding to "${cmd.rewindToStage}"`);
            logger?.logPrompt('RERUN FEEDBACK', feedback);

            const source: 'work-item-comment' | 'pr-comment' =
              config.detect.type === 'tag' ? 'work-item-comment' : 'pr-comment';

            // Remove tag if configured (non-fatal)
            if (cmd.removeTag) {
              try {
                await removeWorkItemTags(context.workItemId, [cmd.removeTag], context.config);
                logger?.log(`Removed tag "${cmd.removeTag}" from work item #${context.workItemId}`);
              } catch (err) {
                logger?.log(`Warning: failed to remove tag "${cmd.removeTag}": ${err instanceof Error ? err.message : err}`);
              }
            }

            // Fetch PR review comments if a PR exists (non-fatal)
            const prId = getPrId(state);
            let prReviewComments: Awaited<ReturnType<typeof fetchPRReviewComments>> | undefined;
            if (prId) {
              try {
                const allComments = await fetchPRReviewComments(prId, context.config);
                const since = state.checkpoint?.enteredAt;
                prReviewComments = since
                  ? allComments.filter(c => c.publishedDate > since)
                  : allComments;
                if (prReviewComments.length === 0) prReviewComments = undefined;
                logger?.log(`Fetched ${prReviewComments?.length ?? 0} PR review comments`);
              } catch (err) {
                logger?.log(`Warning: failed to fetch PR review comments: ${err instanceof Error ? err.message : err}`);
              }
            }

            // Summarize PR comments when configured (non-fatal)
            let commentSummary: string | undefined;
            if (prReviewComments && cmd.summarizeComments) {
              try {
                commentSummary = await summarizePRComments(prReviewComments);
                if (commentSummary) {
                  logger?.log(`Generated PR comment summary for planner`);
                }
              } catch (err) {
                logger?.log(`Warning: failed to summarize PR comments: ${err instanceof Error ? err.message : err}`);
              }
            }

            // Fetch human discussion comments from the work item (non-fatal)
            let workItemComments: { author: string; text: string; createdDate: string }[] | undefined;
            try {
              const since = state.checkpoint!.enteredAt;
              const rawComments = await fetchWorkItemCommentsSince(
                context.workItemId,
                since,
                context.config,
                cmd.command,
              );
              if (rawComments.length > 0) {
                workItemComments = rawComments.map(c => ({
                  author: c.createdBy?.displayName ?? 'Unknown',
                  text: c.text.replace(/<[^>]+>/g, '').trim(),
                  createdDate: c.createdDate,
                }));
                logger?.log(`Fetched ${workItemComments.length} human discussion comment(s) from work item`);
              }
            } catch (err) {
              logger?.log(`Warning: failed to fetch work item comments: ${err instanceof Error ? err.message : err}`);
            }

            // Fetch test case failures for /fix-test
            let testCaseFailures: TestCaseFailure[] | undefined;
            if (cmd.rerunMode === 'fix-test' && context.workItemId) {
              try {
                testCaseFailures = await fetchTestCaseFailures(context.workItemId, context.config);
              } catch (err) {
                logger?.log(`Failed to fetch test case failures: ${err}`);
              }
            }

            return {
              ...state,
              checkpoint: undefined,
              rerunMode: cmd.rerunMode as PipelineState['rerunMode'],
              revisionFeedback: {
                source,
                feedback,
                targetStage: cmd.rewindToStage,
              },
              humanFeedback: {
                rerunComment: feedback,
                source,
                prReviewComments,
                commentSummary,
                workItemComments,
                testCaseFailures,
              },
            };
          }
        }
      }

      // Check the primary condition
      let satisfied = false;

      if (config.detect.type === 'tag') {
        logger?.log(`Checking tag "${config.detect.tag}" on work item #${context.workItemId}...`);
        satisfied = await checkTag(context.workItemId, config.detect.tag, context.config);
        logger?.log(`Tag check result: ${satisfied ? 'found' : 'not found'}`);
      } else if (config.detect.type === 'draft-pr') {
        logger?.log(`Checking if draft PR has been published...`);
        satisfied = await checkPRPublished(state, context.config);
        logger?.log(`PR publish check result: ${satisfied ? 'published' : 'still draft'}`);
      } else if (config.detect.type === 'pr-completed') {
        const prId = getPrId(state);
        if (prId) {
          logger?.log(`Checking if PR #${prId} has been completed...`);
          const prStatus = await getPullRequestStatus(prId, context.config);
          satisfied = prStatus?.status === 'completed';
          logger?.log(`PR completion check result: ${satisfied ? 'completed' : `status=${prStatus?.status ?? 'unknown'}`}`);
        } else {
          logger?.log(`No PR ID in state, cannot check completion status`);
        }
      }

      if (satisfied) {
        logger?.log('Checkpoint satisfied — proceeding');
        return {
          ...state,
          checkpoint: undefined,
        };
      }

      // Not satisfied — record checkpoint and return
      logger?.log('Checkpoint not satisfied — pipeline will pause');
      const checkpoint = state.checkpoint?.name === config.name
        ? { ...state.checkpoint, lastPolledAt: now }
        : { name: config.name, enteredAt: now, lastPolledAt: now };

      return {
        ...state,
        checkpoint,
      };
    },
  };
}
