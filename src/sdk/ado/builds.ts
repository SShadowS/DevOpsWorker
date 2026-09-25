import type { PipelineConfig } from '../../types/pipeline.types.ts';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { adoFetch, AzureDevOpsError } from './http.ts';
import { LETHAL_ARTIFACT, type LethalFiles } from '../lethal.ts';

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

// ---------------------------------------------------------------------------
// LethAL artifact (mutation-testing results for the PR reviewer)
// ---------------------------------------------------------------------------

interface BuildListResponse {
  value: { id: number; sourceVersion: string }[];
}

interface ArtifactResponse {
  resource: { downloadUrl: string };
}

export type LethalArtifactResult =
  | { ok: true; buildId: number; files: LethalFiles }
  | { ok: false; reason: string };

/**
 * Find the newest completed build of `sourceRef` at `headSha` that published the
 * `lethal-report` artifact, and read its files.
 *
 * Measured against Azure DevOps (build 771365, PR 56719):
 *   - PR builds are queued on the PR's SOURCE branch; `refs/pull/<id>/merge` has none.
 *   - `build.sourceVersion` equals the PR's `lastMergeSourceCommit`, so a build of
 *     an older commit (whose line numbers no longer match) is skipped.
 *   - A build without the artifact answers 404 `ArtifactNotFoundException`.
 *   - `downloadUrl` serves a zip holding `<artifactName>/<file>`, with the same PAT.
 * Never throws: no artifact must mean a normal review.
 */
export async function fetchLethalArtifact(
  sourceRef: string,
  headSha: string | undefined,
  config: PipelineConfig,
  workDir: string,
): Promise<LethalArtifactResult> {
  const ado = config.azureDevOps;
  try {
    const builds = await adoFetch<BuildListResponse>(
      ado,
      `build/builds?repositoryId=${ado.repositoryId}&repositoryType=TfsGit&branchName=${encodeURIComponent(sourceRef)}` +
        `&statusFilter=completed&queryOrder=finishTimeDescending&$top=10&api-version=7.1`,
    );
    const candidates = builds.value.filter((b) => !headSha || b.sourceVersion === headSha);
    for (const b of candidates) {
      let artifact: ArtifactResponse;
      try {
        artifact = await adoFetch<ArtifactResponse>(ado, `build/builds/${b.id}/artifacts?artifactName=${LETHAL_ARTIFACT}&api-version=7.1`);
      } catch (err) {
        if (err instanceof AzureDevOpsError && err.status === 404) continue;
        throw err;
      }
      const res = await fetch(artifact.resource.downloadUrl, {
        headers: { Authorization: `Basic ${Buffer.from(':' + ado.pat).toString('base64')}` },
      });
      if (!res.ok) return { ok: false, reason: `artifact download from build ${b.id} answered ${res.status}` };
      const dir = join(workDir, `lethal-${b.id}`);
      mkdirSync(dir, { recursive: true });
      const zip = join(dir, 'artifact.zip');
      await Bun.write(zip, await res.arrayBuffer());
      const unzip = Bun.spawnSync(['unzip', '-o', '-q', zip, '-d', dir]);
      if (unzip.exitCode !== 0) return { ok: false, reason: `could not unzip the artifact from build ${b.id}` };
      const read = (name: string) => join(dir, LETHAL_ARTIFACT, name);
      const exitRaw = existsSync(read('exit-code')) ? readFileSync(read('exit-code'), 'utf8').trim() : '';
      return {
        ok: true,
        buildId: b.id,
        files: {
          explain: JSON.parse(readFileSync(read('explain.json'), 'utf8')),
          report: JSON.parse(readFileSync(read('report.json'), 'utf8')),
          ...(exitRaw ? { exitCode: Number(exitRaw) } : {}),
        },
      };
    }
    return { ok: false, reason: candidates.length ? `no ${LETHAL_ARTIFACT} artifact on ${candidates.length} build(s) of this commit` : 'no completed build of this commit' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message.split('\n')[0]! : String(err) };
  }
}
