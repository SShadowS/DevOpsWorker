import { useEffect, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import type {
  ReflectionProposal, ProposedChange, Adjudication, VerdictLabel, EvidenceType, ProposalStatus,
} from '../../../db/reflection-proposal-mapper.ts';
import { formatRelativeTime } from '../format.ts';
import { countOf } from '../../count-phrase.ts';
import { CardGlossary } from './card-glossary.tsx';
import type { GlossaryTerm } from './card-glossary.tsx';

// ---------------------------------------------------------------------------
// Reflection card (Task 7) — the dashboard's review surface for the monthly
// reflection agent's proposals: what it adjudicated, what it wants to change,
// and the Approve/Reject gate before anything ships. Sits beside the Review
// value panel on the Stats & Config tab (both read what came OUT of PR
// review; this one is what the pipeline proposes to DO about it).
//
// NOT a windowed stats panel, so it deliberately does not join
// stats-store.ts's shared window/population machinery: `/api/reflections`
// takes no window or population — it is "the last few reflection cycles,"
// full stop — so this file owns a small state module of its own, mirroring
// admin-repos.tsx's `listState` signal rather than stats-view.tsx's
// `FetchState` fan-out.
//
// A proposal row carries TWO independent signals that this card must not
// conflate: `status` (pending/approved/rejected/applied/superseded, the
// decision lifecycle) and `error` (the reflection run itself failed to
// produce a usable proposal — see reflect.ts's catch block, which saves a row
// with `status` left at its DB default 'pending' but every content array
// empty). A failed run is therefore NOT "a pending proposal with nothing in
// it" as far as a reader is concerned — it is a failed run, and the error
// text is checked and shown before anything reads the status field.
//
// Every verdict/status word a reader sees is translated through a fixed
// lookup here (`VERDICT_TEXT`, `describeProposalStatus`) rather than printed
// from the database — this repo's writing rule ("no raw enum values on
// screen anywhere") applies as much to `verdictLabel`/`status` here as it did
// to `did`/`said` on the Review value card.
// ---------------------------------------------------------------------------

const TERMS: readonly GlossaryTerm[] = [
  {
    term: 'a reflection proposal',
    plain: 'a monthly review of how the team responded to reviewer findings, with any prompt changes it recommends',
  },
  {
    term: 'the watch ledger',
    plain: "a failure pattern seen too rarely yet to act on, kept so next cycle can tell whether it's grown",
  },
];

// ---------------------------------------------------------------------------
// List state — fetched once on mount, refetched after every decision.
// ---------------------------------------------------------------------------

type ReflectionListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'ready'; proposals: ReflectionProposal[] };

const listState = signal<ReflectionListState>({ status: 'loading' });

/** Which decision is in flight, or null. Drives per-button "Approving…" /
 *  "Rejecting…" labels and disables both buttons while either is running —
 *  a proposal can only ever be decided once (the server enforces this with a
 *  409), so a double-click racing the same row is exactly what disabling
 *  both buttons during either request prevents. */
const decisionBusy = signal<'approved' | 'rejected' | null>(null);
const decisionError = signal<string | null>(null);

async function loadReflections(): Promise<void> {
  listState.value = { status: 'loading' };
  try {
    const res = await fetch('/api/reflections?limit=5');
    if (!res.ok) {
      listState.value = { status: 'error', message: `${res.status} ${res.statusText}` };
      return;
    }
    const data = (await res.json()) as ReflectionProposal[];
    listState.value = data.length === 0 ? { status: 'empty' } : { status: 'ready', proposals: data };
  } catch (err) {
    listState.value = { status: 'error', message: err instanceof Error ? err.message : 'Network error' };
  }
}

/** Reads the server's own error text out of a non-2xx JSON body when there is
 *  one, matching admin-fetch.ts's convention of surfacing the server's exact
 *  message rather than a generic "request failed" — the brief requires the
 *  server's wording to reach the screen verbatim (e.g. "This proposal was
 *  already decided.", the 409 case). */
function extractErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'error' in body && typeof (body as { error?: unknown }).error === 'string') {
    return (body as { error: string }).error;
  }
  return fallback;
}

