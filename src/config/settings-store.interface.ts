/**
 * Backing store for operator-editable deployment settings (default model,
 * per-agent knobs, budgets, runner concurrency, etc.) — one row per key.
 * `actor` is the email of the operator making the change, written to
 * `updated_by` for the audit trail; null when the caller has no authenticated
 * user (e.g. a startup seed).
 */
export interface ISettingsStore {
  getAll(): Promise<Record<string, unknown>>;
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, actor: string | null): Promise<void>;
  delete(key: string): Promise<void>;
}
