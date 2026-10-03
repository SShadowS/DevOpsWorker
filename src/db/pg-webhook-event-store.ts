import type postgres from 'postgres';
import type { IWebhookEventStore } from '../pipeline/webhook-event-store.interface.ts';
import type { PipelineAction } from '../dashboard/actions.ts';

export class PgWebhookEventStore implements IWebhookEventStore {
  constructor(private readonly sql: postgres.Sql) {}

  async persistEvent(eventType: string, payload: string, error?: string): Promise<void> {
    await this.sql`
      INSERT INTO webhook_events (event_type, payload, processed, error)
      VALUES (${eventType}, ${payload}::jsonb, ${!error}, ${error ?? null})
    `;
  }

  async cleanupOldEvents(): Promise<number> {
    const result = await this.sql`
      DELETE FROM webhook_events WHERE created_at < now() - interval '7 days'
    `;
    return result.count;
  }

  async queueUnlessMatching(action: PipelineAction, matchKey: string, matchValue: string, pendingOnly: boolean): Promise<number | null> {
    return this.sql.begin(async (tx) => {
      // Check and insert must not interleave: without this, two webhooks for the same PR
      // arriving together both see "no review yet" and both queue one. The lock is on the
      // name, not a row (there is no row yet), and is released when the transaction ends.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`${action.type}:${matchKey}:${matchValue}`}))`;
      // The payload column stores JSON like {"feedback":"...inner JSON..."}.
      // The inner feedback string is itself JSON, so we extract it and cast to JSONB
      // to reach nested keys (e.g., commentKey, prId inside the feedback JSON).
      const dupe = await tx`
        SELECT 1 FROM actions
        WHERE work_item_id = ${action.workItemId} AND type = ${action.type}
          AND (${!pendingOnly} OR consumed_at IS NULL)
          AND (payload::jsonb->>'feedback')::jsonb->>${matchKey} = ${matchValue}
        LIMIT 1`;
      if (dupe.length > 0) return null;
      const payload = JSON.stringify({ feedback: action.feedback, email: action.email });
      const rows = await tx`
        INSERT INTO actions (work_item_id, type, payload, created_at, status)
        VALUES (${action.workItemId}, ${action.type}, ${payload}, ${action.createdAt}, 'pending')
        RETURNING id`;
      return (rows[0] as { id: number }).id;
    });
  }
}
