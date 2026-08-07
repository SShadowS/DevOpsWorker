/**
 * Row ⇄ object mapping for `finding_outcomes`. Pure — no I/O, no `sql` handle.
 *
 * Separate from the sweep that writes these rows because that sweep lives in the private
 * overlay (it imports the repo registry) while the shape of the table is generic. Keeping
 * the mapper here lets the dashboard read the table without depending on the overlay.
 */

/** What the team SAID about a finding, from its thread and the PR discussion. */
export type SaidLabel =
  | 'fixed' | 'rejected-wrong' | 'rejected-wontfix' | 'deferred' | 'ignored' | 'unclear';

/**
 * What the branch DID, judged from the post-review diff. Deliberately coarser than the
 * per-ballot verdict: the four-way verdict reproduced 67% of the time on identical input,
 * this three-way collapse 71%. `SPLIT` means the ballots did not reach a majority.
 */
export type DidLabel = 'ADDRESSED' | 'not' | 'UNKNOWN' | 'SPLIT';

export interface FindingOutcome {
  prId: number;
  findingKey: string;
  repoKey: string;
  severity: string;
  title: string;
  file: string | null;
  firstRaisedAt: string;
  prSettledAt: string | null;
  /** Finding posted → PR merged. The strongest predictor of engagement found so far. */
  leadTimeMins: number | null;
  /** Null both when nothing was judged AND when the ballots tied — `saidConfidence`
   *  is what tells those apart ('none' vs 'split'). */
  said: SaidLabel | null;
  /** A span copied verbatim from a human comment. Only ever written from a ballot
   *  whose quote was checked against the human text, so it is never a sentence the
   *  model composed — the labels that need no quote (`ignored`, `unclear`) store null. */
  saidQuote: string | null;
  saidEvidence: string | null;
  saidConfidence: string | null;
  /** Every said ballot's verdict AS GRADED, including the `ungrounded` sentinel the
   *  tally folds into `unclear`. Storing the graded form (not the tally's votes) is
   *  what keeps the caught-fabrication rate measurable from the table. */
  saidVotes: string[] | null;
  /** The batch that produced the said verdict. Distinct from `batchId`, which
   *  describes the `did` verdict: the two are reached by different batches on
   *  different nights, and one shared column would not merely lose provenance but
   *  MISattribute it — a said verdict sitting beside the id of a batch that asked
   *  no said question. */
  saidBatchId: string | null;
  /** False when the said ballots came back from a model other than the one asked
   *  for. Separate from `modelVerified` for the same reason as `saidBatchId`, and
   *  the stakes are higher: a shared column lets an earlier `true` survive a said
   *  run whose model check failed, on the one column that exists to catch that. */
  saidModelVerified: boolean | null;
  did: DidLabel | null;
  didConfidence: string | null;
  /** Every ballot, not just the winner — a 2-1 split must stay visible to a reader. */
  didVotes: string[] | null;
  filesRead: string[] | null;
  /** False when the batch result's model did not match what was requested. */
  modelVerified: boolean | null;
  batchId: string | null;
}

/** postgres.js hands back `Date` for TIMESTAMPTZ; callers want a stable ISO string. */
const iso = (v: unknown): string | null => {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
};

const str = (v: unknown): string | null => (v == null ? null : String(v));
const num = (v: unknown): number | null => (v == null ? null : Number(v));
const arr = (v: unknown): string[] | null => (Array.isArray(v) ? v.map(String) : null);

export function rowToFindingOutcome(row: Record<string, unknown>): FindingOutcome {
  return {
    prId: Number(row['pr_id']),
    findingKey: String(row['finding_key']),
    repoKey: String(row['repo_key']),
    severity: String(row['severity']),
    title: String(row['title']),
    file: str(row['file']),
    // Non-null in the schema, so the `?? ''` is unreachable in practice — present so a
    // malformed row yields an empty string rather than the literal "null".
    firstRaisedAt: iso(row['first_raised_at']) ?? '',
    prSettledAt: iso(row['pr_settled_at']),
    leadTimeMins: num(row['lead_time_mins']),
    said: str(row['said']) as SaidLabel | null,
    saidQuote: str(row['said_quote']),
    saidEvidence: str(row['said_evidence']),
    saidConfidence: str(row['said_confidence']),
    saidVotes: arr(row['said_votes']),
    saidBatchId: str(row['said_batch_id']),
    saidModelVerified: row['said_model_verified'] == null ? null : Boolean(row['said_model_verified']),
    did: str(row['did']) as DidLabel | null,
    didConfidence: str(row['did_confidence']),
    didVotes: arr(row['did_votes']),
    filesRead: arr(row['files_read']),
    modelVerified: row['model_verified'] == null ? null : Boolean(row['model_verified']),
    batchId: str(row['batch_id']),
  };
}
