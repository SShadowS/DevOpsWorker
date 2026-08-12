import type { RepoConfig, RepoRegistry } from './repo-config.ts';
import type { CompanionDef } from './companions.ts';

/** Companion registry keyed by companion key — same shape as RepoRegistry for repos. */
export type CompanionRegistry = Record<string, CompanionDef>;

/**
 * Backing store for the repo and companion registries. Replaces the static,
 * code-edit-and-restart lists in repo-config.ts / companions.ts with a
 * per-row PostgreSQL table so an operator can register a repo or companion
 * live. `actor` is the email of the operator making the change, written to
 * `updated_by` for the audit trail; null when the caller has no authenticated
 * user (e.g. a startup seed).
 */
export interface IRegistryStore {
  listRepos(): Promise<RepoRegistry>;
  getRepo(key: string): Promise<RepoConfig | null>;
  upsertRepo(key: string, config: RepoConfig, actor: string | null): Promise<void>;
  deleteRepo(key: string): Promise<void>;
  countRepos(): Promise<number>;

  listCompanions(): Promise<CompanionRegistry>;
  getCompanion(key: string): Promise<CompanionDef | null>;
  upsertCompanion(key: string, config: CompanionDef, actor: string | null): Promise<void>;
  deleteCompanion(key: string): Promise<void>;
  countCompanions(): Promise<number>;
}
