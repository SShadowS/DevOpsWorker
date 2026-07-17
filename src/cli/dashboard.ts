import { startDashboard } from '../dashboard/server.ts';
import { connectStores } from '../db/connect-stores.ts';

// ---------------------------------------------------------------------------
// pipeline dashboard [--port <n>]
// ---------------------------------------------------------------------------

export async function dashboard(args: string[]): Promise<void> {
  let port = 3000;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
      port = parseInt(args[++i]!, 10);
      if (isNaN(port)) {
        console.error('Error: --port must be a number');
        process.exit(1);
      }
    }
  }

  const { stateStore, actionStore, runnerStatus, logSink, prReviewStore, prReviewLogSink } = await connectStores();

  startDashboard({ port, stateStore, actionStore, runnerStatus, logSink, prReviewStore, prReviewLogSink });
}
