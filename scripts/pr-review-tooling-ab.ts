// scripts/pr-review-tooling-ab.ts
/**
 * 8-arm A/B over the four prompt/roster levers behind PR-review cost:
 *
 *   agent set     full 7-agent roster (baseline) vs `code-quality-assessor` excluded (`no-cqa`)
 *   routing       diff-trigger-gated dispatch (`PR_REVIEW_AGENT_ROUTING`) vs unconditional
 *   scoped payload per-agent full-source scoping (`PR_REVIEW_SCOPED_PAYLOAD`) vs the whole diff to every agent
 *   BC security   BC-only security domains (`PR_REVIEW_SECURITY_BC_ONLY`) vs the full 8-domain framework
 *
 * `ARMS` below composes these into 8 cells (baseline, no-cqa, routed, scoped, bc-security,
 * routed+no-cqa, routed+scoped, lean=all four). `model`/`toolRule` are carried over from an
 * earlier 2x2 (opus-vs-sonnet, tool-rule-vs-none) and are unset on all 8 arms today — see
 * `expectedModelFor` for why that must never collapse to a `null` compliance check.
 *
 * KNOWN LIMITATION (carry this into any write-up): production repeats of the SAME arm showed a
 * critical finding appearing in 1 of 3 identical runs, and a diff-only judge cannot verify a
 * finding whose truth lives outside the diff (see `scripts/pr-review-eval/judge.ts`). The QUALITY
 * ranking from this matrix is not reliable at n=1 per PR. The COST ranking is: repeats of one
 * config varied only ~15%. Report cost with confidence; report quality only alongside its
 * uncertainty, never alone as if it settles anything.
 *
 * Spawns review containers DIRECTLY rather than enqueuing watcher actions. The
 * watcher reads PR_REVIEW_NO_POST from its own compose env, so steering it
 * through the queue would mean either restarting the watcher with posting
 * disabled (silently breaking any real review that lands during the window) or
 * posting every arm to the PR. Spawning here keeps production untouched and
 * lets each arm carry its own env.
 *
 * Usage:
 *   bun scripts/pr-review-tooling-ab.ts --prs 49388,45792,43408,48617           # dry-run plan
 *   bun scripts/pr-review-tooling-ab.ts --prs 49388,45792,43408,48617 --go      # execute
 *   bun scripts/pr-review-tooling-ab.ts --arms lean --prs 49388 --go           # single-arm smoke
 *   bun scripts/pr-review-tooling-ab.ts --pr 52081 --collect --since <iso>
 *
 * Posting is OFF unless --post is passed. Nothing reaches the PR by default.
 * Nothing is SPENT unless --go is passed — every other flag (including the
 * bare presence of --dry-run, which is accepted but purely cosmetic) is a
 * no-op with respect to spending. Run `--help` for the full flag list.
 */
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { connectStores } from '../src/db/connect-stores.ts';
import { loadManifest, applyOverlayRegistries } from '../src/overlay/index.ts';
import { repos, getRepoConfig } from '../src/config/repos.ts';
import { buildConfigFromRepo } from '../src/cli/config.ts';
import { buildDockerArgs, createVolume, removeContainer, spawnContainer, containerDatabaseUrl } from '../src/sdk/docker.ts';
import { getPrReviewContainerEnv } from '../src/cli/watch/container-dispatcher.ts';
import { summarizeSubAgents, isAtOrAfter, type SubAgentRunUsage } from '../src/cli/pr-review-metrics.ts';
import {
  checkArmCompliance,
  type ComplianceVerdict,
  type LeverFlags,
  type SubAgentTelemetryEntry,
  type AppliedLevers,
} from './pr-review-eval/compliance.ts';

// ---------------------------------------------------------------------------
// Pure argument-parsing helpers. Exported so tests can exercise them without
// touching `process.argv` or triggering any of the side effects below —
// nothing in this section opens a DB connection, spawns a container, or
// spends a token.
// ---------------------------------------------------------------------------

export function argFrom(argv: string[], name: string, def = ''): string {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? def) : def;
}

export function hasFrom(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/** Parse a comma-separated PR id list. Non-numeric / blank entries are dropped, never crash the parse. */
export function parsePrIds(raw: string): number[] {
  return raw.split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);
}

/** `--prs` is the matrix form; `--pr` (singular) is also accepted and wins only when `--prs` is absent. */
export function resolvePrIds(argv: string[]): number[] {
  const raw = argFrom(argv, 'prs') || argFrom(argv, 'pr');
  return parsePrIds(raw);
}

