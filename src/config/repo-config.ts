/**
 * Configuration for a target repository that the pipeline can operate on.
 * Presence of optional fields enables the corresponding pipeline stages.
 */
export interface RepoConfig {
  /** Whether this repo is ready for pipeline processing. Inactive repos are ignored by the watcher. */
  active?: boolean;
  /** Auto-review PRs on creation. Omitted/true = review every new PR. Set false for "passive"
   *  mode: the repo is registered (so /review comments and the CLI still trigger reviews), but
   *  the webhook does NOT auto-review on PR creation. Only consulted by the webhook server. */
  autoReview?: boolean;
  /** Auto-review draft PRs. Omitted/false = drafts are skipped on creation (default for all repos).
   *  Set true to auto-review PRs created in draft state. Only consulted by the webhook server for
   *  PR-creation events; explicit /review comments and the CLI review drafts regardless. */
  reviewDrafts?: boolean;
  /** Git clone URL */
  url: string;
  /** Branch to work from (e.g., 'master', 'main') */
  branch: string;
  /** Azure DevOps settings for this repo */
  azureDevOps: {
    organization?: string;
    orgUrl?: string;
    project: string;
    repositoryId: string;
    repositoryName: string;
    ciPipelineId?: number;
    cdPipelineId?: number;
    areaPath: string;
    iterationPath?: string;
  };
  /** BC environment provisioning — presence enables the env-provision stage */
  envProvision?: {
    /** Operator override: pin a specific environment profile GUID. When set, the resolver
     *  skips the environment profile portal lookup. Use to freeze BC version during a regression hunt or
     *  customer-specific test. Omit to use automatic detection (recommended). */
    profileId?: string;

    /** Operator override: pin a specific BC version (e.g. '28.0.0.0'). The resolver
     *  picks the regional profile for this version instead of "highest >= platform". */
    bcVersion?: string;

    /** Regional profile to pick (e.g. 'GB', 'DE'). Default: 'GB'. */
    region?: string;

    /** Override for cred selection. Falls back to flag-based selection, then to user 'Tll'. */
    bcUser?: string;

    /** Per-app wizard instructions; presence enables the bc-activation stage. */
    wizard?: {
      instructions: string;
    };
  };
  /** Test case stages — presence enables test-cases + test-case-activation stages */
  testCases?: boolean;
  /** Docs writer stage — presence enables it */
  docsWriter?: {
    docsRepoUrl: string;
  };

  /** Key into companionRegistry — also the directory name under session root */
  repoKey: string;

  /** Companion repos — keys are companionRegistry entries, values are optional overrides */
  companions: Record<string, { branch?: string; readOnly?: boolean }>;

  /** Directory layout within the target repo */
  layout: {
    /** App root for deployment — directory containing app.json (e.g., 'Cloud') */
    appRoot: string;
    /** Path to production AL source (e.g., 'Cloud/Al') */
    source: string;
    /** App root for test extension (e.g., 'Test') */
    testAppRoot: string;
    /** Path to test AL source (e.g., 'Test/Src') */
    test: string;
  };
}

/** Central registry type — keys are repo identifiers (e.g., 'document-output') */
export type RepoRegistry = Record<string, RepoConfig>;
