/**
 * Row ⇄ object mapping for `finding_outcomes`. Pure aside from a diagnostic
 * `console.warn` — no database or network I/O, no `sql` handle.
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

/** Runtime mirror of `SaidLabel`'s members — keep in sync with the type above;
 *  TypeScript cannot check the two against each other because the union does
 *  not exist at runtime. */
export const SAID_LABELS: readonly SaidLabel[] =
  ['fixed', 'rejected-wrong', 'rejected-wontfix', 'deferred', 'ignored', 'unclear'];

/** Runtime mirror of `DidLabel`'s members. `SPLIT` is a real, live value —
 *  the tally stores it whenever the ballots do not reach a majority — so
 *  omitting it here would null out genuine rows, not just malformed ones.
 *  Keep in sync with the type above. */
export const DID_LABELS: readonly DidLabel[] = ['ADDRESSED', 'not', 'UNKNOWN', 'SPLIT'];

const SAID_LABEL_SET: ReadonlySet<SaidLabel> = new Set(SAID_LABELS);
const DID_LABEL_SET: ReadonlySet<DidLabel> = new Set(DID_LABELS);

/** Distinct "<column>:<value>" pairs already warned about, so a batch of rows
 *  sharing one bad value warns once — not once per row. Keyed by column so
 *  the (disjoint, but not provably so at runtime) said/did label domains can
 *  never collide. Module-level and never reset: the question it answers is
 *  "has anyone been told about this value yet", for the life of the process. */
const warnedUnknownLabels = new Set<string>();

/**
 * A database string types as a valid label just by being a string — an
 * unexpected value here would otherwise flow straight into the dashboard's
 * denominators, silently joining a rate or slipping past a filter. Map
 * anything outside the known set to `null`, which already has a defined
 * meaning ("not judged" / "no ballot"). But warn once per distinct
 * unrecognised value: silently nulling a REAL label would be a different,
 * worse failure than the one this guards against, so the substitution must
 * stay visible somewhere.
 *
 * `legal` is typed `ReadonlySet<T>`, not `ReadonlySet<string>`, so pairing
 * the wrong label set with the wrong `column`/type argument (e.g. a
 * `DID_LABEL_SET` passed for a call typed `<SaidLabel>`) is a compile error,
 * not a silent runtime gap — the same class of mistake this function exists
 * to catch, one level up.
 */
function validateLabel<T extends string>(
  value: string | null,
  legal: ReadonlySet<T>,
  column: string,
): T | null {
  if (value === null) return null;
  if (legal.has(value as T)) return value as T;
  const key = `${column}:${value}`;
  if (!warnedUnknownLabels.has(key)) {
    warnedUnknownLabels.add(key);
    console.warn(
      `[finding-outcome-mapper] unrecognised ${column} value ${JSON.stringify(value)} in finding_outcomes; mapping to null`,
    );
  }
  return null;
}

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
    said: validateLabel<SaidLabel>(str(row['said']), SAID_LABEL_SET, 'said'),
    saidQuote: str(row['said_quote']),
    saidEvidence: str(row['said_evidence']),
    saidConfidence: str(row['said_confidence']),
    saidVotes: arr(row['said_votes']),
    saidBatchId: str(row['said_batch_id']),
    saidModelVerified: row['said_model_verified'] == null ? null : Boolean(row['said_model_verified']),
    did: validateLabel<DidLabel>(str(row['did']), DID_LABEL_SET, 'did'),
    didConfidence: str(row['did_confidence']),
    didVotes: arr(row['did_votes']),
    filesRead: arr(row['files_read']),
    modelVerified: row['model_verified'] == null ? null : Boolean(row['model_verified']),
    batchId: str(row['batch_id']),
  };
}