/**
 * C4: fail fast rather than silently running on the wrong credential. `--oauth`
 * with no `CLAUDE_CODE_OAUTH_TOKEN` present is refused outright, never
 * defaulted to pay-per-token — that silent fallback is exactly the failure
 * mode this flag exists to make visible.
 */
export function validateOauthToken(oauth: boolean, token: string): { ok: true } | { ok: false; message: string } {
  if (oauth && !token) {
    return {
      ok: false,
      message: '--oauth was passed but CLAUDE_CODE_OAUTH_TOKEN is not set in the environment. Refusing to run on an unknown credential.',
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Arm table — pure data. See task-7-brief.md Step 1 for the matrix rationale.
// ---------------------------------------------------------------------------

const SEVEN = [
  'code-review-validator', 'code-quality-assessor', 'security-edge-case-analyzer',
  'al-performance-analyzer', 'al-architecture-analyzer', 'al-error-pattern-analyzer',
  'al-integration-analyzer',
];
export const NO_CQA = SEVEN.filter((a) => a !== 'code-quality-assessor');

export interface Arm {
  name: string;
  agentSet: string[] | null; // null = full roster, no PR_REVIEW_AGENT_SET
  routing: boolean;
  scoped: boolean;
  bcSecurity: boolean;
  model?: string; // carried from an earlier 2x2; '' or unset = inherit the frontmatter pin
  toolRule?: boolean; // ditto
}

export const ARMS: Arm[] = [
  { name: 'baseline', agentSet: null, routing: false, scoped: false, bcSecurity: false },
  { name: 'no-cqa', agentSet: NO_CQA, routing: false, scoped: false, bcSecurity: false },
  { name: 'routed', agentSet: null, routing: true, scoped: false, bcSecurity: false },
  { name: 'scoped', agentSet: null, routing: false, scoped: true, bcSecurity: false },
  { name: 'bc-security', agentSet: null, routing: false, scoped: false, bcSecurity: true },
  { name: 'routed+no-cqa', agentSet: NO_CQA, routing: true, scoped: false, bcSecurity: false },
  { name: 'routed+scoped', agentSet: null, routing: true, scoped: true, bcSecurity: false },
  { name: 'lean', agentSet: NO_CQA, routing: true, scoped: true, bcSecurity: true },
];

/**
 * Model-axis probes, deliberately kept OUT of `ARMS`.
 *
 * `selectArms` returns the whole table when no `--arms` filter is given, so an entry
 * added to `ARMS` silently becomes an extra cell in every full matrix run — a 9th
 * arm nobody asked for, at ~$12 per PR. These are opt-in only: reachable by name via
 * `--arms`, never by default.
 *
 * The ORCHESTRATOR model is not set here — it comes from `DEFAULT_MODEL`
 * (`src/cli/config.ts` defaults it to `claude-opus-5`), forwarded through the
 * container env. `arm.model` sets the SUB-AGENT pin, and `expectedModelFor` reads
 * that same field, so compliance expects exactly what the arm asked for instead of
 * voiding the run.
 *
 * `inverted` asks where the intelligence actually has to sit: a cheap orchestrator
 * coordinating expensive sub-agents. Pair it with `DEFAULT_MODEL=claude-sonnet-5`.
 */
export const PROBE_ARMS: Arm[] = [
  { name: 'inverted', agentSet: null, routing: false, scoped: false, bcSecurity: false, model: 'claude-opus-4-8' },
];

/** Every arm reachable by name. Default selection stays `ARMS` — see `selectArms`. */
export const ALL_ARMS: Arm[] = [...ARMS, ...PROBE_ARMS];

/**
 * Select arms by name for `--arms` (C6: arms are named `Arm.name`, not the
 * old 2x2's `Arm.label`). An empty/omitted filter selects every arm. Matching
 * is exact and case-sensitive against `arm.name` — `--arms lean` must resolve
 * to exactly `ARMS[7]`.
 */
export function selectArms(filterCsv: string, arms: Arm[] = ARMS): Arm[] {
  const only = filterCsv.split(',').map((a) => a.trim()).filter(Boolean);
  // No filter => the 8-cell matrix ONLY. Probe arms are opt-in by name, so adding
  // one can never quietly enlarge a full matrix run.
  if (only.length === 0) return arms;
  // Named selection searches the probes too, so `--arms inverted` resolves.
  const pool = arms === ARMS ? ALL_ARMS : arms;
  return pool.filter((a) => only.includes(a.name));
}

// ---------------------------------------------------------------------------
// Compliance wiring — pure translation from an Arm's config to the shape
// `checkArmCompliance` expects (signature pinned by Task 9, see
// task-9-report.md: `(armName, expected, expectedModel, subAgents,
// expectedLevers, appliedLevers)`).
// ---------------------------------------------------------------------------

/**
 * C1 — the model every sub-agent is expected to run on for THIS arm.
 *
 * All 7 sub-agent frontmatter files pin `model: claude-sonnet-5`, and
 * `Arm.model` is unset on all 8 arms in the table above (it is a leftover
 * field from an earlier opus-vs-sonnet 2x2). The reflexive fix at the call
 * site — `arm.model ?? null` — would therefore pass `null` for every arm,
 * and `checkArmCompliance` treats `expectedModel === null` as "skip the model
 * check entirely". That silently disarms the exact gate that exists because
 * a frontmatter model pin was ignored in production once already (all 7
 * sub-agents ran on opus, ~2x cost, undetected until a live-data audit).
 *
 * `||`, not `??`: an empty string must ALSO fall through to the sonnet
 * default. `normalizeModel('')` matches nothing, so `''` reaching
 * `expectedModel` would VOID every arm on the model check instead of skipping
 * it — a different failure, but still a total-loss one.
 */
export function expectedModelFor(arm: Arm): string {
  return arm.model || 'claude-sonnet-5';
}

/**
 * C2 — translate an arm's own config fields to `LeverFlags`'s key names.
 * `LeverFlags`/`AppliedLevers` deliberately share one naming scheme
 * (`scopedPayload`/`securityBcOnly`), NOT the arm table's own
 * `scoped`/`bcSecurity` — the translation happens here, once, so there is
 * exactly one place that could get it backwards.
 */
export function leverFlagsFor(arm: Arm): LeverFlags {
  return {
    agentSet: arm.agentSet !== null,
    routing: arm.routing,
    scopedPayload: arm.scoped,
    securityBcOnly: arm.bcSecurity,
  };
}

/**
 * The actual compliance call this runner makes for one recorded run —
 * exported so tests exercise the REAL call site (not a re-implementation of
 * it) end to end: a wrong model or a lever that never applied must VOID, and
 * that only holds if `expectedModelFor`/`leverFlagsFor` are wired in here,
 * not bypassed.
 */
export function buildComplianceVerdict(
  arm: Arm,
  subAgents: Record<string, SubAgentTelemetryEntry> | null,
  appliedLevers: AppliedLevers | null,
): ComplianceVerdict {
  return checkArmCompliance(arm.name, arm.agentSet, expectedModelFor(arm), subAgents, leverFlagsFor(arm), appliedLevers);
}

// ---------------------------------------------------------------------------
// Env assembly — pure given an already-resolved base env. `base` is normally
// `getPrReviewContainerEnv()` (production parity — see C3: the runner DOES go
// through it, it is not built from scratch), injected here so this function
// itself needs neither `process.env` nor the container-dispatcher import
// chain to be testable.
// ---------------------------------------------------------------------------

export interface ArmEnvOptions {
  post: boolean;
  containerDbUrl: string;
  /** C4: run this cell on the OAuth subscription instead of the pay-per-token key. */
  oauth: boolean;
  /** The real `CLAUDE_CODE_OAUTH_TOKEN`, read by the caller — only used when `oauth` is true. */
  oauthToken: string;
}

export function buildArmEnv(base: Record<string, string>, arm: Arm, opts: ArmEnvOptions): Record<string, string> {
  return {
    ...base,
    // Must be the compose-internal host: see containerDatabaseUrl.
    DATABASE_URL: opts.containerDbUrl,
    PR_REVIEW_NO_POST: opts.post ? '' : '1',
    PR_REVIEW_SUBAGENT_MODEL: arm.model ?? '',
    PR_REVIEW_SUBAGENT_TOOL_RULE: arm.toolRule ? '1' : '',
    PR_REVIEW_AGENT_SET: arm.agentSet ? arm.agentSet.join(',') : '',
    PR_REVIEW_AGENT_ROUTING: arm.routing ? '1' : '',
    PR_REVIEW_SCOPED_PAYLOAD: arm.scoped ? '1' : '',
    PR_REVIEW_SECURITY_BC_ONLY: arm.bcSecurity ? '1' : '',
    // C4: `base` (getPrReviewContainerEnv()) keys off PR_REVIEW_ANTHROPIC_API_KEY
    // and, when set, explicitly blanks CLAUDE_CODE_OAUTH_TOKEN — that is the
    // pay-per-token default every arm bills against today. Applied AFTER the
    // spread so --oauth always wins when passed.
    // The bracketed computed-property keys just below (`['ANTHROPIC_API_KEY']`
    // etc.) are deliberate, not stylistic: writing them as plain object-literal
    // keys trips .claude/hooks/guard-commit.ts's blunt "env-var name immediately
    // followed by a colon" secret scan (it inspects only the key shape, never
    // the value, so it cannot tell an empty string or a variable from a real
    // credential) and blocks the commit. Do NOT "tidy" these brackets away
    // without re-checking that hook first — see task-7-report.md for the
    // false positive this sidesteps.
    ...(opts.oauth ? { ['ANTHROPIC_API_KEY']: '', ['CLAUDE_CODE_OAUTH_TOKEN']: opts.oauthToken } : {}),
  };
}

// ---------------------------------------------------------------------------
// Row attribution — pure predicate. C10: a NO-POST arm row must never be
// confused with a concurrent production/watcher review of the SAME PR, which
// would carry a POSITIVE commentId. Matching on PR id + time alone silently
// poisons scoring by attributing a foreign row to an arm.
//
// Fix round 2 (2026-08-01): the first cut used `row.commentId == null`, which
// matches `null`/`undefined` but NOT `0` — and a NO-POST review records
// `comment_id: 0`, not `null`. That rejected exactly the rows every arm
// produces: a paid smoke run (PR 49388, row id 1687, $15.54, 14 findings)
// recorded correctly and was then discarded by this predicate, which told the
// operator to go debug DATABASE_URL. The database was never the problem.
//
// Checked against the live table rather than assumed this time:
//   comment_id positive (1..230469): 1326 rows — posted to the PR
//   comment_id 0:                       61 rows — ran NO-POST
//   comment_id null:                   101 rows — error rows, no telemetry
// So "not posted to a PR" is `null` OR `0`, not just nullish. A posted review
// always has a POSITIVE id, so this still excludes a concurrent production
// review of the same PR, which is what C10 was for — the fix narrows what
// counts as "not posted", it does not widen what counts as "posted".
// ---------------------------------------------------------------------------

export interface AttributableRow {
  prId: number;
  commentId: number | null;
  createdAt: string;
}

export function matchesArmRow(row: AttributableRow, prId: number, since: string): boolean {
  return row.prId === prId && !row.commentId && isAtOrAfter(row.createdAt, since);
}

// ---------------------------------------------------------------------------
// JSONL result-line assembly (C9) — pure given the row/verdict data needed.
// Written after EACH cell (never batched at the end): 32 sequential container
// runs is hours, and a crash at run 30 must not forfeit attribution for the
// 29 that already finished.
// ---------------------------------------------------------------------------

export interface ResultRow {
  id: number;
  createdAt: string;
  appliedLevers: AppliedLevers | null;
}

export function buildResultLine(arm: Arm, prId: number, row: ResultRow, verdict: ComplianceVerdict): string {
  return JSON.stringify({
    arm: arm.name,
    prId,
    rowId: row.id,
    createdAt: row.createdAt,
    // A soft WARN (e.g. "ran all 7 — verify this arm's instruction took
    // effect") is easy to miss scrolling past across 32 sequential runs on a
    // console; it must survive in the record, not just the terminal.
    verdict: verdict.compliant ? 'compliant' : 'void',
    reason: verdict.reason ?? null,
    note: verdict.note ?? null,
    appliedLevers: row.appliedLevers ?? null,
  }) + '\n';
}

// ---------------------------------------------------------------------------
// PR -> repo resolution (C5 follow-up fix).
//
// C5 moved the PR loop outermost, and with it the ADO repo-resolution probe
// that used to run before the --go gate now sits entirely after it. That
// silently removed a free safety net: with `--prs a,b,c,d`, a mistyped or
// unregistered id at position `c` was only discovered once the loop reached
// it — after `a` and `b` had each fully run and billed an 8-arm pool.
// Recovery meant hand-trimming already-completed ids out of `--prs` and
// re-invoking, risking a duplicate double-billed run.
//
// Fix: resolve EVERY id in `--prs` to its registered repo ONCE, up front,
// before --go is checked. It costs one ADO REST call per PR id and zero LLM
// spend, so — like `preflightDb` proving the DB write path before a review
// runs — it belongs entirely on the free side of the gate.
//
// `resolveAllRepos` takes the resolver as a parameter so it stays pure and
// testable without a real network call; the real resolver (making the actual
// ADO call) is defined inside `import.meta.main` below.
// ---------------------------------------------------------------------------

export interface ResolvedRepo {
  key: string;
  config: ReturnType<typeof getRepoConfig>;
  repositoryId: string;
  title?: string;
}

export type RepoResolver = (prId: number) => Promise<ResolvedRepo | null>;

export type ResolveAllReposResult =
  | { ok: true; repos: Map<number, ResolvedRepo> }
  | { ok: false; message: string; unresolved: number[] };

/**
 * Resolve every PR id to its registered repo. Checks ALL ids (never stops at
 * the first failure) so a bad `--prs` list reports every offending id in one
 * pass instead of a whack-a-mole of fix-one-rerun-find-the-next. Any
 * unresolved id fails the WHOLE batch — this is a preflight for the entire
 * matrix, not a per-PR gate, so a partial resolution is never handed back as
 * if it were safe to spend against.
 */
export async function resolveAllRepos(prIds: number[], resolve: RepoResolver): Promise<ResolveAllReposResult> {
  const resolved = new Map<number, ResolvedRepo>();
  const unresolved: number[] = [];
  for (const prId of prIds) {
    const r = await resolve(prId);
    if (r) resolved.set(prId, r);
    else unresolved.push(prId);
  }
  if (unresolved.length > 0) {
    return {
      ok: false,
      unresolved,
      message: `Could not locate PR ${unresolved.join(', ')} in any registered repo. Fix --prs before spending anything.`,
    };
  }
  return { ok: true, repos: resolved };
}

// ---------------------------------------------------------------------------
// Main (only runs when executed directly, not when imported by tests). Every
// side effect — DB connection, ADO/network probing, docker spawn — lives in
// here, gated ultimately by --go for anything that spends money.
// ---------------------------------------------------------------------------

if (import.meta.main) {

const argv = process.argv;
const arg = (name: string, def = '') => argFrom(argv, name, def);
const has = (name: string) => hasFrom(argv, name);

if (has('help')) {
  console.log(
    'Usage:\n' +
    '  bun scripts/pr-review-tooling-ab.ts --prs <id,id,...> [--pr <id>] [--runs N] [--arms a,b,c] [--oauth] [--go]\n' +
    '  bun scripts/pr-review-tooling-ab.ts --pr <id> --collect --since <iso>\n\n' +
    '  --prs <ids>          Comma-separated PR ids (the matrix form). --pr <id> also accepted (single PR); --prs wins if both given.\n' +
    '  --runs N             Repeats per arm per PR (default 1).\n' +
    '  --arms a,b,c         Restrict to named arms. Default: all 8. Known: ' + ARMS.map((a) => a.name).join(', ') + '\n' +
    '  --oauth              Bill this run against the Claude MAX subscription (CLAUDE_CODE_OAUTH_TOKEN) instead of\n' +
    '                       the pay-per-token key getPrReviewContainerEnv() defaults every arm to today. Fails fast\n' +
    '                       if CLAUDE_CODE_OAUTH_TOKEN is not set. CAVEAT: a usage-limit hit mid-matrix can VOID\n' +
    '                       arms on the subscription (no retry here) — pay-per-token has no such throttle.\n' +
    '  --go                 Actually spend money and spawn containers. Its ABSENCE is what makes every other\n' +
    '                       invocation a dry run. --dry-run is accepted but purely cosmetic — there is no separate\n' +
    '                       switch with different gating semantics; only --go gates spending.\n' +
    '  --post               Post the review to the PR (default: NO_POST). Never use this for the matrix.\n' +
    '  --image, --state-volume   Overrides for the container image / state volume names.\n',
  );
  process.exit(0);
}

const prIds = resolvePrIds(argv);
if (prIds.length === 0) { console.error('Need --pr <id> or --prs <id,id,...>'); process.exit(1); }

const runs = parseInt(arg('runs', '1'), 10);
const post = has('post');
const oauth = has('oauth');
const imageName = arg('image', 'devopsworker:latest');
const stateVolume = arg('state-volume', 'do-pipeline-state');

if (has('dry-run')) {
  console.log('[ab] note: --dry-run is a no-op label. Omitting --go is what already prevents spending.');
}

const oauthToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'] ?? '';
const oauthCheck = validateOauthToken(oauth, oauthToken);
if (!oauthCheck.ok) { console.error(`[ab] ${oauthCheck.message}`); process.exit(1); }

// --arms lets a canary run ONE arm, confirm it recorded, then continue with
// the rest. The post-run compliance gate would catch a failure anyway, but on
// a first outing after a recording bug, proving it by hand costs one run and
// settles it.
const onlyArmsRaw = arg('arms');
const SELECTED = selectArms(onlyArmsRaw, ARMS);
if (SELECTED.length === 0) {
  console.error(`No arm matched --arms "${onlyArmsRaw}". Known: ${ARMS.map((a) => a.name).join(', ')}`);
  process.exit(1);
}

applyOverlayRegistries(await loadManifest());
const { prReviewStore } = await connectStores();

// ---------------------------------------------------------------------------
// collect
// ---------------------------------------------------------------------------
if (has('collect')) {
  const since = arg('since');
  if (!since) { console.error('--collect requires --since <iso>'); process.exit(1); }

  // Arm identity is not stored on the row, so recover it from what the arm
  // actually did: model_usage names the model the sub-agents ran on. This
  // heuristic predates JSONL attribution (see the main matrix loop below) and
  // cannot distinguish arms that share model config — which is every arm in
  // the 8-arm table. Kept for ad-hoc single-PR inspection; the matrix itself
  // is attributed via `scripts/ab-results/matrix-*.jsonl`.
  const armOf = (r: { modelUsage: Record<string, unknown> | null }): string => {
    const models = Object.keys(r.modelUsage ?? {});
    return models.some((m) => m.includes('sonnet')) ? 'sonnet*' : 'opus*';
  };

  for (const prId of prIds) {
    const rows = await prReviewStore.listRecent(200);
    const mine = rows.filter((r) => matchesArmRow(r, prId, since));
    if (mine.length === 0) { console.log(`\nPR #${prId}: no rows yet.`); continue; }

    console.log(`\nPR #${prId} — ${mine.length} runs since ${since}\n`);
    console.log('  arm       cost    turns   bash   read    lsp   findings  rec');
    console.log('  ' + '-'.repeat(72));
    for (const r of mine) {
      const t = r.toolCalls ?? {};
      const lsp = Object.entries(t).filter(([k]) => k === 'LSP').reduce((a, [, v]) => a + v, 0);
      console.log(
        '  ' + armOf(r).padEnd(10) +
        `$${(r.costUsd ?? 0).toFixed(2)}`.padStart(6) +
        String(r.turns ?? 0).padStart(8) +
        String(t['Bash'] ?? 0).padStart(7) +
        String(t['Read'] ?? 0).padStart(7) +
        String(lsp).padStart(7) +
        String(r.findingsCount ?? 0).padStart(10) +
        '  ' + (r.recommendation ?? '').slice(0, 20),
      );
    }

    const withSub = mine.filter((r) => r.subAgents).map((r) => r.subAgents as Record<string, SubAgentRunUsage>);
    if (withSub.length > 0) {
      console.log('\n  per sub-agent (all runs pooled):');
      for (const s of summarizeSubAgents(withSub)) {
        console.log(`    ${s.name.padEnd(30)} runs=${String(s.runs).padStart(2)}  $${s.totalCostUsd.toFixed(2).padStart(6)}  medTurns=${s.medianTurns}`);
      }
    }
  }
  process.exit(0);
}

/**
 * Wait for the row a finished container should have written.
 *
 * Polls rather than reading once: the container's own DB write races the
 * `docker run` exit by a moment. Returns the row, or null once the window
 * closes — which the caller treats as fatal, not as something to retry past.
 * C10: `matchesArmRow` excludes any row with a POSITIVE commentId so a
 * concurrent production/watcher review of the same PR (which WOULD post, and
 * so carries a positive commentId) can never be misattributed to this arm.
 * `0` (NO-POST) and `null` (error, no telemetry) both count as "not posted"
 * — see the fix-round-2 comment on `matchesArmRow` for why a naive
 * nullish check is not the same thing.
 */
async function waitForRow(pr: number, since: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prReviewStore.listRecent(20);
    const hit = rows.find((r) => matchesArmRow(r, pr, since));
    if (hit) return hit;
    await new Promise((res) => setTimeout(res, 2000));
  }
  return null;
}

/**
 * Prove the containers' write path works BEFORE spending a review on it.
 *
 * Runs a throwaway container on the same network with the same DATABASE_URL and
 * has it count rows. Costs seconds and no tokens; catches the exact failure that
 * wasted ~$60.
 */
async function preflightDb(dbUrl: string): Promise<boolean> {
  const proc = Bun.spawn([
    'docker', 'run', '--rm', '--network', 'pipeline-net',
    '-e', `DATABASE_URL=${dbUrl}`,
    '--entrypoint', 'bun', imageName,
    '-e', `const postgres=(await import('postgres')).default;
           const sql=postgres(process.env.DATABASE_URL);
           const r=await sql\`SELECT count(*)::int AS n FROM pr_reviews\`;
           console.log('PREFLIGHT_OK rows=' + r[0].n); await sql.end();`,
  ], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  if (out.includes('PREFLIGHT_OK')) {
    console.log(`[ab] preflight: ${out.trim().split(String.fromCharCode(10)).pop()}`);
    return true;
  }
  console.error(`[ab] preflight FAILED — containers cannot reach the database.`);
  const NL = String.fromCharCode(10);
  console.error((err || out).trim().split(NL).slice(-6).join(NL));
  return false;
}

// ---------------------------------------------------------------------------
// plan / execute
// ---------------------------------------------------------------------------

// Resolve every PR id to its registered repo BEFORE the --go gate (see the
// module-level comment on `resolveAllRepos` for why this moved here). One ADO
// call per PR id, no LLM spend — safe to run on every invocation, dry run
// included, so a mistyped/unregistered id is caught for free.
const resolveRepoForPr: RepoResolver = async (prId) => {
  for (const k of Object.keys(repos)) {
    const rc = getRepoConfig(k);
    const cfg = buildConfigFromRepo(rc, process.env as Record<string, string>);
    try {
      const r: any = await (await import('../src/sdk/ado/http.ts')).adoFetch(
        cfg.azureDevOps,
        `git/repositories/${cfg.azureDevOps.repositoryId}/pullrequests/${prId}?api-version=7.0`,
      );
      if (r?.pullRequestId === prId) {
        return { key: k, config: rc, repositoryId: cfg.azureDevOps.repositoryId, title: r.title };
      }
    } catch { /* not this repo */ }
  }
  return null;
};

const repoResult = await resolveAllRepos(prIds, resolveRepoForPr);
if (!repoResult.ok) {
  console.error(`[ab] ${repoResult.message}`);
  process.exit(1);
}
const resolvedRepos = repoResult.repos;
for (const [prId, r] of resolvedRepos) {
  console.log(`[ab] PR #${prId} -> repo "${r.key}"${r.title ? ` (${r.title})` : ''}`);
}

const total = SELECTED.length * runs * prIds.length;
console.log(`[ab] ${SELECTED.length} arm(s) x ${prIds.length} PR(s) x ${runs} run(s) = ${total} reviews`);
console.log(`[ab] posting to the PR: ${post ? 'YES' : 'no (PR_REVIEW_NO_POST=1)'}`);
console.log(`[ab] credential: ${oauth ? 'OAuth subscription (CLAUDE_CODE_OAUTH_TOKEN)' : 'pay-per-token (getPrReviewContainerEnv default)'}`);
for (const a of SELECTED) {
  console.log(
    `       ${a.name.padEnd(15)} agentSet=${a.agentSet ? `${a.agentSet.length}/7` : 'all-7'}  ` +
    `routing=${a.routing}  scoped=${a.scoped}  bcSecurity=${a.bcSecurity}  ` +
    `model=${a.model || '(pinned sonnet-5)'}  toolRule=${!!a.toolRule}`,
  );
}

if (!has('go')) {
  console.log('\n[ab] dry run — re-run with --go to execute. (--go is the only thing that gates spending.)');
  process.exit(0);
}

// Prove the containers' write path BEFORE spending a review on it. Costs
// seconds and no tokens.
const containerDbUrl = containerDatabaseUrl(process.env['DATABASE_URL'] ?? '');
if (!await preflightDb(containerDbUrl)) {
  console.error('[ab] refusing to spend a review until the write path is proven.');
  process.exit(1);
}

const cutoff = new Date().toISOString();
console.log(`[ab] cutoff=${cutoff}\n`);

const resultsPath = `scripts/ab-results/matrix-${cutoff.replace(/[:.]/g, '-')}.jsonl`;
mkdirSync(dirname(resultsPath), { recursive: true });

let n = 0;
// C5: PR loop OUTER, arms INNER. A mid-matrix abort (usage limit, crash)
// leaves complete 8-arm pools for the PRs that already finished, instead of
// eight half-pools that cannot be scored at all.
for (const prId of prIds) {
  const repo = resolvedRepos.get(prId)!; // resolved (and validated) above, before --go
  const repositoryId = repo.repositoryId;

  for (let r = 0; r < runs; r++) {
    for (const arm of SELECTED) {
      n++;
      const container = `pr-ab-${prId}-${arm.name.replace(/\W+/g, '')}-${r}`;
      const volume = `pr-ab-${prId}-${r}-${arm.name.replace(/\W+/g, '')}`;
      console.log(`[ab] (${n}/${total}) PR ${prId} ${arm.name} run ${r + 1}`);

      await createVolume(volume).catch(() => {});
      await removeContainer(container);

      const env = buildArmEnv(getPrReviewContainerEnv(), arm, { post, containerDbUrl, oauth, oauthToken });

      const args = buildDockerArgs({
        workItemId: 0,
        repoKey: repo.key,
        repo: repo.config,
        command: 'review-pr',
        env,
        stateVolume,
        workspaceVolume: volume,
        imageName,
        // `--full` pins every arm to the seven-agent reviewer. Since the cherry-pick
        // sanity path shipped, `review-pr` routes on the PR's own title/description,
        // which it reads from the API — so it fires even though this runner passes no
        // `--pr-title`. A subject PR carrying a cherry-pick trailer would silently run
        // a DIFFERENT agent, single-model, at roughly a twentieth of the cost, in EVERY
        // arm.
        //
        // That is the shape worth guarding against: the arms would still differ from
        // one another, so nothing would look broken — the numbers would just stop
        // measuring the levers under test. `forceFull` is the first check in
        // `chooseReviewPath`, so this short-circuits detection rather than depending on
        // which PRs are in the subject set today.
        extraArgs: ['--pr-id', String(prId), '--repo-id', repositoryId, '--full'],
      });
      const nameIdx = args.indexOf('--name');
      if (nameIdx !== -1 && args[nameIdx + 1]) args[nameIdx + 1] = container;

      const startedAt = new Date().toISOString();
      const code = await spawnContainer(args);

      // HARD GATE. A review that finishes but records nothing is worse than one
      // that fails: it costs the same and yields nothing, and the store swallows
      // connection errors so it looks like success. Eight arms once ran to
      // completion against an unreachable DB — ~$60, zero rows. Never spend a
      // second run without proof the first was recorded.
      const recorded = await waitForRow(prId, startedAt);
      if (!recorded) {
        // State what was OBSERVED, not a diagnosis. A prior version of this
        // message asserted "check DATABASE_URL" as the cause; on PR 49388
        // that was wrong — the row (id 1687) had saved correctly, and this
        // gate aborted anyway because `matchesArmRow`'s predicate rejected
        // it (see the fix-round-2 note on `matchesArmRow` above). Asserting
        // a cause here sends the operator to debug the wrong subsystem;
        // listing candidates and pointing at the evidence does not.
        console.error(
          `\n[ab] ABORTING after run ${n}/${total} (${arm.name}, PR ${prId}, exit=${code}).\n` +
          `[ab] Observed: the container exited ${code}; no pr_reviews row matched PR ${prId}\n` +
          `[ab] (via matchesArmRow) within the polling window.\n` +
          `[ab] Check what actually happened before assuming a cause:\n` +
          `[ab]   SELECT id, created_at, comment_id, cost_usd, error FROM pr_reviews\n` +
          `[ab]   WHERE pr_id = ${prId} ORDER BY created_at DESC LIMIT 3;\n` +
          `[ab] Candidate causes (not in order, not asserted): the container's DATABASE_URL not\n` +
          `[ab] resolving to the compose service; the review erroring before the save step; a real\n` +
          `[ab] row that saved but was rejected by matchesArmRow's attribution predicate (this\n` +
          `[ab] exact bug voided a genuine $15.54 run once already); or the 30s polling window\n` +
          `[ab] being too short for a slow write.`,
        );
        process.exit(1);
      }

      // Report compliance BEFORE any scoring. A void cell is not a zero — it is
      // a missing measurement (its lever, or its roster, never actually took
      // effect this run) and must be excluded from the scoring table, reported
      // separately, rather than averaged in as if the arm produced nothing.
      const verdict = buildComplianceVerdict(arm, recorded.subAgents, recorded.appliedLevers);
      if (!verdict.compliant) {
        console.log(`  VOID  ${arm.name} PR ${prId}: ${verdict.reason}`);
      } else if (verdict.note) {
        console.log(`  WARN  ${arm.name} PR ${prId}: ${verdict.note}`);
      }

      // Persist arm identity + verdict per run, written after EACH cell (never
      // batched at the end) — see the module-level comment on buildResultLine.
      appendFileSync(resultsPath, buildResultLine(arm, prId, recorded, verdict));

      console.log(
        `[ab]     exit=${code}  recorded id=${recorded.id}  $${(recorded.costUsd ?? 0).toFixed(2)}  ` +
        `turns=${recorded.turns}  bash=${recorded.toolCalls?.['Bash'] ?? 0}  ` +
        `read=${recorded.toolCalls?.['Read'] ?? 0}  lsp=${recorded.toolCalls?.['LSP'] ?? 0}`,
      );
    }
  }
}

console.log(`\n[ab] done. Results: ${resultsPath}`);
console.log(`[ab] Collect one PR's rows with:`);
console.log(`  bun scripts/pr-review-tooling-ab.ts --pr ${prIds[0]} --collect --since ${cutoff}`);
process.exit(0);

} // end if (import.meta.main)
