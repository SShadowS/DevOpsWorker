import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// WCAG 2.1 relative luminance. Duplicated here on purpose: this test's job is to be an
// independent check on the CSS, so it must not import anything the CSS could also be
// wrong about.
function luminance(hex: string): number {
  const c = hex.replace('#', '');
  const parts = [0, 2, 4].map((i) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * parts[0]! + 0.7152 * parts[1]! + 0.0722 * parts[2]!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const clientDir = fileURLToPath(new URL('../../src/dashboard/client/', import.meta.url));
const TOKENS_CSS = join(clientDir, 'styles', 'dashboard.css');
const css = readFileSync(TOKENS_CSS, 'utf8');

/**
 * Every file that can put a colour on screen: stylesheets, components, and the plain `.ts`
 * helpers that build style strings. Named by extension rather than by path, because the two
 * misses this guard has already had were both scope misses — the first version read only
 * `dashboard.css` and never saw the TSX inline styles that carried the real bug, and a
 * `.tsx`-only filter would still skip a `.ts` helper emitting the same thing.
 */
function styleBearingFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) styleBearingFiles(full, acc);
    else if (/\.(css|tsx?)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

function token(name: string): string {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`token --${name} not found`);
  return m[1]!;
}

// Catches every way this codebase has actually written a `color:` rule that resolves to
// the border-weight red (3.89:1 / 3.31:1, below WCAG AA):
//   - `var(--color-error)`               — the original bug
//   - `var(--color-error, #ef4444)`      — this file's fallback idiom (dashboard.css:1508-1529);
//     the FIRST version of this guard (`/color:\s*var\(--color-error\)/g`) missed this form,
//     which is exactly what let the original count come in at 18 instead of 16.
//   - `var(--color-stage-error)`         — the alias (dashboard.css:42, `--color-stage-error:
//     var(--color-error)`); same failing color under a different name.
//   - `'var(--color-error)'` / `"var(--color-error)"` — the TSX inline-style form
//     (`style={{ color: 'var(--color-error)' }}`), quoted, which a CSS-only regex never sees.
//   - a raw `#ef4444` literal, quoted or not — bypasses the token entirely but is the same
//     failing color. Included deliberately: the token split (Task 1) exists to keep this red
//     off text, and a hard-coded hex is a straight bypass of that guarantee, not a narrower
//     case of it. `#ef4444` is matched by exact value, not "any reddish hex" — a broader hex
//     sweep would flag unrelated colors (e.g. `color: #f7768e` at dashboard.css:1206) that
//     have nothing to do with this token.
//
// `(?![\w-])` after each token name (not `\b`) is required, not decorative: `\b` sits between
// a word char and a non-word char, and `-` counts as non-word — so `\b` alone would match
// `--color-error` as a prefix of `--color-error-text` (the CORRECT token) and flag it as an
// offender. `(?![\w-])` additionally forbids a following hyphen, so it stops at the real
// token boundary.
//
//   - `rgb(239, 68, 68)` / `rgba(239, 68, 68, …)` — the same red spelled a third way. Not
//     hypothetical: `rgba(239, 68, 68, …)` is already native to this file, written 14 times
//     for backgrounds, so it is the spelling most likely to be reached for next. Matched by
//     exact channel values, and only after `color:`, so those 14 backgrounds stay ignored.
//
// Left anchor: `(?<![\w-])color:` so this never matches `border-color:` or
// `border-left-color:` (both legitimately keep `--color-error` — they are not held to a
// text-contrast bar). `-webkit-text-fill-color` is spelled out as a second alternative
// because it DOES paint text, and the left anchor that correctly excludes `border-color`
// would otherwise exclude it too. Its JSX spelling `WebkitTextFillColor` is a THIRD
// alternative for the same reason: the anchor excludes that too, and this scan covers `.tsx`
// precisely because that is where the original bug lived — covering only the CSS spelling
// would leave the hole in the one file type the widening exists for. Zero uses of either
// today; listed so the guard does not have a hole the moment someone reaches for it.
//
// Known NOT covered, deliberately, as of 2026-08-03 — each would be a real bypass, none is
// reachable from anything in the tree today:
//   - `rgb(239 68 68)` / `rgb(239 68 68 / 90%)` — CSS Color Level 4 space-separated syntax.
//   - `color: color-mix(in srgb, var(--color-error) 80%, white)` — the token reached
//     indirectly. This file already uses `color-mix` for tints (dashboard.css:818,819,910).
//   - re-aliasing the raw hex under a new token (`--red: #ef4444` then `color: var(--red)`),
//     which is exactly what the deleted `index-legacy.html` did.
const ERROR_TEXT_COLOR_RE =
  /(?:(?<![\w-])color|-webkit-text-fill-color|WebkitTextFillColor):\s*['"]?(var\(--color-(?:error|stage-error)(?![\w-])[^)'"]*\)|#ef4444|rgba?\(\s*239\s*,\s*68\s*,\s*68\b[^)]*\))['"]?/gi;

function findErrorTextColorRules(source: string): string[] {
  return source.match(ERROR_TEXT_COLOR_RE) ?? [];
}

describe('error text contrast', () => {
  const backgrounds = ['color-bg-primary', 'color-bg-secondary', 'color-bg-tertiary'];

  test('--color-error-text meets WCAG AA on all three base background surfaces', () => {
    // Covers the three solid `--color-bg-*` surfaces the token is declared against.
    // It does NOT cover tinted composites (e.g. the 18%-red-tinted badge backgrounds built
    // with `color-mix(in srgb, var(--color-error) 18%, transparent)`), which need alpha
    // compositing over a variable parent background to evaluate correctly — a materially
    // bigger test than this file's plain two-hex `contrast()` helper. Those were measured by
    // hand for the final review (worst case 4.751 on an 18%-tinted bg-tertiary badge, 5.491 on
    // plain tertiary, 7.867 on bg-primary) and the token holds on all of them; that measurement
    // lives in the plan ledger, not re-derived here. The name says "base background surfaces"
    // rather than "every surface it renders on" so it doesn't claim coverage this assertion
    // doesn't have.
    const fg = token('color-error-text');
    for (const bg of backgrounds) {
      expect(contrast(fg, token(bg))).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('nothing in the client sets `color:` to the border-weight --color-error, in any form', () => {
    // One scan over every style-bearing file rather than a stylesheet check plus a component
    // check. The split version is how the original miss happened: the guard read
    // `dashboard.css` by name, so the inline `style={{ color: ... }}` in TSX that carried the
    // real bug was outside everything it looked at. A scan named by extension picks up a
    // second stylesheet, or a `.ts` helper building a style string, without anyone
    // remembering to widen it.
    const offenders = styleBearingFiles(clientDir)
      .map((file) => ({ file, rules: findErrorTextColorRules(readFileSync(file, 'utf8')) }))
      .filter((o) => o.rules.length > 0);
    expect(offenders).toEqual([]);
  });

  test('the scan reaches every kind of style-bearing file, not just the ones that exist today', () => {
    // Guards the guard's own scope — the thing that was wrong twice. If this ever finds no
    // `.css`, no `.ts` and no `.tsx`, the sweep above is silently covering less than it reads
    // as covering.
    const files = styleBearingFiles(clientDir);
    expect(files.some((f) => f.endsWith('.css'))).toBe(true);
    expect(files.some((f) => f.endsWith('.tsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('.ts') && !f.endsWith('.tsx'))).toBe(true);
    expect(files).toContain(TOKENS_CSS);
  });

  test('the widened regex actually fires — a guard that cannot fail proves nothing', () => {
    // Direct unit checks on the regex itself, independent of the current file contents,
    // so this test does not silently pass if dashboard.css and the client tree ever both
    // happen to be clean. Each of these is a form that bit this codebase once.
    expect(findErrorTextColorRules('.x { color: var(--color-error); }')).toHaveLength(1);
    expect(findErrorTextColorRules('.x { color: var(--color-error, #ef4444); }')).toHaveLength(1);
    expect(findErrorTextColorRules('.x { color: var(--color-stage-error); }')).toHaveLength(1);
    expect(findErrorTextColorRules("style={{ color: 'var(--color-error)' }}")).toHaveLength(1);
    expect(findErrorTextColorRules('style={{ color: "var(--color-error)" }}')).toHaveLength(1);
    expect(findErrorTextColorRules('.x { color: #ef4444; }')).toHaveLength(1);
    // The three forms the widening added. Pinned because reverting the regex to its
    // pre-widening form left every other assertion in this file green — the capability
    // was unguarded, which is the same shape as a guard that cannot fail.
    expect(findErrorTextColorRules('.x { color: rgb(239, 68, 68); }')).toHaveLength(1);
    expect(findErrorTextColorRules('.x { color: rgba(239, 68, 68, 0.9); }')).toHaveLength(1);
    expect(findErrorTextColorRules('.x { -webkit-text-fill-color: var(--color-error); }')).toHaveLength(1);
    // ...and its JSX spelling. `-webkit-text-fill-color` only ever appears that way in CSS;
    // in the TSX inline styles this scan exists to cover it is written `WebkitTextFillColor`,
    // which the `(?<![\w-])` anchor excludes. Covering only the CSS spelling would leave the
    // hole in exactly the file type that carried the original bug.
    expect(findErrorTextColorRules("style={{ WebkitTextFillColor: 'var(--color-error)' }}")).toHaveLength(1);
    // and it must NOT fire on the correct token, its fallback form, or border/background uses
    expect(findErrorTextColorRules('.x { color: var(--color-error-text); }')).toEqual([]);
    expect(findErrorTextColorRules('.x { color: var(--color-error-text, #ff8a8a); }')).toEqual([]);
    expect(findErrorTextColorRules('.x { border-color: var(--color-error); }')).toEqual([]);
    expect(findErrorTextColorRules('.x { background: var(--color-error); }')).toEqual([]);
    // The 14 native `rgba(239, 68, 68, …)` backgrounds must stay ignored — the channel-value
    // alternative is what could have swept them in.
    expect(findErrorTextColorRules('.x { background: rgba(239, 68, 68, 0.18); }')).toEqual([]);
    expect(findErrorTextColorRules("style={{ borderColor: 'var(--color-error)' }}")).toEqual([]);
  });

  test('--color-error itself is unchanged, so borders and tints keep their weight', () => {
    expect(token('color-error')).toBe('#ef4444');
  });
});
