import type { PipelineConfig, PipelineContext } from '../types/pipeline.types.ts';
import { fetchWorkItem } from '../sdk/azure-devops-client.ts';

/**
 * Build a PipelineContext by fetching the work item and determining its type.
 * Shared between `run` and `continue` commands.
 */
export async function buildPipelineContext(
  workItemId: number,
  config: PipelineConfig,
): Promise<PipelineContext> {
  const workItem = await fetchWorkItem(workItemId, config);

  return {
    workItemId,
    workItem,
    workItemType: workItem.type as 'Bug' | 'User Story',
    config,
  };
}
