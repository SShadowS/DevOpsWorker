/**
 * Row ⇄ object mapping for `reflection_proposals`. Pure aside from a diagnostic
 * console.warn — no database or network I/O. Kept in core for the same reason as
 * finding-outcome-mapper.ts: the table shape is generic, the writer's content is
 * deployment data, and the dashboard must read the table without the overlay.
 */

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'superseded';
export const PROPOSAL_STATUSES: readonly ProposalStatus[] =
  ['pending', 'approved', 'rejected', 'applied', 'superseded'];

export type VerdictLabel = 'reviewer-wrong' | 'human-wrong' | 'both-defensible' | 'unclear';
export type EvidenceType = 'docs' | 'code' | 'branch' | 'needs-measurement' | 'none';

export interface Adjudication {
  prId: number;
  findingKey: string;
  severity: string;
  title: string;
  verdictLabel: VerdictLabel;
  evidenceType: EvidenceType;
  /** What was checked, quoted or named concretely — never a paraphrase of the human. */
  evidence: string | null;
  /** The team's words, verbatim from finding_outcomes.said_quote. */
  humanQuote: string | null;
}

export interface Cluster {
  key: string;
  name: string;
  occurrences: { prId: number; findingKey: string }[];
  barStatus: 'clears' | 'watch';
  barReason: string;
}

export interface ProposedChange {
  target: 'core' | 'overlay';
  file: string;
  unifiedDiff: string;
  rationale: string;
  clusterKey: string;
}

export interface ReflectionProposal {
  id: number;
  /** YYYY-MM-DD anchor of the window. */
  cycleDate: string;
  windowDays: number;
  coverage: { total: number; withSaid: number; pct: number } | null;
  adjudications: Adjudication[];
  clusters: Cluster[];
  proposedChanges: ProposedChange[];
  watchLedger: unknown[] | null;
  classifierNotes: unknown[] | null;
  expectedEffects: { metric: string; from: number; to: number }[] | null;
  logEntryDraft: string | null;
  status: ProposalStatus | null;
  decidedBy: string | null;
  decidedAt: string | null;
  appliedAt: string | null;
  appliedCommits: { core?: string; overlay?: string } | null;
  costUsd: number | null;
  sessionId: string | null;
  error: string | null;
  /** Short core sha baked into the image that produced this proposal
   *  (`process.env.BUILD_SHA`), mirroring `pr_reviews.image_sha` so the
   *  dashboard's drift ribbon can see reflection runs too. Null for rows
   *  written before the column existed or by an image built without the
   *  BUILD_SHA build-arg. */
  imageSha: string | null;
  createdAt: string;
}

const iso = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);
/** DATE columns come back as Date at UTC midnight; the day is the value. */
const day = (v: unknown): string => (iso(v) ?? '').slice(0, 10);
const str = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number | null => (v == null ? null : Number(v));
const arr = <T>(v: unknown): T[] | null => (Array.isArray(v) ? (v as T[]) : null);

const warned = new Set<string>();
function validStatus(v: string | null): ProposalStatus | null {
  if (v === null) return null;
  if ((PROPOSAL_STATUSES as readonly string[]).includes(v)) return v as ProposalStatus;
  if (!warned.has(v)) {
    warned.add(v);
    console.warn(`[reflection-proposal-mapper] unrecognised status ${JSON.stringify(v)}; mapping to null`);
  }
  return null;
}

export function rowToReflectionProposal(row: Record<string, unknown>): ReflectionProposal {
  return {
    id: Number(row['id']),
    cycleDate: day(row['cycle_date']),
    windowDays: Number(row['window_days']),
    coverage: (row['coverage'] as ReflectionProposal['coverage']) ?? null,
    adjudications: arr<Adjudication>(row['adjudications']) ?? [],
    clusters: arr<Cluster>(row['clusters']) ?? [],
    proposedChanges: arr<ProposedChange>(row['proposed_changes']) ?? [],
    watchLedger: arr(row['watch_ledger']),
    classifierNotes: arr(row['classifier_notes']),
    expectedEffects: arr(row['expected_effects']),
    logEntryDraft: str(row['log_entry_draft']),
    status: validStatus(str(row['status'])),
    decidedBy: str(row['decided_by']),
    decidedAt: iso(row['decided_at']),
    appliedAt: iso(row['applied_at']),
    appliedCommits: (row['applied_commits'] as ReflectionProposal['appliedCommits']) ?? null,
    costUsd: num(row['cost_usd']),
    sessionId: str(row['session_id']),
    error: str(row['error']),
    imageSha: str(row['image_sha']),
    createdAt: iso(row['created_at']) ?? '',
  };
}
