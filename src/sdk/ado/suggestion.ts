/**
 * Azure DevOps "suggested change" blocks.
 *
 * Azure DevOps renders a fenced block tagged `suggestion` as a one-click
 * "Apply change" button on a line-anchored PR thread. The mechanics are
 * undocumented — Microsoft's docs describe only the light-bulb UI and never
 * print the fence tag — and were established by probing a live PR. Two rules
 * govern it, and BOTH are required:
 *
 *   1. Anchor offsets are COLUMN positions, not line markers. To replace lines
 *      N..M the thread's range must end at column 1 of line M+1, so that it
 *      covers each replaced line's trailing newline. An end anchor equal to the
 *      start is a zero-width range: it inserts rather than replaces.
 *   2. The fence content must END WITH A NEWLINE. Without one, the range has
 *      consumed line M's newline and nothing supplies a replacement, so the
 *      line after the block is pulled up onto the suggestion.
 *
 * Break either rule and Azure DevOps still renders an Apply button. Nothing
 * errors and nothing warns: the file is only mangled once a human clicks, and
 * they click because the button made the suggestion look verified. That is why
 * `suggestionApplies` exists.
 */

/** Split on either line ending — Azure DevOps round-trips content through JSON and can return CRLF. */
function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Drop trailing blank lines without touching interior ones. */
function stripTrailingNewlines(text: string): string {
  return text.replace(/(\r?\n)+$/, '');
}

/**
 * How many whole lines a claimed original text covers.
 *
 * A trailing newline is ignored: "a\nb" and "a\nb\n" both describe two lines.
 */
export function countReplacedLines(replacedText: string): number {
  return splitLines(stripTrailingNewlines(replacedText)).length;
}

/**
 * The `rightFileEnd` line for a thread whose suggestion replaces `replacedText`
 * starting at `startLine`.
 *
 * Always at least `startLine + 1`, because column 1 of the start line itself is
 * a zero-width range.
 */
export function suggestionEndLine(startLine: number, replacedText: string): number {
  return startLine + countReplacedLines(replacedText);
}

/**
 * Wrap replacement text in a suggestion fence.
 *
 * The blank line before the closing fence is load-bearing, not formatting: it
 * is what makes the content end with a newline.
 */
export function buildSuggestionBlock(replacement: string): string {
  return `\`\`\`suggestion\n${stripTrailingNewlines(replacement)}\n\n\`\`\``;
}
