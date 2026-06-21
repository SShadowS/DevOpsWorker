export interface IWebhookEventStore {
  persistEvent(eventType: string, payload: string, error?: string): Promise<void> | void;
  cleanupOldEvents(): Promise<number> | number;
  /** Check if a matching action exists. pendingOnly=true checks only unconsumed actions. */
  hasMatchingAction(workItemId: number, type: string, matchKey: string, matchValue: string, pendingOnly?: boolean): Promise<boolean> | boolean;
}
