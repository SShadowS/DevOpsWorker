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
const css = readFileSync(join(clientDir, 'styles', 'dashboard.css'), 'utf8');

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
// Anchored on the left the same way as the original: `(?<![\w-])color:` so this never matches
// `border-color:` or `border-left-color:` (both legitimately keep `--color-error` — they are
// not held to a text-contrast bar).
const ERROR_TEXT_COLOR_RE = /(?<![\w-])color:\s*['"]?(var\(--color-(?:error|stage-error)(?![\w-])[^)'"]*\)|#ef4444)['"]?/gi;

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

  test('no rule sets `color:` to the border-weight --color-error, in any written form, in dashboard.css', () => {
    // The whole point of the split: --color-error keeps its saturated value for borders
    // and tints, and must never be used for text again.
    expect(findErrorTextColorRules(css)).toEqual([]);
  });

  test('no client .tsx component sets `color:` to the border-weight --color-error', () => {
    // Task 1's brief scoped the guard to dashboard.css, so nobody looked at inline
    // `style={{ color: ... }}` in TSX — which is exactly where the actual bug (this branch's
    // fix-wave item 1) survived. Scanning the client tree, not just the stylesheet, is what
    // would have caught it.
    const offenders: Array<{ file: string; rules: string[] }> = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.tsx')) {
          const rules = findErrorTextColorRules(readFileSync(full, 'utf8'));
          if (rules.length > 0) offenders.push({ file: full, rules });
        }
      }
    };
    walk(clientDir);
    expect(offenders).toEqual([]);
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
    // and it must NOT fire on the correct token, its fallback form, or border/background uses
    expect(findErrorTextColorRules('.x { color: var(--color-error-text); }')).toEqual([]);
    expect(findErrorTextColorRules('.x { color: var(--color-error-text, #ff8a8a); }')).toEqual([]);
    expect(findErrorTextColorRules('.x { border-color: var(--color-error); }')).toEqual([]);
    expect(findErrorTextColorRules('.x { background: var(--color-error); }')).toEqual([]);
  });

  test('--color-error itself is unchanged, so borders and tints keep their weight', () => {
    expect(token('color-error')).toBe('#ef4444');
  });
});
