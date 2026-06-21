import { getBuildTimeline } from '../sdk/azure-devops-client.ts';
import type { PipelineConfig } from '../types/pipeline.types.ts';

export interface CIVerificationResult {
  ciResult: 'passed' | 'failed';
  errors: string[];
  tasksFailed: string[];
}

/**
 * Verify CI result by checking individual pipeline tasks for errors.
 * Returns failed if any task has errorCount > 0, with the actual error messages.
 */
export async function verifyCIResult(
  ciRunId: number,
  config: PipelineConfig,
): Promise<CIVerificationResult> {
  const failedTasks = await getBuildTimeline(ciRunId, config);

  if (failedTasks.length === 0) {
    return { ciResult: 'passed', errors: [], tasksFailed: [] };
  }

  const errors: string[] = [];
  const tasksFailed: string[] = [];

  for (const task of failedTasks) {
    tasksFailed.push(task.name);
    for (const issue of task.issues) {
      errors.push(`[${task.name}] ${issue.message}`);
    }
  }

  return { ciResult: 'failed', errors, tasksFailed };
}
