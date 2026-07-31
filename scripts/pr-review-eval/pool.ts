// scripts/pr-review-eval/pool.ts
/**
 * Replaces the `mustCatch: []` scoring that returned `catchRate = 1` for an
 * empty list and so could never detect a variant that got WORSE.
 *
 * The design in one sentence: pool every arm's findings for one PR into a
 * single deduplicated list, have a judge grade each pooled entry exactly
 * once (see `judge.ts`), then score each arm against the graded pool. That
 * is what makes judging 8 arms affordable — cost scales with DISTINCT
 * findings on a PR, not arms x findings — and it is what makes "missed"
 * measurable at all, which the old `mustCatch: []` design could not do.
 */

export type Grade = 'real-bug' | 'nit' | 'false-positive' | 'unverifiable';

/**
 * A single arm's finding, in the shape `pr_reviews.findings_list` actually
 * stores it — see `PRFindingSchema` in `src/agents/pr-reviewer/schema.ts`:
 * `{severity, title, body, file?, line?, location?}`. This is deliberately
 * NOT a markdown-parsed shape: `findings_list` is already structured JSON,
 * present on every review path including NO-POST, so there is nothing to
 * parse.
 *
 * `file`, `line`, and `location` are all optional because none of the three
 * is universal in practice: a live sample of 356 findings had `location` on
 * 273 of them and `file` on 314 — so a dedupe key that assumes either is
 * always present would silently mis-key roughly a fifth to a tenth of real
 * findings. See `keyOf` for the fallback order this forces.
 */
export interface ExtractedFinding {
  title: string;
  file?: string;
  line?: number;
  location?: string;
  /** Carried through for callers that want it; not used for pooling itself. */
  severity?: string;
  /** Carried through for callers that want it; not used for pooling itself. */
  body?: string;
}

export interface PooledFinding {
  key: string;
  title: string;
  file: string;
  location: string;
  /**
   * Only set when the finding had no `location` but did have a `line` — the
   * fallback case in `keyOf`. Lets a caller (e.g. the judge prompt) show
   * SOME position even when `location` is blank, instead of silently
   * dropping the one coordinate that fallback key actually used.
   */
  line?: number;
  raisedBy: string[];
}

export interface ArmScore {
  arm: string;
  caught: number;
  missed: number;
  falsePositives: number;
  nits: number;
  /**
   * Pooled findings THIS arm raised that the judge could not settle from the
   * diff (`grade === 'unverifiable'`, see C5 below). Excluded from every
   * other counter — kept here instead of silently vanishing, so an arm that
   * raises a lot of unsettleable cross-file claims doesn't quietly look
   * cleaner than it is just because none of them could be graded.
   */
  unverifiable: number;
}

/**
 * Dedupe key for one finding.
 *
 * Deliberately excludes:
 * - `title`, in the normal case — two arms describe the same defect in
 *   different words ("Missing timeout" vs "No timeout configured"), and
 *   keying on title would treat those as different findings, defeating the
 *   entire point of pooling. (Title comes back into play only in the
 *   last-resort bucket below, where there is nothing else left to key on.)
 * - a PR id. Pooling is per-PR BY CONSTRUCTION — see `poolFindings`'s doc
 *   comment — not by a key component. An earlier draft of this module
 *   threaded a `prId` through `keyOf(prId, f)` while `poolFindings` called
 *   it with one argument and had no `prId` parameter at all (did not
 *   compile). The cheap fix — deleting `prId` — is exactly what this
 *   function does, but doing THAT alone would silently reintroduce
 *   cross-PR merging if a caller ever pooled two PRs' findings in one call.
 *   The actual fix is the calling convention documented on `poolFindings`,
 *   not a key component; there is nothing to delete because there was never
 *   a safe way to encode "PR-scoped" in a key without a prId that then has
 *   to be threaded everywhere anyway.
 *
 * Fallback order, because neither `location` nor `file` is universal (see
 * `ExtractedFinding`'s doc comment for the measured proportions):
 *   1. `file` + `location` — the normal case.
 *   2. `file` + `line` — `location` absent, but the finding still names a
 *      line on a known file.
 *   3. `file` + `title`, tagged `unlocated::` — neither `location` nor
 *      `line`. Still lets two arms that raise the exact same title on the
 *      exact same file merge (a real, if weak, dedupe signal), while a
 *      single global "no location" bucket — dropping file and title both —
 *      would instead merge every unrelated unlocated finding on the PR into
 *      one false "raised by everyone" entry. That is the "collapsing them
 *      together" failure this fallback exists to avoid.
 *   4. `title` alone, tagged `unlocated::` — no file either. Rare in
 *      practice; kept distinct by title so two genuinely different fileless
 *      findings don't collapse (two different findings that happen to share
 *      an exact title would still merge — an accepted, visible trade-off,
 *      not a silent one).
 *
 * None of these branches drops a finding — every finding produces a key and
 * ends up in the pool.
 */
