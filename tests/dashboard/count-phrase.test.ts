import { describe, test, expect } from 'bun:test';
import { countOf, agree, itThem } from '../../src/dashboard/count-phrase.ts';

// These exist so the review-value card's prose has one place to get count
// agreement right, instead of the several places it got it wrong across three
// review rounds. Pure string functions — no DB, no component tree.

describe('countOf', () => {
  test('singular at exactly 1', () => {
    expect(countOf(1, 'finding')).toBe('1 finding');
    expect(countOf(1, 'review')).toBe('1 review');
  });

  test('plural at 0 — "0 findings" is the correct English, not "0 finding"', () => {
    expect(countOf(0, 'finding')).toBe('0 findings');
  });

  test('plural above 1', () => {
    expect(countOf(2, 'finding')).toBe('2 findings');
    expect(countOf(139, 'read-band finding')).toBe('139 read-band findings');
  });

  test('an explicit plural covers anything not formed by +s', () => {
    expect(countOf(1, 'of them was', 'of them were')).toBe('1 of them was');
    expect(countOf(3, 'of them was', 'of them were')).toBe('3 of them were');
  });

  test('pluralises the whole phrase, so a multi-word noun stays intact', () => {
    expect(countOf(1, 'traced finding')).toBe('1 traced finding');
    expect(countOf(4, 'traced finding')).toBe('4 traced findings');
  });
});

describe('agree', () => {
  test('picks the singular form at exactly 1', () => {
    expect(agree(1, 'carries', 'carry')).toBe('carries');
    expect(agree(1, 'has', 'have')).toBe('has');
    expect(agree(1, 'was', 'were')).toBe('was');
  });

  test('picks the plural at 0 and above 1', () => {
    expect(agree(0, 'carries', 'carry')).toBe('carry');
    expect(agree(2, 'has', 'have')).toBe('have');
  });

  test('both forms are required — there is no default that is safe often enough', () => {
    // Compile-time property, asserted here as documentation: `agree` has no
    // two-argument overload, so a caller cannot omit the plural and get a
    // guessed one (which is exactly how "1 finding are" gets written).
    expect(agree.length).toBe(3);
  });
});

describe('itThem', () => {
  test('it at 1, them otherwise', () => {
    expect(itThem(1)).toBe('it');
    expect(itThem(0)).toBe('them');
    expect(itThem(5)).toBe('them');
  });
});
