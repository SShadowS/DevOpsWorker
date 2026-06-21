import { describe, test, expect } from 'bun:test';
import { buildDockerArgs } from '../../src/sdk/docker.ts';
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
});
