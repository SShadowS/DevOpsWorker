import type postgres from 'postgres';
import type { IWebhookEventStore } from '../pipeline/webhook-event-store.interface.ts';

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

  async hasMatchingAction(workItemId: number, type: string, matchKey: string, matchValue: string, pendingOnly = true): Promise<boolean> {
    // The payload column stores JSON like {"feedback":"...inner JSON..."}.
    // The inner feedback string is itself JSON, so we extract it and cast to JSONB
    // to reach nested keys (e.g., commentKey, prId inside the feedback JSON).
    const rows = pendingOnly
      ? await this.sql`
          SELECT 1 FROM actions
          WHERE work_item_id = ${workItemId} AND type = ${type}
            AND consumed_at IS NULL
            AND (payload::jsonb->>'feedback')::jsonb->>${matchKey} = ${matchValue}
          LIMIT 1`
      : await this.sql`
          SELECT 1 FROM actions
          WHERE work_item_id = ${workItemId} AND type = ${type}
            AND (payload::jsonb->>'feedback')::jsonb->>${matchKey} = ${matchValue}
          LIMIT 1`;
    return rows.length > 0;
  }
}
