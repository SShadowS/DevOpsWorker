import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

const css = readFileSync(
  fileURLToPath(new URL('../../src/dashboard/client/styles/dashboard.css', import.meta.url)),
  'utf8',
);

function token(name: string): string {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`token --${name} not found`);
  return m[1]!;
}

describe('error text contrast', () => {
  const backgrounds = ['color-bg-secondary', 'color-bg-tertiary'];

  test('--color-error-text meets WCAG AA on every surface it renders on', () => {
    const fg = token('color-error-text');
    for (const bg of backgrounds) {
      expect(contrast(fg, token(bg))).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('no rule sets `color:` to the border-weight --color-error', () => {
    // The whole point of the split: --color-error keeps its saturated value for borders
    // and tints, and must never be used for text again.
    //
    // Anchored on the left so this doesn't false-positive on `border-color:` or
    // `border-left-color:` — both legitimately keep --color-error (they are not held to
    // a text-contrast bar) and both end in the literal substring "color:", which an
    // unanchored match would mistake for the `color` property itself.
    const textRules = css.match(/(?<![\w-])color:\s*var\(--color-error\)/g) ?? [];
    expect(textRules).toEqual([]);
  });

  test('--color-error itself is unchanged, so borders and tints keep their weight', () => {
    expect(token('color-error')).toBe('#ef4444');
  });
});
