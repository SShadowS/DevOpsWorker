import type { PipelineConfig } from '../../types/pipeline.types.ts';

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
// Internal fetch helper — shared by every resource module in `./ado/`
// ---------------------------------------------------------------------------

type AdoConfig = PipelineConfig['azureDevOps'];

export async function adoFetch<T>(
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
