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
  const { loadManifest, applyOverlayRegistries } = await import('../overlay/index.ts');
  const overlay = await loadManifest();
  applyOverlayRegistries(overlay);
  const repoCount = Object.keys(overlay.repos ?? {}).length;
  if (repoCount > 0) console.log(`[overlay] registered ${repoCount} repo(s) from private overlay`);

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
    case 'review-pr': {
      const { reviewPR } = await import('./review-pr.ts');
      await reviewPR(args.slice(1));
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

Options:
  --work-item, -w   Azure DevOps work item ID (required for run/continue/status)
  --session, -s     Session root path (required for run)
  --port, -p        Dashboard port (default: 3000) / PR ID (for learn-rules)
  --state-dir, -d   State directory (default: .pipeline/state)
  --interval        Polling interval in minutes (default: 15, watch only)
  --pr              Pull request ID (required for learn-rules)
      `);
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('Pipeline error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
