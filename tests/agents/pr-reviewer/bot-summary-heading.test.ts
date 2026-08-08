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

/**
 * Asserts a heading line still matches the overlay scripts' filter, with a
 * failure message written for whoever trips it: someone editing the
 * pr-reviewer prompt, who has no reason to know an outcomes sweep exists.
 * A bare boolean assertion here would only ever print "Expected: true /
 * Received: false" — neither the drifted heading, the constant it was
 * compared against, nor the consequence of leaving it broken.
 */
function assertMatchesBotSummaryFilter(headingLine: string, label: string): void {
  expect(
    isBotSummaryHeadingLine(headingLine),
    `${label} heading "${headingLine}" no longer starts with `
      + `"## ${BOT_SUMMARY_HEADING_TEXT}" / "# ${BOT_SUMMARY_HEADING_TEXT}" `
      + `(BOT_SUMMARY_HEADING_TEXT, src/sdk/ado/pull-requests.ts). Update the constant to `
      + `match this heading, or private/scripts/sweep-outcomes.ts and review-outcomes.ts will `
      + `stop recognizing this comment as the bot's own and feed it to the outcomes classifier `
      + `as something a human said.`,
  ).toBe(true);
}

describe('pr-reviewer bot-summary heading stays coupled to the outcomes-sweep filter', () => {
  test('the prompt file is readable and non-empty', () => {
    // Every test below independently calls readFileSync, so a moved/renamed
    // file already fails loudly on ITS OWN — every one of them throws
    // `ENOENT: no such file or directory, open '...CLAUDE.md'` before any
    // regex or assertion runs. That's not what this test buys. What it does
    // catch: a file that exists but reads empty (e.g. truncated by a bad
    // merge), where the regex lookups below would find no line and fail with
    // the less legible "expected undefined to be defined" — this assertion
    // fails first, on the more legible symptom.
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
    assertMatchesBotSummaryFilter(headingLine!, 'in-progress placeholder');
  });

  test('the final summary comment heading matches the filter', () => {
    const prompt = readFileSync(PROMPT, 'utf-8');
    const headingLine = /^#{1,2} .*Brief Summary.*$/m.exec(prompt)?.[0];
    expect(headingLine).toBeDefined();
    assertMatchesBotSummaryFilter(headingLine!, 'final summary comment');
  });
});
