import { connectDatabase } from './postgres.ts';
import { PgStateStore } from './pg-state-store.ts';
import { PgLogSink } from './pg-log-sink.ts';
import { PgActionStore } from './pg-action-store.ts';
import { PgRunnerStatus } from './pg-runner-status.ts';
import { PgWebhookEventStore } from './pg-webhook-event-store.ts';
import { PgPRReviewStore } from './pg-pr-review-store.ts';

export async function connectStores() {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL environment variable is required');
  const sql = await connectDatabase(url);
  return {
    stateStore: new PgStateStore(sql),
    actionStore: new PgActionStore(sql),
    runnerStatus: new PgRunnerStatus(sql),
    webhookEventStore: new PgWebhookEventStore(sql),
    prReviewStore: new PgPRReviewStore(sql),
    logSink: (workItemId: number) => new PgLogSink(sql, workItemId),
  };
}
