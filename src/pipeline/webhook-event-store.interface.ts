import type { PipelineAction } from '../dashboard/actions.ts';

export interface IWebhookEventStore {
  persistEvent(eventType: string, payload: string, error?: string): Promise<void>;
  cleanupOldEvents(): Promise<number>;
  /**
   * Queue `action` unless a matching one exists (pendingOnly=true: only unconsumed actions
   * count). Check and insert are atomic, so simultaneous calls queue one action.
   * Returns the new action's id, or null when a match already existed.
   */
  queueUnlessMatching(action: PipelineAction, matchKey: string, matchValue: string, pendingOnly: boolean): Promise<number | null>;
}
