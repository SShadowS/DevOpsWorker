import type { PipelineConfig } from '../../types/pipeline.types.ts';
import { adoFetch } from './http.ts';

// ---------------------------------------------------------------------------
// Build timeline (for CI verification)
// ---------------------------------------------------------------------------

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
