import type { PRFinding } from '../../agents/pr-reviewer/schema.ts';
import type { ReviewThread } from './pull-requests.ts';
import { findingKey, extractKey } from './finding-key.ts';

export type ThreadAction =
  | { kind: 'create'; finding: PRFinding; key: string }
  | { kind: 'update'; threadId: number; commentId: number; finding: PRFinding; key: string }
  | { kind: 'stale'; threadId: number; key: string };

const INLINE_SEVERITIES = new Set(['critical', 'major']);
const SEVERITY_ORDER: Record<string, number> = { critical: 0, major: 1 };

/**
 * Decide what to do with each inline thread, given this review's findings and the
 * threads already on the PR. Pure — no network, no clock.
 *
 * Four rules the tests pin, each for a measured reason:
 *
 * - A finding that vanished yields `stale`, never a close. Reviewers on this
 *   codebase contradict themselves round to round (WI 63396), so a finding
 *   disappearing is not evidence it was fixed.
 * - A thread with no marker is untouched. It belongs to a human, and their
 *   "by design, see ticket X" reply has to survive.
 * - The cap applies to CREATES only. Capping updates would strand an existing
 *   thread showing stale text, which is worse than one extra thread.
 * - The suppression set (which findings count as "still detected") is built
 *   from EVERY finding that has a file, at ANY severity — not just the
 *   inline-eligible ones. A finding downgraded to minor this round, or
 *   re-raised without a line, is still detected; replying "not detected" to
 *   its thread would be a false statement.
 * - `opts.suppressStale` skips the stale loop entirely. A backport sanity
 *   review never examines style, performance or security, so on a PR that
 *   already carries full-review threads for those domains, its first finding
 *   of any kind would otherwise stamp all of them "not detected" — a false
 *   statement posted to a live PR. The finding it DOES raise still creates or
 *   updates its own thread; only the "not detected" side is suppressed.
 */
export function reconcileFindings(
  findings: PRFinding[],
  threads: ReviewThread[],
  cap = 5,
  opts: { suppressStale?: boolean } = {},
): ThreadAction[] {
  const existing = new Map<string, ReviewThread>();
  for (const t of threads) {
    // ANCHORED threads only. Every thread we create is anchored, so requiring a
    // filePath costs nothing and closes a nasty echo: the orchestrator reads
    // existing PR comments in Phase 2, and if it ever copies a marker into the
    // summary it posts, an unguarded match would "update" the summary thread —
    // overwriting the entire review with one finding's body.
    if (!t.filePath) continue;
    const key = extractKey(t.rawContent);
    // First-wins: agrees with buildPriorFindingsBlock's own `seen` dedup in
    // review-pr.ts, which keeps the first thread it encounters per key. Two
    // halves of the feature disagreeing about which duplicate is canonical is
    // exactly the ambiguity a fork produces.
    if (key && !existing.has(key)) existing.set(key, t);
  }

  const eligible = findings
    .filter((f) => INLINE_SEVERITIES.has(f.severity) && f.file && f.line != null)
    .map((f) => ({ finding: f, key: findingKey(f.file!, f.title) }))
    .sort((a, b) => (SEVERITY_ORDER[a.finding.severity] ?? 9) - (SEVERITY_ORDER[b.finding.severity] ?? 9));

  // Suppression set: EVERY finding that has a file, at ANY severity — not just the
  // inline-eligible ones. A finding downgraded to minor this round, or re-raised
  // without a line, is still DETECTED; replying "not detected" to its thread would
  // be a false statement. Severity flapping between rounds is measured on this
  // codebase (WI 63396), so this is the common case, not a corner.
  const detected = new Set(
    findings.filter((f) => f.file).map((f) => findingKey(f.file!, f.title)),
  );

  const actions: ThreadAction[] = [];
  const handled = new Set<string>();
  let created = 0;

  for (const { finding, key } of eligible) {
    // Two findings in one review whose file+normalised title collide: the first
    // wins the thread, the second stays summary-only. Deliberate dedup, not a drop.
    if (handled.has(key)) continue;
    handled.add(key);
    const thread = existing.get(key);
    if (thread) {
      actions.push({ kind: 'update', threadId: thread.id, commentId: thread.firstCommentId, finding, key });
    } else if (created < cap) {
      actions.push({ kind: 'create', finding, key });
      created++;
    }
  }

  // A backport sanity review examines only the port — it never looks at style,
  // performance or security, so it has no basis to declare a finding from a full
  // review "not detected". Emitting one would post a false statement to the PR.
  if (!opts.suppressStale) {
    for (const [key, thread] of existing) {
      if (detected.has(key)) continue;
      // Do not append a second "not detected" notice to a thread that already ends
      // with one. Without this the 37-review PR accrues one reply per thread per
      // review forever, and the design's "bounded" promise is false.
      if (thread.lastCommentIsStaleNotice) continue;
      actions.push({ kind: 'stale', threadId: thread.id, key });
    }
  }

  return actions;
}
