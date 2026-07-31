import { describe, test, expect } from 'bun:test';
import { reconcileFindings } from '../../../src/sdk/ado/reconcile-findings.ts';
import { findingKey, markerFor } from '../../../src/sdk/ado/finding-key.ts';

const f = (severity: any, title: string, file?: string, line?: number) =>
  ({ severity, title, file, line, body: 'b' }) as any;

// Note: unlike the brief's sample, this sets `lastCommentIsStaleNotice` explicitly —
// it is a required field on `ReviewThread` (added in Task 2), and omitting it would
// fail `bun run typecheck` under strict mode even though `bun test` alone would not
// catch the gap.
const thread = (id: number, key: string, opts: { staleNoticed?: boolean; unanchored?: boolean } = {}) =>
  ({
    id,
    firstCommentId: id * 10,
    rawContent: `${markerFor(key)}\nold`,
    lastCommentIsStaleNotice: opts.staleNoticed ?? false,
    filePath: opts.unanchored ? undefined : '/A.al',
    line: 1,
  }) as any;

describe('reconcileFindings', () => {
  test('creates a thread for a new critical finding', () => {
    const a = reconcileFindings([f('critical', 'Boom', 'A.al', 5)], []);
    expect(a).toHaveLength(1);
    expect(a[0]!.kind).toBe('create');
  });

  test('updates in place when the finding is raised again', () => {
    const key = findingKey('A.al', 'Boom');
    const a = reconcileFindings([f('critical', 'Boom', 'A.al', 5)], [thread(3, key)]);
    expect(a[0]).toMatchObject({ kind: 'update', threadId: 3, commentId: 30 });
  });

  test('marks a vanished finding stale — never resolved, never closed', () => {
    const key = findingKey('A.al', 'Gone');
    const a = reconcileFindings([], [thread(4, key)]);
    expect(a).toEqual([{ kind: 'stale', threadId: 4, key }]);
  });

  test('ignores threads with no marker — those are humans', () => {
    const human = { id: 8, firstCommentId: 80, rawContent: 'looks fine', lastCommentIsStaleNotice: false, filePath: '/A.al', line: 2 };
    expect(reconcileFindings([], [human as any])).toEqual([]);
  });

  test('excludes minor and nitpick from inline entirely', () => {
    const a = reconcileFindings([f('minor', 'M', 'A.al', 1), f('nitpick', 'N', 'A.al', 2)], []);
    expect(a).toEqual([]);
  });

  test('excludes findings with no resolvable location', () => {
    expect(reconcileFindings([f('critical', 'No file')], [])).toEqual([]);
  });

  test('caps creates at 5 and takes critical before major', () => {
    const many = [
      ...Array.from({ length: 4 }, (_, i) => f('major', `Maj${i}`, 'A.al', i + 1)),
      ...Array.from({ length: 3 }, (_, i) => f('critical', `Crit${i}`, 'A.al', i + 20)),
    ];
    const created = reconcileFindings(many, []).filter((x) => x.kind === 'create');
    expect(created).toHaveLength(5);
    expect(created.slice(0, 3).every((c: any) => c.finding.severity === 'critical')).toBe(true);
  });

  test('the cap never suppresses an update to an existing thread', () => {
    // 5 fresh criticals would fill the cap; the 6th finding already has a thread.
    const key = findingKey('A.al', 'Existing');
    const findings = [
      ...Array.from({ length: 5 }, (_, i) => f('critical', `C${i}`, 'A.al', i + 1)),
      f('critical', 'Existing', 'A.al', 99),
    ];
    const actions = reconcileFindings(findings, [thread(6, key)]);
    expect(actions.some((a) => a.kind === 'update' && a.threadId === 6)).toBe(true);
  });

  // --- Additional tests beyond the brief's floor, to pin rules the 8 above don't discriminate ---

  test('a finding downgraded to minor still suppresses the stale notice — it was detected, just not inline-eligible', () => {
    // Severity flapping is the common case on this codebase (WI 63396): a finding
    // raised as critical last round and reported as minor this round is still
    // DETECTED. Telling its existing thread "not detected" would be a false
    // statement. The finding itself must NOT get a create/update either, since
    // minor findings are excluded from inline entirely.
    const key = findingKey('A.al', 'Downgraded');
    const a = reconcileFindings([f('minor', 'Downgraded', 'A.al', 5)], [thread(1, key)]);
    expect(a).toEqual([]);
  });

  test('a thread already carrying a stale notice does not get a second one', () => {
    // Without this a long-lived PR accrues one "not detected" reply per thread per
    // review forever, which breaks the "bounded" promise of the feature.
    const key = findingKey('A.al', 'Gone');
    const a = reconcileFindings([], [thread(4, key, { staleNoticed: true })]);
    expect(a).toEqual([]);
  });

  test('a marker sitting in an unanchored thread (no filePath) is never matched — the summary-comment echo guard', () => {
    // Every thread this feature creates is anchored. If a marker ever leaked into
    // the unanchored summary comment (e.g. by an echo bug), it must NOT be treated
    // as an existing thread — that would silently overwrite the whole review with
    // one finding's body. A finding whose key collides with such a marker must
    // still get a fresh CREATE, proving the anchored-only filter actually excludes it.
    const key = findingKey('A.al', 'Echoed');
    const unanchored = thread(2, key, { unanchored: true });
    const a = reconcileFindings([f('critical', 'Echoed', 'A.al', 3)], [unanchored]);
    expect(a).toEqual([{ kind: 'create', finding: expect.objectContaining({ title: 'Echoed' }), key }]);
  });

  test('when two existing threads share a key, the first one encountered is canonical — agrees with buildPriorFindingsBlock\'s own first-wins dedup', () => {
    // review-pr.ts's buildPriorFindingsBlock keeps the first marker thread it sees
    // per key; this map must agree, or the two halves of the feature point a
    // re-review's update at a different duplicate than the one the model was
    // shown — the state a fork produces.
    const key = findingKey('A.al', 'Boom');
    const first = thread(1, key);
    const second = thread(2, key);
    const a = reconcileFindings([f('critical', 'Boom', 'A.al', 5)], [first, second]);
    expect(a).toEqual([{ kind: 'update', threadId: 1, commentId: 10, finding: expect.objectContaining({ title: 'Boom' }), key }]);
  });

  test('two findings colliding on the same key in one review: the first claims the thread, the second is dropped', () => {
    // Deliberate dedup (declined for change in plan review): same file + same
    // normalised title within a single review's findings list collide to one key.
    const a = reconcileFindings(
      [f('critical', 'Dup', 'A.al', 1), f('critical', 'Dup', 'A.al', 99)],
      [],
    );
    expect(a).toHaveLength(1);
    expect((a[0] as any).finding.line).toBe(1);
  });

  test('suppressStale leaves prior threads alone — a review that did not look cannot say "not detected"', () => {
    // A backport sanity review deliberately never examines style, performance or
    // security. Without suppression, its first finding of any kind would stamp
    // "not detected" on every thread a full review opened for those domains — a
    // false statement posted to a live PR.
    const other = findingKey('A.al', 'A style nit from the full review');
    const mine = findingKey('A.al', 'Partial port');
    const threads = [thread(3, other), thread(4, mine)];
    const findings = [f('major', 'Partial port', 'A.al', 5)];

    const withStale = reconcileFindings(findings, threads);
    expect(withStale.some((a) => a.kind === 'stale' && a.threadId === 3)).toBe(true);

    const suppressed = reconcileFindings(findings, threads, 5, { suppressStale: true });
    expect(suppressed.some((a) => a.kind === 'stale')).toBe(false);
    // The finding it DID raise must still update its own thread.
    expect(suppressed.some((a) => a.kind === 'update' && a.threadId === 4)).toBe(true);
  });

  test('negative control: suppressStale defaulting to false (opts omitted) still marks stale — the flag is opt-in', () => {
    // Guards against an inverted or always-on guard: calling with the same
    // arguments as every pre-existing test above must keep today's behaviour.
    const key = findingKey('A.al', 'Gone');
    const a = reconcileFindings([], [thread(4, key)], 5, {});
    expect(a).toEqual([{ kind: 'stale', threadId: 4, key }]);
  });

  test('negative control: suppressStale explicitly false behaves identically to omitting opts', () => {
    const key = findingKey('A.al', 'Gone');
    const a = reconcileFindings([], [thread(4, key)], 5, { suppressStale: false });
    expect(a).toEqual([{ kind: 'stale', threadId: 4, key }]);
  });
});
