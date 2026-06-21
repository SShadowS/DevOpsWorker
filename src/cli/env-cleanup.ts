import { connectStores } from '../db/connect-stores.ts';
import { loadManifest } from '../overlay/index.ts';

// ---------------------------------------------------------------------------
// env-cleanup — destroy a BC environment for a completed work item
// ---------------------------------------------------------------------------

export async function envCleanup(args: string[]): Promise<void> {
  const wiIdx = args.indexOf('--work-item');
  if (wiIdx === -1 || !args[wiIdx + 1]) {
    console.error('Usage: pipeline env-cleanup --work-item <id>');
    process.exit(1);
  }
  const workItemId = parseInt(args[wiIdx + 1]!, 10);

  const { stateStore } = await connectStores();
  const state = await stateStore.load(workItemId);

  if (!state?.environment?.envId) {
    console.log(`No BC environment found for WI-${workItemId}`);
    return;
  }

  const envId = state.environment.envId;

  const config = await stateStore.loadConfig(workItemId);
  const ep = config ? (await loadManifest()).envProvider?.({ config }) : undefined;
  if (!ep) {
    console.log('No env provider configured (no overlay) — skipping environment cleanup');
    return;
  }

  try {
    console.log(`Stopping environment ${envId}...`);
    await ep.stopEnv(envId);

    console.log(`Deleting environment ${envId}...`);
    await ep.deleteEnv(envId);

    // Clear environment from persisted state so re-runs don't re-attempt cleanup
    await stateStore.save(workItemId, { ...state, environment: undefined });
    console.log(`Environment ${envId} cleaned up`);
  } catch (err) {
    console.error(`Cleanup failed: ${err}`);
    process.exit(1);
  }
}
