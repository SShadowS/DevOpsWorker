import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// What a comment is for
//
// Work item 79748 shipped a 55-line XML doc block on one internal helper. Most
// of it was written for a reader who no longer existed: it answered findings
// from four rounds of code review, recorded that "unlike a prior revision" the
// ceiling moved, and quoted the byte counts from the bug that prompted the
// work. A developer opening that file cold has none of that context and needs
// none of it.
//
// The prompt already told the coder how to write a comment — but the rule said
// "Inline comments", and XML doc comments were not covered by anything. This
// pins the gap closed, and pins the two ways closing it could go wrong.
// ---------------------------------------------------------------------------

const CODER_PROMPT = readFileSync(
  join(import.meta.dir, '../../../src/agents/coder/CLAUDE.md'),
  'utf-8',
);

describe('coder comment guidance', () => {
  test('covers XML doc comments, not just inline ones', () => {
    // The uncovered case. `///` is where the 55-line block lived.
    expect(CODER_PROMPT).toContain('///');
  });

  test('names the audience as someone reading the code cold', () => {
    // The test that settles every other question: a comment is for the next
    // person or agent who opens this file knowing nothing about how it came to
    // be written.
    expect(CODER_PROMPT.toLowerCase()).toMatch(/next (person|agent|reader)|reading (it|the code) cold/);
  });

  test('says that code which explains itself needs no comment', () => {
    expect(CODER_PROMPT.toLowerCase()).toMatch(/already says it|explains itself|says it for itself/);
  });

  test('keeps summary and param docs on public API', () => {
    // The guard against over-correction. A rule aimed at the 79748 block could
    // easily delete the doc comments on 73321's published event — which are
    // correct, match the house style, and are what a caller reads instead of
    // opening the file. Those must survive.
    expect(CODER_PROMPT).toContain('<param>');
    expect(CODER_PROMPT.toLowerCase()).toContain('public');
  });

  test('redirects review answers and history rather than forbidding them', () => {
    // Negative framing is measured on this project to suppress far more than it
    // targets — twice, in the LSP work, a prohibition killed the whole
    // behaviour it was meant to shape. So each of these says where the content
    // belongs, not that writing is banned.
    expect(CODER_PROMPT.toLowerCase()).toMatch(/git carries|git owns|git records/);
    expect(CODER_PROMPT.toLowerCase()).toMatch(/settle it in the review|belongs in the review|answer .* in the review/);
  });

  test('gives the invited categories a size', () => {
    // The gap this rule opened by itself. "Why this shape, not the obvious one"
    // invites exactly the longest offender measured so far: six lines of
    // "this write is deliberately unguarded... the residual is accepted",
    // answering a reviewer who asked why it was not wrapped in a TryFunction.
    // That IS why-this-shape — a legitimate instance of a category the rule
    // asks for, at a paragraph instead of a sentence. Without a size, the rule
    // licenses the thing it exists to stop.
    expect(CODER_PROMPT.toLowerCase()).toMatch(/sentence or two|a sentence, not a paragraph/);
    expect(CODER_PROMPT.toLowerCase()).toContain('paragraph');
  });

  test('the guidance itself is not a wall of text', () => {
    // A long rule about being concise invites the obvious retort, and a prompt
    // section nobody finishes reading binds no better than the one it replaced.
    const section = CODER_PROMPT.slice(CODER_PROMPT.indexOf('Comments earn their place'));
    const end = section.indexOf('\n## ');
    const body = end > 0 ? section.slice(0, end) : section;
    expect(body.length).toBeLessThan(1800);
  });
});