async function decide(id: number, decision: 'approved' | 'rejected'): Promise<void> {
  decisionBusy.value = decision;
  decisionError.value = null;
  try {
    const res = await fetch(`/api/reflections/${id}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    let body: unknown = null;
    try { body = await res.json(); } catch { /* no JSON body to read */ }
    if (!res.ok) {
      decisionError.value = extractErrorMessage(body, `${res.status} ${res.statusText}`);
      return;
    }
    await loadReflections();
  } catch (err) {
    decisionError.value = err instanceof Error ? err.message : 'Network error';
  } finally {
    decisionBusy.value = null;
  }
}

// ---------------------------------------------------------------------------
// Plain-word translation — every enum-shaped field on a proposal goes through
// one of these before it reaches JSX. Pure, exported for the same reason
// stats-review-value.tsx's `didVerdictText` is: a table cell and a badge
// must never drift into two different wordings for the same value.
// ---------------------------------------------------------------------------

const VERDICT_TEXT: Record<VerdictLabel, string> = {
  'reviewer-wrong': 'the team was right',
  'human-wrong': 'the finding was right',
  'both-defensible': 'judgment call',
  unclear: 'no evidence either way',
};

/** An unrecognised value renders as itself — matching `didVerdictText`'s
 *  precedent (stats-review-value.tsx): the schema fixes this to four values,
 *  but the raw string is at least searchable if a fifth ever appears. */
export function verdictText(label: VerdictLabel): string {
  return VERDICT_TEXT[label] ?? label;
}

/** "What we verified." A null `evidence` is not silence — `evidenceType`
 *  says WHY nothing is recorded (only `needs-measurement`/`none` license a
 *  null `evidence` per the agent's own CLAUDE.md), so the fallback text
 *  distinguishes "this would need a live measurement" from "nothing was
 *  checked" rather than rendering the same blank for both. */
export function describeEvidence(evidence: string | null, evidenceType: EvidenceType): string {
  if (evidence) return evidence;
  if (evidenceType === 'needs-measurement') return 'Not settled here — this would need a live measurement to check.';
  return 'Nothing was checked.';
}

const STATUS_TEXT: Record<ProposalStatus, string> = {
  pending: 'pending review',
  approved: 'approved',
  rejected: 'rejected',
  applied: 'applied',
  superseded: 'superseded',
};

/** The word this card shows for a proposal's state. `error` takes priority
 *  over `status` — see the module doc comment on why a failed run and a
 *  pending decision are different facts even though both carry `status:
 *  'pending'` in the database. */
export function describeProposalStatus(p: ReflectionProposal): string {
  if (p.error) return 'failed';
  if (p.status === null) return 'status not recognised';
  return STATUS_TEXT[p.status];
}

/** The badge colour for `describeProposalStatus`'s word — reuses the shared
 *  `.badge--info/--success/--error` palette (recent-actions-panel.tsx) rather
 *  than a new one, since this card's states map cleanly onto that existing
 *  in-progress/settled-well/settled-badly vocabulary. */
export function badgeClassForProposal(p: ReflectionProposal): string {
  if (p.error) return 'badge--error';
  switch (p.status) {
    case 'pending': return 'badge--info';
    case 'approved':
    case 'applied':
      return 'badge--success';
    case 'rejected': return 'badge--error';
    case 'superseded': return 'badge--info';
    case null: return 'badge--error';
  }
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** "131 of 219 findings carried a team response — 60%." `pct` arrives from
 *  the server already scaled 0..100 (reflect.ts computes it as
 *  `round(withSaid/total * 1000) / 10`, NOT a 0..1 fraction) — unlike every
 *  rate on the Review value card, this is NOT a `formatPct` input, and
 *  passing it through that helper would silently multiply by 100 a second
 *  time. */
export function describeCoverage(coverage: ReflectionProposal['coverage']): string {
  if (coverage === null) return 'Coverage was not recorded for this cycle.';
  if (coverage.total === 0) return 'No findings were raised in this cycle, so there is no coverage to report.';
  return `${coverage.withSaid} of ${countOf(coverage.total, 'finding')} carried a team response — ${Math.round(coverage.pct)}%.`;
}

/**
 * A watch-ledger or classifier-notes entry has no fixed shape — both columns
 * are `JSONB` written straight from the agent's structured output
 * (`z.array(z.unknown())` in schema.ts) rather than a typed row, because the
 * agent's own CLAUDE.md only promises "occurrence count," not a schema. This
 * reads the common shapes a cluster-like entry uses (`name`/`key`,
 * `occurrences`, `prs`, `reason`/`note`) and falls back to the raw JSON for
 * anything it does not recognise — never silently drops an entry.
 */
export function describeWatchEntry(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    const o = entry as Record<string, unknown>;
    const name = typeof o['name'] === 'string' ? o['name'] : typeof o['key'] === 'string' ? o['key'] : null;
    const occurrences = o['occurrences'];
    const count = typeof occurrences === 'number' ? occurrences : Array.isArray(occurrences) ? occurrences.length : null;
    const prs = typeof o['prs'] === 'number' ? o['prs'] : null;
    const reason = typeof o['reason'] === 'string' ? o['reason'] : typeof o['note'] === 'string' ? o['note'] : null;
    const parts = [
      name,
      count != null ? countOf(count, 'occurrence') : null,
      prs != null ? `on ${countOf(prs, 'pull request')}` : null,
      reason,
    ].filter((part): part is string => !!part);
    if (parts.length > 0) return parts.join(' — ');
  }
  return JSON.stringify(entry);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function ReflectionSection({ title, attention, empty, children }: {
  title: string;
  attention?: boolean;
  empty?: string;
  // Matches the existing `children: any` convention (stats-integrity.tsx,
  // stats-config.tsx, stats-operational.tsx) rather than a stricter preact
  // type not used elsewhere. Optional: the empty-state call sites pass no
  // children at all.
  children?: any;
}) {
  return (
    <div class={`reflection-section ${attention ? 'reflection-section--attention' : ''}`}>
      <h4 class="reflection-section__title">{title}</h4>
      {empty ? <p class="reflection-section__empty">{empty}</p> : <div class="reflection-section__body">{children}</div>}
    </div>
  );
}

/** Which colour a unified-diff line gets. Only genuine change markers are
 *  highlighted: `+++`/`---` file headers are checked BEFORE `+`/`-` so they
 *  read as headers, not as a one-character addition or removal. */
function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
    return 'diff-view__line diff-view__line--file';
  }
  if (line.startsWith('@@')) return 'diff-view__line diff-view__line--hunk';
  if (line.startsWith('+')) return 'diff-view__line diff-view__line--add';
  if (line.startsWith('-')) return 'diff-view__line diff-view__line--del';
  return 'diff-view__line';
}

/** A unified diff with per-line highlighting. Line-by-line spans in a <pre>,
 *  text nodes only — agent-authored patch text must never be interpreted as
 *  markup. The trailing '\n' stays on each rendered line so copy-paste from
 *  the browser reproduces the original patch byte-for-byte. */
function DiffView({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <pre class="diff-view">
      {lines.map((line, i) => (
        <span key={i} class={diffLineClass(line)}>
          {i < lines.length - 1 ? `${line}\n` : line}
        </span>
      ))}
    </pre>
  );
}

/** One proposed change: file, target repo (named in full — "public core" /
 *  "private overlay", matching this project's own vocabulary rather than the
 *  bare `core`/`overlay` enum value), rationale, and the diff behind a
 *  toggle. Collapsed by default: a proposal can carry up to three changes
 *  (schema.ts's `.max(3)`), each a full unified diff, and showing all of
 *  them open by default would bury the rationale — the sentence a reviewer
 *  actually needs to decide with — under raw patch text. */
function ReflectionChangeItem({ change }: { change: ProposedChange }) {
  const [showDiff, setShowDiff] = useState(false);
  return (
    <div class="reflection-change">
      <div class="reflection-change__meta">
        <code class="config-table__mono">{change.file}</code>
        <span class="badge badge--info">{change.target === 'core' ? 'public core' : 'private overlay'}</span>
      </div>
      <p class="reflection-section__summary">{change.rationale}</p>
      <button type="button" class="btn" onClick={() => setShowDiff((v) => !v)} aria-expanded={showDiff}>
        {showDiff ? 'Hide diff' : 'Show diff'}
      </button>
      {showDiff && <DiffView text={change.unifiedDiff} />}
    </div>
  );
}

function ReflectionChanges({ changes }: { changes: ProposedChange[] }) {
  if (changes.length === 0) {
    return <ReflectionSection title="Proposed changes" empty="No changes are proposed this cycle." />;
  }
  return (
    <ReflectionSection title="Proposed changes">
      {changes.map((c, i) => <ReflectionChangeItem key={`${c.file}-${i}`} change={c} />)}
    </ReflectionSection>
  );
}

function ReflectionAdjudications({ rows }: { rows: Adjudication[] }) {
  if (rows.length === 0) {
    return <ReflectionSection title="Disputed findings, adjudicated" empty="No disputed findings were adjudicated this cycle." />;
  }
  return (
    <ReflectionSection title="Disputed findings, adjudicated">
      <table class="config-table">
        <thead>
          <tr>
            <th>Severity</th>
            <th>Finding</th>
            <th>What the team said</th>
            <th>What we verified</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={`${a.prId}-${a.findingKey}`}>
              <td>{capitalize(a.severity)}</td>
              <td>{a.title}</td>
              <td>{a.humanQuote ? `"${a.humanQuote}"` : <span class="config-table__none">nothing quoted</span>}</td>
              <td>{describeEvidence(a.evidence, a.evidenceType)}</td>
              <td>{verdictText(a.verdictLabel)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ReflectionSection>
  );
}

function ReflectionWatchLedger({ entries }: { entries: unknown[] | null }) {
  const list = entries ?? [];
  if (list.length === 0) {
    return <ReflectionSection title="Watch ledger" empty="Nothing is on the watch ledger this cycle." />;
  }
  return (
    <ReflectionSection title="Watch ledger">
      <ul class="reflection-list">
        {list.map((entry, i) => <li key={i}>{describeWatchEntry(entry)}</li>)}
      </ul>
    </ReflectionSection>
  );
}

function ReflectionExpectedEffects({ effects }: { effects: ReflectionProposal['expectedEffects'] }) {
  const list = effects ?? [];
  if (list.length === 0) {
    return <ReflectionSection title="Expected effects next cycle" empty="No expected effects were pre-registered this cycle." />;
  }
  return (
    <ReflectionSection title="Expected effects next cycle">
      <ul class="reflection-list">
        {list.map((e, i) => <li key={i}>{e.metric}: {e.from} → {e.to}</li>)}
      </ul>
    </ReflectionSection>
  );
}

/** Commit SHAs for an applied proposal. `appliedCommits` can carry `core`,
 *  `overlay`, both, or (defensively) neither — a decided-but-not-yet-applied
 *  race is not possible through this UI, but a hand-edited row is. */
function AppliedCommits({ commits }: { commits: ReflectionProposal['appliedCommits'] }) {
  if (!commits || (!commits.core && !commits.overlay)) {
    return <p class="reflection-section__note">No commit SHAs were recorded for this apply.</p>;
  }
  return (
    <dl class="operational-dl">
      {commits.core && (
        <>
          <dt>Core commit</dt>
          <dd><code class="config-table__mono">{commits.core}</code></dd>
        </>
      )}
      {commits.overlay && (
        <>
          <dt>Overlay commit</dt>
          <dd><code class="config-table__mono">{commits.overlay}</code></dd>
        </>
      )}
    </dl>
  );
}

/**
 * The decision gate. Exactly one of the branches below renders, chosen by
 * `proposal.error` first and `proposal.status` second (see the module doc
 * comment). The literal approved-state sentence is pinned by the brief —
 * "apply reflection proposal N" is the exact phrase a person types into a
 * session, so the id is substituted into that sentence and nowhere else.
 */
function ReflectionDecisionArea({ proposal }: { proposal: ReflectionProposal }) {
  const busy = decisionBusy.value;
  const error = decisionError.value;
  const canDecide = !proposal.error && proposal.status === 'pending';

  return (
    <div class="reflection-decision">
      {canDecide && (
        <div class="reflection-decision__buttons">
          <button
            type="button"
            class="btn btn--success"
            disabled={busy !== null}
            onClick={() => void decide(proposal.id, 'approved')}
          >
            {busy === 'approved' ? 'Approving…' : 'Approve'}
          </button>
          <button
            type="button"
            class="btn btn--error"
            disabled={busy !== null}
            onClick={() => void decide(proposal.id, 'rejected')}
          >
            {busy === 'rejected' ? 'Rejecting…' : 'Reject'}
          </button>
        </div>
      )}
      {!proposal.error && proposal.status === 'approved' && (
        <p class="reflection-section__summary">
          Approved. To apply, open a session and say: apply reflection proposal {proposal.id}.
        </p>
      )}
      {!proposal.error && proposal.status === 'applied' && (
        <>
          <p class="reflection-section__summary">
            Applied{proposal.appliedAt ? ` ${formatRelativeTime(proposal.appliedAt)}` : ''}.
          </p>
          <AppliedCommits commits={proposal.appliedCommits} />
        </>
      )}
      {!proposal.error && proposal.status === 'rejected' && (
        <p class="reflection-section__summary">
          Rejected{proposal.decidedAt ? ` ${formatRelativeTime(proposal.decidedAt)}` : ''}.
        </p>
      )}
      {!proposal.error && proposal.status === 'superseded' && (
        <p class="reflection-section__summary">Superseded by a later run for this cycle.</p>
      )}
      {!proposal.error && proposal.status === null && (
        <p class="reflection-section__summary">This proposal's status was not recognised — check the database directly.</p>
      )}
      {error && (
        <button type="button" class="action-error" onClick={() => { decisionError.value = null; }} aria-label="Dismiss error">
          {error}
        </button>
      )}
    </div>
  );
}

/** The newest proposal, shown in full: every section below reads straight
 *  off the object regardless of status, INCLUDING a failed or already-decided
 *  one — a reviewer deciding whether to trust "Applied" still wants to see
 *  what shipped, and a failed row's sections simply render their own empty
 *  state (every content array on a failed row is `[]`, per reflect.ts's
 *  catch block) rather than needing a special-cased failure layout. */
function ReflectionProposalDetail({ proposal }: { proposal: ReflectionProposal }) {
  return (
    <article class="reflection-proposal reflection-proposal--newest">
      <div class="stats-slot__header">
        <span class="reflection-proposal__cycle">Cycle {proposal.cycleDate}</span>
        <span class="stats-slot__window" title="Days of history this cycle reviewed">{proposal.windowDays}-day window</span>
        <span class={`badge ${badgeClassForProposal(proposal)}`}>{describeProposalStatus(proposal)}</span>
      </div>

      {proposal.error && (
        <ReflectionSection title="This cycle did not complete" attention>
          <p class="reflection-section__summary">{proposal.error}</p>
        </ReflectionSection>
      )}

      <p class="reflection-section__summary">{describeCoverage(proposal.coverage)}</p>

      <ReflectionChanges changes={proposal.proposedChanges} />
      <ReflectionAdjudications rows={proposal.adjudications} />
      <ReflectionWatchLedger entries={proposal.watchLedger} />
      <ReflectionExpectedEffects effects={proposal.expectedEffects} />

      <ReflectionDecisionArea proposal={proposal} />
    </article>
  );
}

/** Older proposals: status + date only, per the brief — the newest section
 *  above is where the detail lives. `title` on the badge carries the error
 *  text for a failed older cycle, the same "don't hide it, don't spell it out
 *  in a fifth column either" trade-off the PR review list makes for its own
 *  truncated error line. */
function ReflectionHistory({ proposals }: { proposals: ReflectionProposal[] }) {
  return (
    <ReflectionSection title="Earlier cycles">
      <table class="config-table">
        <thead><tr><th>Cycle</th><th>Status</th></tr></thead>
        <tbody>
          {proposals.map((p) => (
            <tr key={p.id}>
              <td>{p.cycleDate}</td>
              <td>
                <span class={`badge ${badgeClassForProposal(p)}`} title={p.error ?? undefined}>
                  {describeProposalStatus(p)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ReflectionSection>
  );
}

export function ReflectionCard() {
  // Refetch on every mount, matching StatsView/AdminRepos: an operate-mode
  // screen showing a stale proposal list with no "stale" marker is worse
  // than a brief loading flash.
  useEffect(() => { void loadReflections(); }, []);
  const state = listState.value;

  return (
    <section id="reflection-card" class={`stats-slot stats-slot--${state.status}`} aria-label="Reflection proposals">
      <div class="stats-slot__header">
        <h3 class="stats-slot__title">Reflection proposals</h3>
      </div>
      <CardGlossary terms={TERMS} />
      {state.status === 'loading' && <p class="stats-slot__status-text">Loading…</p>}
      {state.status === 'error' && (
        <p class="stats-slot__status-text stats-slot__status-text--error">Failed to load: {state.message}</p>
      )}
      {state.status === 'empty' && <p class="stats-slot__status-text">No reflection cycles have run yet.</p>}
      {state.status === 'ready' && (
        <div class="reflection-card__body">
          <ReflectionProposalDetail proposal={state.proposals[0]!} />
          {state.proposals.length > 1 && <ReflectionHistory proposals={state.proposals.slice(1)} />}
        </div>
      )}
    </section>
  );
}
