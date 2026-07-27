import type { RepoConfig } from '../config/repo-config.ts';

export interface ContainerConfig {
  workItemId: number;
  repoKey: string;
  repo: RepoConfig;
  command: 'run' | 'continue' | 'review-pr';
  env: Record<string, string>;
  stateVolume: string;
  workspaceVolume: string;
  imageName: string;
  /** Extra CLI args appended after the command (e.g., --pr-id 44801) */
  extraArgs?: string[];
}

/**
 * Build docker run arguments for a pipeline container.
 */
export function buildDockerArgs(config: ContainerConfig): string[] {
  const containerName = `wi-${config.workItemId}`;

  const args = [
    'run', '--rm',
    '--name', containerName,
    '--network', 'pipeline-net',
    '-v', `${config.stateVolume}:/state`,
    '-v', `${config.workspaceVolume}:/workspace`,
  ];

  // Mount the private overlay (read-only) into the spawned container so it loads
  // the same repo registry / env-provider / prompts the daemon does. The watcher
  // runs in a container and spawns siblings via the docker socket, so the mount
  // source must be the HOST path to private/ (HOST_PRIVATE_DIR). When unset, the
  // container runs generic (empty overlay) — keeps the image public-safe.
  const hostPrivateDir = process.env['HOST_PRIVATE_DIR'];
  if (hostPrivateDir) {
    args.push('-v', `${hostPrivateDir}:/app/private:ro`);
    args.push('-e', 'PRIVATE_DIR=/app/private');
  }

  // Env vars
  for (const [key, value] of Object.entries(config.env)) {
    if (value) args.push('-e', `${key}=${value}`);
  }

  // Pass DATABASE_URL so containers connect to PostgreSQL.
  //
  // Only when the caller did not supply one. Docker takes the LAST `-e` for a
  // given key, so appending unconditionally here silently overrode anything the
  // caller put in `config.env` — a caller that had deliberately rewritten the
  // URL for in-container use got the host value back and could not tell.
  if (!('DATABASE_URL' in config.env)) {
    const databaseUrl = process.env['DATABASE_URL'];
    if (databaseUrl) args.push('-e', `DATABASE_URL=${databaseUrl}`);
  }

  // Repo-specific env vars
  args.push('-e', `REPO_CONFIG=${config.repoKey}`);
  args.push('-e', `REPO_URL=${config.repo.url}`);
  args.push('-e', `REPO_BRANCH=${config.repo.branch}`);
  args.push('-e', 'SESSION_ROOT=/workspace/session');

  // Image + command
  args.push(config.imageName);
  args.push(config.command);
  if (config.command === 'review-pr') {
    args.push(...(config.extraArgs ?? []));
  } else {
    args.push('--work-item', String(config.workItemId));
  }

  return args;
}

/**
 * Create a docker volume by exact name. Low-level primitive — prefer
 * `createWorkspaceVolume` for the `wi-{id}` naming convention; call this
 * directly only when a caller uses its own naming scheme (e.g. PR review's
 * `pr-review-{prId}`) and still wants to share the spawn logic.
 */
export async function createVolume(name: string): Promise<void> {
  const proc = Bun.spawn(['docker', 'volume', 'create', name], {
    stdout: 'pipe', stderr: 'pipe',
  });
  await proc.exited;
  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to create volume ${name}: ${stderr}`);
  }
}

/** Remove a docker volume by exact name. Ignores errors — volume may not exist. */
export async function removeVolume(name: string): Promise<void> {
  const proc = Bun.spawn(['docker', 'volume', 'rm', '-f', name], {
    stdout: 'pipe', stderr: 'pipe',
  });
  await proc.exited;
}

/** Remove a docker container by exact name. Ignores errors — container may not exist. */
export async function removeContainer(name: string): Promise<void> {
  const proc = Bun.spawn(['docker', 'rm', '-f', name], {
    stdout: 'pipe', stderr: 'pipe',
  });
  await proc.exited;
}

/**
 * Create a workspace volume for a work item.
 */
export async function createWorkspaceVolume(workItemId: number): Promise<string> {
  const volumeName = `wi-${workItemId}`;
  await createVolume(volumeName);
  return volumeName;
}

/**
 * Remove a workspace volume.
 */
export async function removeWorkspaceVolume(workItemId: number): Promise<void> {
  await removeVolume(`wi-${workItemId}`);
}

/**
 * Remove any stale container with the given work item ID.
 */
export async function removeStaleContainer(workItemId: number): Promise<void> {
  await removeContainer(`wi-${workItemId}`);
}

/**
 * Spawn a pipeline container and return a promise that resolves with the exit code.
 */
export async function spawnContainer(args: string[]): Promise<number> {
  const proc = Bun.spawn(['docker', ...args], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await proc.exited;
}

/**
 * Rewrite a host-facing DATABASE_URL for use INSIDE a spawned container.
 *
 * `.env` points at `localhost:5432` because that is correct for anything run on
 * the host. Handing that value to a container points the container at itself:
 * the work completes, the store swallows the connection failure, and nothing is
 * ever written. The watcher never hits this — it runs inside compose and already
 * holds `postgres:5432` — so only host-launched tooling needs the rewrite.
 *
 * Learned the expensive way: eight PR-review arms ran to completion against an
 * unreachable database. ~$60, zero rows, and nothing in the logs to say so.
 */
export function containerDatabaseUrl(hostUrl: string, service = 'postgres'): string {
  if (!hostUrl) return hostUrl;
  return hostUrl.replace(
    /@(localhost|127\.0\.0\.1|host\.docker\.internal)(:\d+)?/,
    (_m, _h, port) => `@${service}${port ?? ''}`,
  );
}
