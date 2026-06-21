import type { RepoRegistry } from '../../src/overlay/public-api.ts';

/** Example repo registrations — merged into the core's empty registry by the
 *  manifest. Replace with your real repos. `active: true` makes the watcher poll
 *  the repo's area path for work items. */
export const exampleRepos: RepoRegistry = {
  'my-app': {
    active: true,
    url: 'https://dev.azure.com/your-org/Your%20Project/_git/Your%20Repo',
    branch: 'main',
    azureDevOps: {
      project: 'Your Project',
      repositoryId: '00000000-0000-0000-0000-000000000000',
      repositoryName: 'Your Repo',
      ciPipelineId: 0,
      cdPipelineId: 0,
      areaPath: 'Your Project\\Your Area',
      iterationPath: 'Your Project\\Your Area',
    },
    // Presence of `envProvision` enables the env-provision stage — but only if the
    // overlay also supplies an `envProvider` + a `pipeline` injection. Omit for a
    // pipeline with no ephemeral BC environment.
    testCases: true,
    repoKey: 'YourApp',
    companions: {
      // 'BC' resolves to the public Microsoft BC code-history mirror.
      'BC': {},
    },
    layout: { appRoot: 'Cloud', source: 'Cloud', testAppRoot: 'Test', test: 'Test/Src' },
  },
};
