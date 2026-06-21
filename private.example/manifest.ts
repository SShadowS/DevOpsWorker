import type { OverlayManifest } from '../src/overlay/public-api.ts';
import { exampleRepos } from './config/repos.ts';

/**
 * Example overlay manifest. Copy `private.example/` → `private/` and edit.
 * Only `repos` is populated here; the commented fields show the other injection
 * points. The core loads this file's default export at startup.
 */
const manifest: OverlayManifest = {
  // ADD: merged into the core's empty repo registry.
  repos: exampleRepos,

  // ADD: proprietary companion repos (core ships only the public `BC`).
  // companions: {
  //   'YourDep': { url: 'https://dev.azure.com/your-org/.../_git/Your%20Dep', defaultBranch: 'main', readOnly: true },
  // },

  // OVERRIDE: per-agent model selection (by agent name).
  // models: { coder: 'claude-sonnet-4-6', planner: 'claude-opus-4-8' },

  // ADO defaults (when not using per-repo registration).
  // ado: { organization: 'your-org', project: 'Your Project' },

  // Declarative pipeline edits — inject your proprietary stages, anchored by the
  // stable name of an existing core stage. Built from the live config/repo.
  // pipeline: ({ config, repo }) =>
  //   repo?.envProvision
  //     ? [{ op: 'insertAfter', anchor: 'checkpoint:plan-approved', stage: myEnvProvisionStage(config) }]
  //     : [],

  // Your BC test-environment backend (start/stop/delete/share + reprovision).
  // Used by the watcher's env actions + env-cleanup. Absent → those are no-ops.
  // envProvider: ({ config }) => ({
  //   startEnv:   (envId, stage) => myCli.start(envId),
  //   stopEnv:    (envId, opts, stage) => myCli.stop(envId, opts?.strict),
  //   deleteEnv:  (envId, opts, stage) => myCli.delete(envId, opts?.strict),
  //   shareEnv:   (envId, email, stage) => myCli.share(envId, email),
  //   reprovision: (workItemId, state, cfg, store) => myReprovision(workItemId, state, cfg, store),
  // }),
};

export default manifest;