function keyOf(f: ExtractedFinding): string {
  const file = (f.file ?? '').trim().toLowerCase();
  const location = (f.location ?? '').trim().toLowerCase();
  if (location) return `${file}::${location}`;
  if (file && typeof f.line === 'number') return `${file}::line${f.line}`;
  const title = (f.title ?? '').trim().toLowerCase();
  return file ? `unlocated::${file}::${title}` : `unlocated::${title}`;
}

/**
 * Merge every arm's findings into one pool, de-duplicated by file + location
 * (see `keyOf` for the exact key and its fallback order).
 *
 * PER-PR BY CONSTRUCTION. This function has no PR identity of its own — it
 * pools whatever is in `perArm`, full stop. The caller MUST invoke it ONCE
 * PER PR, passing only that PR's findings. Passing findings from two PRs in
 * a single call would merge them if they happened to land on the same
 * file+location, crediting an arm with "caught" on a PR it never actually
 * reviewed. There is deliberately no `prId` parameter to enforce this at the
 * type level — see `keyOf`'s doc comment for why threading one through
 * would not actually buy safety here — so this is a calling convention the
 * harness (not this module) is responsible for upholding: one call per PR,
 * never a merged batch across PRs.
 *
 * The judge then grades each pooled entry ONCE (see `judgePooledFinding` in
 * `judge.ts`), blind to which arms raised it. That is what makes judging N
 * arms affordable: cost scales with distinct findings on a PR, not
 * arms x findings.
 *
 * Builds a fresh `Map` on every call — no module-level or cross-call state.
 * That is what actually keeps two calls (two PRs) from leaking into each
 * other; see the "two separate calls never share state" test.
 */
export function poolFindings(perArm: Record<string, ExtractedFinding[]>): PooledFinding[] {
  const byKey = new Map<string, PooledFinding>();
  for (const [arm, findings] of Object.entries(perArm)) {
    for (const f of findings) {
      const key = keyOf(f);
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.raisedBy.includes(arm)) existing.raisedBy.push(arm);
      } else {
        byKey.set(key, {
          key,
          title: f.title,
          file: f.file ?? '',
          location: f.location ?? '',
          ...(f.location == null && typeof f.line === 'number' ? { line: f.line } : {}),
          raisedBy: [arm],
        });
      }
    }
  }
  return [...byKey.values()];
}

/**
 * Score one arm against the graded pool.
 *
 * `missed` is the metric the old `mustCatch: []` harness could not produce:
 * a real finding some OTHER arm raised and this one did not. It is the only
 * guard against "delete every agent" winning on cost.
 *
 * `grade === 'unverifiable'` (correction C5) is excluded from `caught`,
 * `missed`, `falsePositives` AND `nits` alike, for every arm, whether or not
 * that arm raised it. Every one of the existing dataset's `mustNotRaise`
 * anchors is a finding whose falseness lives OUTSIDE the diff (a callee
 * committing several frames down, an `OnValidate` cascade, a
 * `Codeunit.Run`-with-TableNo auto-commit) — a diff-only judge forced to pick
 * from {real-bug, nit, false-positive} grades those `real-bug`, so an arm
 * that raises cross-file findings would accumulate false "caught" credit
 * while an arm that correctly stays quiet gets debited "missed". Excluding
 * `unverifiable` from every counter is what keeps that from happening; it is
 * still counted separately (`unverifiable`, and only for the arm that raised
 * it) so the uncertainty stays visible instead of vanishing into a 0.
 *
 * A key absent from `grades` entirely (not yet graded) is treated the same
 * way — excluded from everything — so a partially-graded pool degrades
 * gracefully instead of miscounting.
 */
export function scoreArmAgainstPool(
  arm: string,
  pool: PooledFinding[],
  grades: Record<string, Grade>,
): ArmScore {
  let caught = 0;
  let missed = 0;
  let falsePositives = 0;
  let nits = 0;
  let unverifiable = 0;

  for (const p of pool) {
    const grade = grades[p.key];
    const raised = p.raisedBy.includes(arm);
    if (grade === 'real-bug') {
      if (raised) caught++;
      else missed++;
    } else if (grade === 'false-positive') {
      if (raised) falsePositives++;
    } else if (grade === 'nit') {
      if (raised) nits++;
    } else if (grade === 'unverifiable') {
      if (raised) unverifiable++;
    }
    // grade === undefined (ungraded) falls through untouched, same as unverifiable.
  }

  return { arm, caught, missed, falsePositives, nits, unverifiable };
}
