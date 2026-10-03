import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import postgres from 'postgres';
import { SCHEMA } from '../../src/db/postgres.ts';
import { PgWebhookEventStore } from '../../src/db/pg-webhook-event-store.ts';

// Deliberately TEST_DATABASE_URL, never DATABASE_URL: these tests write and
// delete rows. Own connection, for the reasons in config-stores.integration.test.ts.
const url = process.env.TEST_DATABASE_URL;

// A work item id no real action uses, so cleanup touches only this file's rows.
const WI = -424242;

function reviewAction(prId: string) {
  return {
    workItemId: WI,
    type: 'review-pr' as const,
    feedback: JSON.stringify({ prId }),
    createdAt: new Date().toISOString(),
  };
}

describe.skipIf(!url)('webhook dedup (integration)', () => {
  let sql: postgres.Sql;
  let store: PgWebhookEventStore;

  beforeAll(async () => {
    sql = postgres(url!, {
      max: 5,
      onnotice: (notice) => {
        if (notice.code === '42P07' || notice.code === '42701') return;
        console.warn(`[postgres] ${notice.severity}: ${notice.message}`);
      },
    });
    await sql.unsafe(SCHEMA);
    store = new PgWebhookEventStore(sql);
  });

  beforeEach(async () => {
    await sql`DELETE FROM actions WHERE work_item_id = ${WI}`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`DELETE FROM actions WHERE work_item_id = ${WI}`;
    await sql.end();
  });

  test('simultaneous webhooks for the same PR queue exactly one review', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.queueUnlessMatching(reviewAction('777'), 'prId', '777', true)),
    );
    expect(results.filter((id) => id !== null)).toHaveLength(1);
    const rows = await sql`SELECT id FROM actions WHERE work_item_id = ${WI}`;
    expect(rows).toHaveLength(1);
  });

  test('pendingOnly lets a new review through once the previous one is consumed', async () => {
    const first = await store.queueUnlessMatching(reviewAction('778'), 'prId', '778', true);
    expect(first).not.toBeNull();
    expect(await store.queueUnlessMatching(reviewAction('778'), 'prId', '778', true)).toBeNull();

    await sql`UPDATE actions SET consumed_at = now() WHERE id = ${first!}`;
    expect(await store.queueUnlessMatching(reviewAction('778'), 'prId', '778', true)).not.toBeNull();
    // Without pendingOnly, any earlier review blocks.
    expect(await store.queueUnlessMatching(reviewAction('778'), 'prId', '778', false)).toBeNull();
  });
});
