// tests/agents/pr-reviewer/bot-summary-heading.test.ts
//
// Pins BOT_SUMMARY_HEADING_TEXT (src/sdk/ado/pull-requests.ts) to the headings
// this prompt actually emits. private/scripts/sweep-outcomes.ts and
// private/scripts/review-outcomes.ts both drop any comment starting with
// "## Code Review" or "# Code Review" out of the human-discussion stream, on
// the theory that it's the reviewer's own summary, not something a human said.
// Nothing connected that string literal to the prompt that produces it — a
// wording edit here would silently reclassify every bot summary as human
// discussion, feeding the outcomes classifier text no human wrote. This test
// is that connection: it fails the moment either heading drifts from the
// constant instead of failing quietly, weeks later, on live PR data.
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { BOT_SUMMARY_HEADING_TEXT } from '../../../src/sdk/ado/pull-requests.ts';

const PROMPT = 'src/agents/pr-reviewer/CLAUDE.md';

/**
 * Mirrors the exact tolerance private/scripts/{sweep,review}-outcomes.ts apply:
 * either heading level, then the constant's text verbatim.
 */
function isBotSummaryHeadingLine(line: string): boolean {
  return line.startsWith(`## ${BOT_SUMMARY_HEADING_TEXT}`)
    || line.startsWith(`# ${BOT_SUMMARY_HEADING_TEXT}`);
}

describe('pr-reviewer bot-summary heading stays coupled to the outcomes-sweep filter', () => {
  test('the prompt file is readable and non-empty', () => {
    // If this file moves or is renamed, every test below would otherwise find
    // no matching line and fail with "expected undefined to be defined" —
    // technically correct but easy to misread as a wording drift. This
    // assertion fails first, loudly, on the actual cause.
    const prompt = readFileSync(PROMPT, 'utf-8');
    expect(prompt.length).toBeGreaterThan(0);
  });

  test('the in-progress placeholder heading matches the filter', () => {
    // Left behind on the PR when a review is interrupted mid-run — exactly the
    // comment a sweep is most likely to encounter and must still recognize as
    // the bot's own.
    const prompt = readFileSync(PROMPT, 'utf-8');
    const headingLine = /^#{1,2} .*In Progress.*$/m.exec(prompt)?.[0];
    expect(headingLine).toBeDefined();
    expect(isBotSummaryHeadingLine(headingLine!)).toBe(true);
  });

  test('the final summary comment heading matches the filter', () => {
    const prompt = readFileSync(PROMPT, 'utf-8');
    const headingLine = /^#{1,2} .*Brief Summary.*$/m.exec(prompt)?.[0];
    expect(headingLine).toBeDefined();
    expect(isBotSummaryHeadingLine(headingLine!)).toBe(true);
  });
});
