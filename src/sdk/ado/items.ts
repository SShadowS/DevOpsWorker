import type { PipelineConfig } from '../../types/pipeline.types.ts';

/**
 * Read one file's text as it stands at a given commit.
 *
 * NOT routed through `adoFetch`, and that is the whole point of this module.
 * With `includeContent=true` this endpoint answers with the file itself —
 * `content-type: application/octet-stream`, raw bytes — so `adoFetch`'s
 * unconditional `JSON.parse` throws on any AL file, and silently returns the
 * wrong thing for a JSON one. Measured against a live repository: the same
 * request with `adoFetch`'s headers returns 200 and then fails parsing with
 * `Unexpected identifier "codeunit"`. `Accept: text/plain` asks for exactly what
 * we want. The same bypass, for the same reason, is in the overlay's
 * `fetchItemText`.
 *
 * Returns `null` for every failure — missing file, bad commit, non-2xx, network
 * error — so that callers fail closed. The only caller is the suggested-fix
 * gate, and "could not read the file" must mean "post no suggestion", never
 * "post one anyway".
 */
export async function fetchFileAtCommit(
  path: string,
  commitId: string,
  config: PipelineConfig,
): Promise<string | null> {
  const ado = config.azureDevOps;
  const repoPath = path.startsWith('/') ? path : `/${path}`;
  const url =
    `${ado.orgUrl}/${encodeURIComponent(ado.project)}/_apis/git/repositories/${ado.repositoryId}/items` +
    `?path=${encodeURIComponent(repoPath)}` +
    `&versionDescriptor.version=${encodeURIComponent(commitId)}` +
    `&versionDescriptor.versionType=commit` +
    `&includeContent=true&api-version=7.0`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(':' + ado.pat).toString('base64')}`,
        Accept: 'text/plain',
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
