import type { PipelineConfig } from '../types/pipeline.types.ts';

/**
 * The public/generic placeholder values shipped by the open-source core when no
 * real Azure DevOps config is supplied (via AZURE_DEVOPS_* env vars or the private
 * overlay's repo registration). If any of these reaches a real ADO operation, the
 * deployment is misconfigured — every ADO call will 404 / TF-error silently.
 */
const PLACEHOLDERS: Record<string, string> = {
  organization: 'your-org',
  project: 'Your Project',
  repositoryId: '00000000-0000-0000-0000-000000000000',
  repositoryName: 'Your Repository',
  areaPath: 'Your Area',
};

/**
 * Fail loud if the resolved Azure DevOps config still carries the public
 * placeholder defaults. Call at the start of any entry point that performs real
 * ADO work (watcher polling, pipeline run, PR review) — BEFORE the first API call,
 * so a missing env var / incomplete overlay produces an obvious actionable error
 * instead of a silent 404.
 *
 * Checks only the fields that actually break ADO calls (org/project/repositoryId).
 * `repositoryName`/`areaPath` placeholders are reported too when present, as a hint.
 *
 * @throws Error when a placeholder is detected.
 */
export function assertRealAdoConfig(config: PipelineConfig, context = 'pipeline'): void {
  const ado = config.azureDevOps;
  const hits: string[] = [];

  if (ado.organization === PLACEHOLDERS['organization']) hits.push(`organization='${ado.organization}'`);
  if (ado.project === PLACEHOLDERS['project']) hits.push(`project='${ado.project}'`);
  if (ado.repositoryId === PLACEHOLDERS['repositoryId']) hits.push(`repositoryId='${ado.repositoryId}'`);
  if (ado.repositoryName === PLACEHOLDERS['repositoryName']) hits.push(`repositoryName='${ado.repositoryName}'`);
  if (ado.areaPath === PLACEHOLDERS['areaPath']) hits.push(`areaPath='${ado.areaPath}'`);

  if (hits.length > 0) {
    throw new Error(
      `[config-sanity] Placeholder Azure DevOps config reached runtime (${context}): ${hits.join(', ')}. ` +
        `These are the open-source placeholder defaults — supply the real values via AZURE_DEVOPS_* env vars ` +
        `(.env) for the watcher, or via the private overlay's repo registration (organization, repositoryId, …) ` +
        `for spawned pipeline/review containers. See .env.example and private.example/.`,
    );
  }
}
