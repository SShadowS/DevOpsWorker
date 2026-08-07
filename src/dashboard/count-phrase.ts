/**
 * Count-agreement helpers for prose that renders a number.
 *
 * Extracted after three consecutive review rounds found the same defect class
 * on the review-value card: a clause that names a count but hard-codes the
 * plural form, so it reads correctly for every value except 1 — and 1 is
 * reachable for essentially every count on that card. The last round found
 * three more of them *inside the functions written that round to eliminate the
 * previous three*, which is the signal that hand-writing the agreement is the
 * problem rather than any individual sentence.
 *
 * The point of these functions is not brevity. It is that
 * `countOf(n, 'finding')` has no plural form to forget, so the next one cannot
 * be written by accident — where `` `${n} finding(s)` `` and a hardcoded verb
 * always can.
 *
 * Zero-dependency leaf module on purpose, like `coverage-thresholds.ts`:
 * `stats.ts` is server-only (`node:fs`, `Bun.spawn`), so a browser-bundled
 * component may only ever `import type` from it. Both sides need these, so
 * they live in neither.
 *
 * No i18n intent — this dashboard is English-only, and pretending otherwise
 * would be a larger lie than "finding(s)".
 */

/** `1 finding` / `3 findings`. Pass `plural` for anything not formed by +s. */
export function countOf(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}

/** Subject-verb agreement for a subject of size `n`: `agree(1, 'carries',
 *  'carry')` -> `'carries'`. Both forms are required — there is no default
 *  that is right often enough to be safe. */
export function agree(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}

/** `it` / `them` for a referent of size `n`. */
export function itThem(n: number): string {
  return n === 1 ? 'it' : 'them';
}
