import { connectDatabase } from './postgres.ts';
import { PgStateStore } from './pg-state-store.ts';
import { PgLogSink } from './pg-log-sink.ts';
import { PgActionStore } from './pg-action-store.ts';
import { PgRunnerStatus } from './pg-runner-status.ts';
import { PgWebhookEventStore } from './pg-webhook-event-store.ts';
import { PgPRReviewStore } from './pg-pr-review-store.ts';
import { PgPrReviewLogSink } from './pg-pr-review-log-sink.ts';
import { PgUserStore } from './pg-user-store.ts';
import { PgSessionStore } from './pg-session-store.ts';
import { PgAuthEventStore } from './pg-auth-event-store.ts';

export async function connectStores() {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL environment variable is required');
  const sql = await connectDatabase(url);
  return {
    sql,
    stateStore: new PgStateStore(sql),
    actionStore: new PgActionStore(sql),
    runnerStatus: new PgRunnerStatus(sql),
    webhookEventStore: new PgWebhookEventStore(sql),
    prReviewStore: new PgPRReviewStore(sql),
    userStore: new PgUserStore(sql),
    sessionStore: new PgSessionStore(sql),
    authEventStore: new PgAuthEventStore(sql),
    logSink: (workItemId: number) => new PgLogSink(sql, workItemId),
    prReviewLogSink: (prId: number, reviewRunId: string) => new PgPrReviewLogSink(sql, prId, reviewRunId),
  };
}
