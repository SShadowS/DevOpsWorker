import postgres from 'postgres';

let _sql: postgres.Sql | undefined;
let _cleanup: (() => void) | undefined;

// Exported so tests that open their own connection (rather than going through
// the connectDatabase() singleton below) can still apply the schema.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS pipeline_state (
  work_item_id  INTEGER PRIMARY KEY,
  state         JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pipeline_config (
  work_item_id  INTEGER PRIMARY KEY,
  config        JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stage_logs (
  id            SERIAL PRIMARY KEY,
  work_item_id  INTEGER NOT NULL,
  stage_name    TEXT NOT NULL,
  entry_type    TEXT NOT NULL,
  content       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stage_logs_wi_stage ON stage_logs (work_item_id, stage_name);
-- Keyset pagination of a stage's log (tail + "load older" both scan this index).
CREATE INDEX IF NOT EXISTS idx_stage_logs_wi_stage_id ON stage_logs (work_item_id, stage_name, id);

-- PR-review attribution (added in pr-reviewer token-reduction plan)
ALTER TABLE stage_logs ADD COLUMN IF NOT EXISTS entity_type   TEXT NOT NULL DEFAULT 'work_item';
ALTER TABLE stage_logs ADD COLUMN IF NOT EXISTS review_run_id TEXT;
ALTER TABLE stage_logs ADD COLUMN IF NOT EXISTS agent_name    TEXT;
CREATE INDEX IF NOT EXISTS idx_stage_logs_run ON stage_logs (review_run_id);

CREATE TABLE IF NOT EXISTS actions (
  id            SERIAL PRIMARY KEY,
  work_item_id  INTEGER NOT NULL,
  type          TEXT NOT NULL,
  payload       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_actions_pending ON actions (consumed_at) WHERE consumed_at IS NULL;

-- Action lifecycle columns (added in tracked-actions migration)
ALTER TABLE actions ADD COLUMN IF NOT EXISTS status        TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE actions ADD COLUMN IF NOT EXISTS started_at    TIMESTAMPTZ;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS completed_at  TIMESTAMPTZ;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS error         TEXT;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS result        JSONB;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'actions_status_check') THEN
    ALTER TABLE actions ADD CONSTRAINT actions_status_check
      CHECK (status IN ('pending','running','completed','failed'));
  END IF;
END $$;
-- Backfill: any pre-existing row with consumed_at set is treated as completed
UPDATE actions SET status = 'completed', completed_at = consumed_at
  WHERE consumed_at IS NOT NULL AND status = 'pending';
CREATE INDEX IF NOT EXISTS idx_actions_status_created ON actions (status, created_at);
CREATE INDEX IF NOT EXISTS idx_actions_wi_created    ON actions (work_item_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runner_status (
  key           TEXT PRIMARY KEY,
  value         JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id            SERIAL PRIMARY KEY,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL,
  processed     BOOLEAN NOT NULL DEFAULT false,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_created ON webhook_events (created_at);

CREATE TABLE IF NOT EXISTS pr_reviews (
  id            SERIAL PRIMARY KEY,
  pr_id         INTEGER NOT NULL,
  repo_key      TEXT NOT NULL,
  source_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  title         TEXT,
  recommendation TEXT,
  findings      JSONB,
  findings_count INTEGER,
  comment_id    INTEGER,
  cost_usd      REAL,
  duration_ms   INTEGER,
  turns         INTEGER,
  tool_calls    JSONB,
  session_id    TEXT,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  action_id     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pr_reviews_created ON pr_reviews (created_at DESC);
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS review_body TEXT;
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS review_run_id TEXT;
-- Per-named-sub-agent usage (turns/tokens/toolCalls/apportioned cost), keyed by
-- subagent_type. tool_calls above is the run total and cannot say which reviewer
-- spent it; this can.
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS sub_agents JSONB;
-- Per-model cost/token split, keyed by model id.
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS model_usage JSONB;
-- Every finding as a structured record ({severity, title, file?, line?, location?, body}[]).
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS findings_list JSONB;
-- Counters from posting Critical/Major findings as inline PR threads. Null when
-- nothing was attempted (noPost mode or no findings), not a zeroed result.
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS inline_threads JSONB;
-- Which reviewer ran: 'sanity:<sourcePrId>' for the cheap backport path, or
-- 'full:<reason>' naming why the full path was chosen. Null for rows recorded
-- before this routing existed.
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS review_path TEXT;
-- File-modification counts from the eval-only PR_REVIEW_* hooks (agent set,
-- routing, scoped payload, BC-only security, sub-agent model override, tool
-- rule) that were ENABLED this run, keyed by lever name. Null for a production
-- review (no lever env var set) or a row recorded before this was captured —
-- deliberately never a map of zeros, which would be indistinguishable from
-- "every enabled lever failed to apply". Lets checkArmCompliance verify that
-- prompt-CONTENT levers (scoped payload, BC-only security) actually took
-- effect, not just that the expected sub-agents dispatched.
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS applied_levers JSONB;
-- The core repo's short HEAD sha baked into the image that produced this
-- review (Dockerfile ARG BUILD_SHA -> ENV BUILD_SHA, set at build time by
-- docker-build.ps1 / docker-compose.yml). Null for rows recorded before this
-- was captured. A container built without the BUILD_SHA build-arg (e.g. a
-- plain docker compose build) bakes the literal string "unknown" rather
-- than leaving the env var unset -- that case reads back as "unknown", not
-- null (see the matching, correct comment on IPRReviewStore's imageSha field
-- in src/pipeline/pr-review-store.interface.ts). Answers "which build
-- produced this row" without needing a docker socket.
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS image_sha TEXT;
-- Marks a run that must not count toward production statistics: an A/B arm or an
-- ad-hoc probe. NOT NULL DEFAULT false on purpose — unlike image_sha, "unmarked"
-- here genuinely means production, so a nullable column would invent a third
-- state the UI would have to explain.
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;
-- What the reviewer noticed WHILE reading, as opposed to what the router decided
-- BEFORE spending: true when the review itself concluded this change is a port of
-- an earlier one. Deliberately a separate column from review_path, which records a
-- deterministic pre-flight decision — folding a model's observation into it would
-- make the one column any cost analysis leans on unfalsifiable.
--
-- Its value is the disagreement. review_path = 'full:not a cherry-pick' beside
-- observed_cherry_pick = true means the router has a blind spot, and it cannot save
-- money on that run because the review has already happened. Nine such rows sat
-- undetected for weeks at about $7 each, with the contradicting evidence in a text
-- column nobody joined against.
--
-- Null means the review predates this field or the reviewer said nothing — never
-- read it as "not a port".
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS observed_cherry_pick BOOLEAN;
-- The source PR the reviewer named, when it managed to identify one. Usually null
-- even when observed_cherry_pick is true: of the nine misses, one review named a
-- source PR in a parseable form. So this cannot drive the cheap path on its own —
-- only the router's pre-flight detection can.
ALTER TABLE pr_reviews ADD COLUMN IF NOT EXISTS observed_cherry_pick_source INTEGER;

CREATE TABLE IF NOT EXISTS finding_outcomes (
  pr_id           INTEGER NOT NULL,
  finding_key     TEXT    NOT NULL,
  repo_key        TEXT    NOT NULL,
  severity        TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  file            TEXT,
  first_raised_at TIMESTAMPTZ NOT NULL,
  pr_settled_at   TIMESTAMPTZ,
  -- Finding raised -> PR settled, in minutes. CAN BE NEGATIVE: a cherry-pick
  -- backport or a post-merge review can settle before, or against a commit
  -- later than, the moment the finding was first raised. Real on live data,
  -- not a defect -- 13 of 135 rows. An aggregate must segment negatives out;
  -- averaging them in with the rest silently drags the mean down and hides
  -- both the negative and the positive populations it was blended from.
  lead_time_mins  INTEGER,
  said            TEXT,
  said_quote      TEXT,
  -- One of FOUR values. 'stale-signal' is the one to read carefully: it means
  -- the reviewer stopped re-raising the finding across follow-up reviews --
  -- evidence that nobody said anything, not evidence that someone did.
  said_evidence   TEXT,
  -- What the branch DID, judged from the post-review diff. NULL on roughly
  -- two thirds of live rows: most findings have no diff yet to judge against.
  -- A query must filter "did IS NOT NULL" or knowingly compute over a
  -- mostly-null denominator -- treating a bare NULL as "not addressed"
  -- silently inflates the addressed rate's denominator.
  did             TEXT,
  -- The value 'none' is UNREACHABLE from the harvest that populates this
  -- column. Do not build a filter or a chart bucket expecting to see it.
  did_confidence  TEXT,
  did_votes       JSONB,
  files_read      JSONB,
  -- Whether the batch result's model matched what was requested. NULL means
  -- "no ballots were cast" OR "every ballot errored" -- it is not a third
  -- verdict of "unverified". Filter "model_verified IS NOT NULL" before
  -- reading a false as a caught model substitution, or a row with no ballots
  -- reads as one. Describes the DID verdict only -- said_model_verified
  -- (added below) is the SAID verdict's own, separate attestation.
  model_verified  BOOLEAN,
  -- The batch that produced the DID verdict. Describes did only --
  -- said_batch_id (added below) describes the SAID verdict, because the two
  -- verdicts are reached by different batches on different nights.
  batch_id        TEXT,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pr_id, finding_key)
);
CREATE INDEX IF NOT EXISTS idx_finding_outcomes_computed ON finding_outcomes (computed_at DESC);
-- How the ballots for said landed, mirroring did_confidence / did_votes. Null on
-- a row no said ballot was ever cast for, which is the normal state for a
-- finding nobody wrote a word about.
--
-- said_confidence is what makes a null said readable. The said tally reports a
-- tie as said = NULL (SaidLabel has no SPLIT member), so without this column a
-- disagreement and "nobody said anything" are the same stored value: NULL with
-- confidence 'split' is a judged tie, NULL with confidence NULL is no ballot at
-- all. It is also the key the upsert's said guard tests, precisely because said
-- itself is null on a legitimate result.
ALTER TABLE finding_outcomes ADD COLUMN IF NOT EXISTS said_confidence TEXT;
-- Every said ballot's verdict AS GRADED, in ballot order -- deliberately NOT the
-- tally's collapsed votes. The grading gate turns a decision label whose quote is
-- not verbatim in the human text into the sentinel "ungrounded", and the tally
-- then folds that into "unclear" because it must return a SaidLabel. Store the
-- collapsed form and a caught fabrication becomes indistinguishable from a model
-- that honestly answered "unclear" -- on the did side that gate downgraded 8.2%
-- of live ballots, which is the evidence the gate is worth having. Storing the
-- graded verdicts keeps the said equivalent of that number computable from the
-- table, and re-tallying them reproduces said and said_confidence exactly, so a
-- later coarser axis can be measured with no new spend.
ALTER TABLE finding_outcomes ADD COLUMN IF NOT EXISTS said_votes JSONB;
-- The batch that produced the said verdict, and whether the model that answered
-- it was the one asked for. Separate columns from batch_id / model_verified,
-- which describe the DID verdict, because the two verdicts are reached by
-- different batches on different nights: the said question needs a human to
-- have written something, the did question needs code to have been pushed.
--
-- One shared pair cannot describe both, and sharing does not fail silently in
-- the harmless direction -- it MISATTRIBUTES. A said-only run leaves the did
-- group's guard preserving the old batch_id, so a said verdict lands beside the
-- id of a batch that produced no said ballot, and anyone asking which batch
-- produced it gets a confident wrong answer. model_verified is worse: a said-only
-- run whose model check FAILED would read back as verified, because the earlier
-- true survives, and that column exists precisely to catch a model substitution.
ALTER TABLE finding_outcomes ADD COLUMN IF NOT EXISTS said_batch_id TEXT;
ALTER TABLE finding_outcomes ADD COLUMN IF NOT EXISTS said_model_verified BOOLEAN;

CREATE TABLE IF NOT EXISTS finding_outcome_sweeps (
  id          SERIAL PRIMARY KEY,
  batch_id    TEXT,
  swept_upto  TIMESTAMPTZ NOT NULL,
  status      TEXT NOT NULL,
  -- The model the batch was SUBMITTED with. Persisted because a resumed run
  -- grades results against the model it expected, and the resuming process may
  -- be a different invocation with different flags: without this, resuming a
  -- --model X batch without repeating that flag compares every result against
  -- the default and marks the whole sweep model_verified = false. A false alarm
  -- on the one signal that catches a real model substitution is worse than no
  -- signal. Null on rows written before this column existed -> caller falls
  -- back to the model it was invoked with.
  model       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE finding_outcome_sweeps ADD COLUMN IF NOT EXISTS model TEXT;
-- How many requests the batch for this row was submitted with. Written BEFORE
-- the batch is created, and it is what lets a crash between the row and the
-- provider's acknowledgement be reconciled afterwards: a row whose batch id was
-- never recorded can be matched against the provider's batch list by creation
-- time AND request count, rather than guessed at. Null on rows written before
-- this column existed. See the sweep's 'submitting' status.
ALTER TABLE finding_outcome_sweeps ADD COLUMN IF NOT EXISTS request_count INTEGER;
-- How many days back this row's batch scanned when it was submitted. Read only
-- on resume, where it is the authority for the window a dead run's candidates
-- are rebuilt against -- NOT the resuming invocation's own --lookback-days,
-- and not a hardcoded default either. A batch submitted with a WIDER window
-- than the default resumes narrower under a hardcoded default, and a
-- candidate missing from the narrower rebuild is a billed ballot that lands
-- nowhere. Null on rows written before this column existed -> caller falls
-- back to the default lookback and says so, same as the model column above.
ALTER TABLE finding_outcome_sweeps ADD COLUMN IF NOT EXISTS lookback_days INTEGER;

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','operator')),
  password_hash TEXT,
  entra_oid     TEXT UNIQUE,
  disabled      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash    TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);
`;

/**
 * Connect to PostgreSQL and initialize the schema.
 * Returns a singleton — multiple calls return the same connection.
 * Retries connection up to 10 times with 2s backoff (for pipeline containers
 * that start before PostgreSQL is ready).
 */
export async function connectDatabase(url: string): Promise<postgres.Sql> {
  if (_sql) return _sql;

  const maxRetries = 10;
  const retryDelayMs = 2000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let sql: postgres.Sql | undefined;
    try {
      sql = postgres(url, {
        max: 5,
        idle_timeout: 30,
        connect_timeout: 10,
        // The schema DDL below is idempotent (CREATE/ALTER ... IF NOT EXISTS), so
        // every connect emits a flood of "already exists, skipping" NOTICEs. Drop
        // those benign ones; forward anything unexpected so real notices aren't lost.
        onnotice: (notice) => {
          // 42P07 = relation already exists, 42701 = column already exists
          if (notice.code === '42P07' || notice.code === '42701') return;
          console.warn(`[postgres] ${notice.severity}: ${notice.message}`);
        },
      });

      // Verify connection + create schema
      await sql.unsafe(SCHEMA);

      _sql = sql;

      // Graceful shutdown
      _cleanup = () => { sql!.end({ timeout: 5 }).catch(() => {}); };
      process.on('beforeExit', _cleanup);
      process.on('SIGTERM', _cleanup);

      return sql;
    } catch (err) {
      // Clean up the failed connection pool to avoid leaks
      if (sql) await sql.end({ timeout: 5 }).catch(() => {});
      if (attempt >= maxRetries) throw err;
      console.warn(`[postgres] Connection attempt ${attempt}/${maxRetries} failed, retrying in ${retryDelayMs}ms...`);
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }

  throw new Error('Unreachable');
}

/** Disconnect (for tests). */
export async function disconnectDatabase(): Promise<void> {
  if (_sql) {
    if (_cleanup) {
      process.removeListener('beforeExit', _cleanup);
      process.removeListener('SIGTERM', _cleanup);
      _cleanup = undefined;
    }
    await _sql.end({ timeout: 5 });
    _sql = undefined;
  }
}
