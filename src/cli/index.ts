#!/usr/bin/env bun

// ---------------------------------------------------------------------------
// CLI router — pipeline run | continue | status
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  // Set agent-runtime env (e.g. CLAUDE_CODE_DISABLE_BACKGROUND_TASKS) before any
  // command that might run an agent. Every CLI command is dispatched from here,
  // so a single call covers run/continue/diagnose/review-pr/watch's spawned
  // containers (which re-enter this same main() in their own process). Explicit
  // rather than an import-time side effect in run-agent.ts, so tests that import
  // its pure helpers don't get process-global env mutated on them.
  const { initAgentRuntime } = await import('../sdk/run-agent.ts');
  initAgentRuntime();

  // Load the private overlay (if any) and populate the repo/companion registries
  // before any command runs. Public core ships empty registries; the overlay
  // supplies the real ones. Idempotent + cheap (manifest load is memoised).
  const { loadManifest } = await import('../overlay/index.ts');
  const overlay = await loadManifest();
  const repoCount = Object.keys(overlay.repos ?? {}).length;
  if (repoCount > 0) console.log(`[overlay] registered ${repoCount} repo(s) from private overlay`);

  // Then let the database win over the manifest wherever it has its own
  // data — every process (watcher, dashboard, webhook-server, and every
  // spawned container, which re-enters this same main()) reads the registry
  // this populates. Never throws: a database problem here must not block a
  // command that doesn't even need the database (--help, diagnose).
  //
  // Deliberately a SMALL retry budget, unlike the 10-attempt/2s-backoff
  // default connectStores() otherwise gives every real DB-dependent command:
  // this connection is optional (a missing/unreachable database just means
  // "run on the manifest alone"), so a command with DATABASE_URL pointing at
  // nothing running should fail this fast, not spend ~20s finding that out
  // before it even gets to work that doesn't need the database at all. Any
  // command that DOES need the database still gets the full retry budget —
  // this only bounds the extra, optional hydration step added here.
  const { hydrateStartupRegistry } = await import('../config/hydrate-startup.ts');
  const { connectStores } = await import('../db/connect-stores.ts');
  await hydrateStartupRegistry(overlay, {
    connectStores: () => connectStores({ maxRetries: 2, retryDelayMs: 500 }),
  });

  switch (command) {
    case 'run': {
      const { run } = await import('./run.ts');
      await run(args.slice(1));
      break;
    }
    case 'continue': {
      const { cont } = await import('./continue.ts');
      await cont(args.slice(1));
      break;
    }
    case 'status': {
      const { status } = await import('./status.ts');
      await status(args.slice(1));
      break;
    }
    case 'dashboard': {
      const { dashboard } = await import('./dashboard.ts');
      await dashboard(args.slice(1));
      break;
    }
    case 'diagnose': {
      const { diagnose } = await import('./diagnose.ts');
      await diagnose(args.slice(1));
      break;
    }
    case 'watch': {
      const { watch } = await import('./watch.ts');
      await watch(args.slice(1));
      break;
    }
    case 'env-cleanup': {
      const { envCleanup } = await import('./env-cleanup.ts');
      await envCleanup(args.slice(1));
      break;
    }
    case 'learn-rules': {
      const { learnRules } = await import('./learn-rules.ts');
      await learnRules(args.slice(1));
      break;
    }
    case 'webhook-server': {
      const { webhookServer } = await import('./webhook-server.ts');
      await webhookServer(args.slice(1));
      break;
    }
    case 'subagent-stats': {
      const { subagentStats } = await import('./subagent-stats.ts');
      await subagentStats(args.slice(1));
      break;
    }
    case 'review-pr': {
      const { reviewPR } = await import('./review-pr.ts');
      await reviewPR(args.slice(1));
      break;
    }
    case 'admin': {
      const { admin } = await import('./admin.ts');
      await admin(args.slice(1));
      break;
    }
    default:
      console.log(`
DevOps Pipeline CLI

Usage:
  pipeline run         --work-item <id> --session <path>   Start a new pipeline run
  pipeline continue    --work-item <id>                    Resume from checkpoint or failure
  pipeline status      --work-item <id>                    Show current pipeline status
  pipeline dashboard   [--port <n>] [--state-dir <path>]   Launch live web dashboard
  pipeline diagnose    [--session <path>]                  Run LSP/MCP/tool diagnostics
  pipeline watch       [--interval <minutes>]              Poll for work items and auto-run
  pipeline env-cleanup --work-item <id>                    Destroy BC environment for a work item
  pipeline learn-rules --pr <pr-id>                        Learn review patterns from PR comments
  pipeline webhook-server [--port <n>]                     Start webhook receiver
  pipeline review-pr     --pr-id <id> --repo-id <guid>    Review a pull request
  pipeline subagent-stats [--limit <n>] [--repo <key>]     Per-sub-agent cost/turns across reviews + pipeline runs
  pipeline admin create-user  --email <x> [--role admin|operator] [--display-name <n>] [--password-stdin]
  pipeline admin set-password --email <x> [--password-stdin]
  pipeline admin list-users

Options:
  --work-item, -w   Azure DevOps work item ID (required for run/continue/status)
  --session, -s     Session root path (required for run)
  --port, -p        Dashboard port (default: 3000) / PR ID (for learn-rules)
  --state-dir, -d   State directory (default: .pipeline/state)
  --interval        Polling interval in minutes (default: 15, watch only)
  --pr              Pull request ID (required for learn-rules)
  --limit, -n       Reviews to scan (default: 50, subagent-stats only)
  --repo, -r        Restrict to one repo key (subagent-stats only)
  --source          reviews | pipeline | all (default: all, subagent-stats only)
  --json            Machine-readable output (subagent-stats only)
      `);
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('Pipeline error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
