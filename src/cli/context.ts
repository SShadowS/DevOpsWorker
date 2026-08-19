import { join } from 'path';
import type { PipelineConfig, PipelineContext } from '../types/pipeline.types.ts';
import { fetchWorkItem } from '../sdk/azure-devops-client.ts';
import { downloadWorkItemImages, rewriteImageSources } from '../sdk/ado/attachments.ts';

/** Where a session keeps the screenshots pulled off its work item. */
export const WORK_ITEM_IMAGE_DIR = '.work-item-images';

/**
 * Build a PipelineContext by fetching the work item and determining its type.
 * Shared between `run` and `continue` commands.
 *
 * Any screenshots embedded in the description are downloaded here, at the one
 * point every command passes through, so that every agent downstream gets local
 * file paths instead of attachment URLs it has no way to open.
 */
export async function buildPipelineContext(
  workItemId: number,
  config: PipelineConfig,
): Promise<PipelineContext> {
  const workItem = await fetchWorkItem(workItemId, config);

  const images = await downloadWorkItemImages(
    workItem,
    join(config.paths.sessionRoot, WORK_ITEM_IMAGE_DIR),
    config,
  );
  workItem.images = images;
  workItem.description = rewriteImageSources(workItem.description, images);
  workItem.acceptanceCriteria = rewriteImageSources(workItem.acceptanceCriteria, images);

  return {
    workItemId,
    workItem,
    workItemType: workItem.type as 'Bug' | 'User Story',
    config,
  };
}
