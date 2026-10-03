import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDockerArgs, readContainerMemoryPeakMb } from '../../src/sdk/docker.ts';
import type { ContainerConfig } from '../../src/sdk/docker.ts';
import type { RepoConfig } from '../../src/config/repo-config.ts';

const testRepo: RepoConfig = {
  url: 'https://dev.azure.com/test/_git/Repo',
  branch: 'main',
  azureDevOps: { project: 'Test', repositoryId: 'id', repositoryName: 'Repo', areaPath: 'Test' },
  repoKey: 'Repo',
  companions: {},
  layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
};

describe('buildDockerArgs', () => {
  test('builds correct docker run args for fresh run', () => {
    const config: ContainerConfig = {
      workItemId: 123,
      repoKey: 'test-repo',
      repo: testRepo,
      command: 'run',
      env: { AZURE_DEVOPS_PAT: 'pat123', CLAUDE_CODE_OAUTH_TOKEN: 'token' },
      stateVolume: 'devopsworker-state',
      workspaceVolume: 'wi-123',
      imageName: 'devopsworker:latest',
    };

    const args = buildDockerArgs(config);

    expect(args).toContain('--name');
    expect(args).toContain('wi-123');
    expect(args.join(' ')).toContain('REPO_CONFIG=test-repo');
    expect(args.join(' ')).toContain('REPO_URL=https://dev.azure.com/test/_git/Repo');
    expect(args.join(' ')).toContain('REPO_BRANCH=main');
    expect(args.join(' ')).toContain('SESSION_ROOT=/workspace/session');
    // Pipeline command appears after image name
    const imageIdx = args.indexOf('devopsworker:latest');
    expect(args[imageIdx + 1]).toBe('run');
    expect(args).toContain('--work-item');
    expect(args).toContain('123');
  });

  test('mounts the private overlay into the container when HOST_PRIVATE_DIR is set', () => {
    const prev = process.env['HOST_PRIVATE_DIR'];
    process.env['HOST_PRIVATE_DIR'] = '/host/repo/private';
    try {
      const config: ContainerConfig = {
        workItemId: 1, repoKey: 'test', repo: testRepo, command: 'run',
        env: {}, stateVolume: 'state', workspaceVolume: 'wi-1', imageName: 'devopsworker:latest',
      };
      const args = buildDockerArgs(config);
      expect(args.join(' ')).toContain('-v /host/repo/private:/app/private:ro');
      expect(args.join(' ')).toContain('PRIVATE_DIR=/app/private');
    } finally {
      if (prev === undefined) delete process.env['HOST_PRIVATE_DIR'];
      else process.env['HOST_PRIVATE_DIR'] = prev;
    }
  });

  test('omits the overlay mount when HOST_PRIVATE_DIR is unset (public-safe default)', () => {
    const prev = process.env['HOST_PRIVATE_DIR'];
    delete process.env['HOST_PRIVATE_DIR'];
    try {
      const config: ContainerConfig = {
        workItemId: 2, repoKey: 'test', repo: testRepo, command: 'run',
        env: {}, stateVolume: 'state', workspaceVolume: 'wi-2', imageName: 'devopsworker:latest',
      };
      const args = buildDockerArgs(config);
      expect(args.join(' ')).not.toContain('/app/private');
    } finally {
      if (prev !== undefined) process.env['HOST_PRIVATE_DIR'] = prev;
    }
  });

  test('caps container memory when DO_CONTAINER_MEMORY is set', () => {
    const prev = process.env['DO_CONTAINER_MEMORY'];
    process.env['DO_CONTAINER_MEMORY'] = '2g';
    try {
      const config: ContainerConfig = {
        workItemId: 3, repoKey: 'test', repo: testRepo, command: 'run',
        env: {}, stateVolume: 'state', workspaceVolume: 'wi-3', imageName: 'devopsworker:latest',
      };
      const args = buildDockerArgs(config);
      const memIdx = args.indexOf('--memory');
      expect(memIdx).toBeGreaterThan(-1);
      expect(args[memIdx + 1]).toBe('2g');
      // A docker run option: must come before the image name, or docker passes it to the container.
      expect(memIdx).toBeLessThan(args.indexOf('devopsworker:latest'));
    } finally {
      if (prev === undefined) delete process.env['DO_CONTAINER_MEMORY'];
      else process.env['DO_CONTAINER_MEMORY'] = prev;
    }
  });

  test('sets no memory cap when DO_CONTAINER_MEMORY is unset', () => {
    const prev = process.env['DO_CONTAINER_MEMORY'];
    delete process.env['DO_CONTAINER_MEMORY'];
    try {
      const config: ContainerConfig = {
        workItemId: 4, repoKey: 'test', repo: testRepo, command: 'run',
        env: {}, stateVolume: 'state', workspaceVolume: 'wi-4', imageName: 'devopsworker:latest',
      };
      expect(buildDockerArgs(config)).not.toContain('--memory');
    } finally {
      if (prev !== undefined) process.env['DO_CONTAINER_MEMORY'] = prev;
    }
  });

  test('uses continue command for checkpoint resume', () => {
    const config: ContainerConfig = {
      workItemId: 789,
      repoKey: 'test',
      repo: testRepo,
      command: 'continue',
      env: { AZURE_DEVOPS_PAT: 'pat' },
      stateVolume: 'state',
      workspaceVolume: 'wi-789',
      imageName: 'devopsworker:latest',
    };

    const args = buildDockerArgs(config);
    // The pipeline command (after image name) should be 'continue'
    const imageIdx = args.indexOf('devopsworker:latest');
    expect(args[imageIdx + 1]).toBe('continue');
  });

  test('omits repo coordinates for reflect (no clone) and passes --cycle-date via extraArgs', () => {
    const config: ContainerConfig = {
      workItemId: 0,
      command: 'reflect',
      env: { DATABASE_URL: 'postgres://x' },
      stateVolume: 'state',
      workspaceVolume: 'reflection-2026-08-15',
      imageName: 'devopsworker:latest',
      extraArgs: ['--cycle-date', '2026-08-15'],
    };

    const args = buildDockerArgs(config);

    expect(args.join(' ')).not.toContain('REPO_CONFIG=');
    expect(args.join(' ')).not.toContain('REPO_URL=');
    expect(args.join(' ')).not.toContain('REPO_BRANCH=');
    expect(args).not.toContain('--work-item');

    const imageIdx = args.indexOf('devopsworker:latest');
    expect(args[imageIdx + 1]).toBe('reflect');
    expect(args[imageIdx + 2]).toBe('--cycle-date');
    expect(args[imageIdx + 3]).toBe('2026-08-15');
  });
});

describe('readContainerMemoryPeakMb', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-peak-'));

  test('reads the cgroup peak in bytes and returns whole MiB', () => {
    const file = join(dir, 'memory.peak');
    writeFileSync(file, '508559360\n'); // 485 MiB
    expect(readContainerMemoryPeakMb(file)).toBe(485);
  });

  test('returns null when the file does not exist (not in a cgroup v2 container)', () => {
    expect(readContainerMemoryPeakMb(join(dir, 'missing'))).toBeNull();
  });

  test('returns null when the file holds something other than a number', () => {
    const file = join(dir, 'garbage');
    writeFileSync(file, 'max\n');
    expect(readContainerMemoryPeakMb(file)).toBeNull();
  });
});
