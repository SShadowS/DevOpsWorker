import { describe, test, expect } from 'bun:test';
import {
  buildSuggestionBlock,
  suggestionEndLine,
  countReplacedLines,
  suggestionApplies,
} from '../../../src/sdk/ado/suggestion.ts';

describe('buildSuggestionBlock', () => {
  test('wraps the replacement in a suggestion fence', () => {
    const block = buildSuggestionBlock('    Access = Internal;');
    expect(block.startsWith('```suggestion\n')).toBe(true);
    expect(block.endsWith('\n```')).toBe(true);
    expect(block).toContain('    Access = Internal;');
  });

  test('content ends with a newline — the blank line before the closing fence', () => {
    const block = buildSuggestionBlock('    Access = Internal;');
    const body = block.slice('```suggestion\n'.length, -'```'.length);
    expect(body).toBe('    Access = Internal;\n\n');
  });

  test('preserves leading indentation exactly', () => {
    const block = buildSuggestionBlock('        Suppress: Boolean;');
    expect(block).toContain('\n        Suppress: Boolean;\n');
  });

  test('keeps interior blank lines but collapses trailing ones', () => {
    const block = buildSuggestionBlock('a\n\nb\n\n\n');
    const body = block.slice('```suggestion\n'.length, -'```'.length);
    expect(body).toBe('a\n\nb\n\n');
  });

  test('handles a multi-line replacement', () => {
    const block = buildSuggestionBlock('        Suppress: Boolean;\n        Count: Integer;');
    expect(block).toBe(
      '```suggestion\n        Suppress: Boolean;\n        Count: Integer;\n\n```',
    );
  });
});

describe('countReplacedLines', () => {
  test('counts a single line as one', () => {
    expect(countReplacedLines('    Access = Internal;')).toBe(1);
  });

  test('counts two lines as two', () => {
    expect(countReplacedLines('a\nb')).toBe(2);
  });

  test('ignores a trailing newline', () => {
    expect(countReplacedLines('a\nb\n')).toBe(2);
  });

  test('tolerates CRLF', () => {
    expect(countReplacedLines('a\r\nb')).toBe(2);
  });
});

describe('suggestionEndLine', () => {
  test('a one-line replacement at line 3 ends at line 4', () => {
    expect(suggestionEndLine(3, '    EventSubscriberInstance = Manual;')).toBe(4);
  });

  test('a two-line replacement at line 7 ends at line 9', () => {
    expect(suggestionEndLine(7, 'a\nb')).toBe(9);
  });

  test('never returns the start line — a zero-width range inserts instead of replacing', () => {
    expect(suggestionEndLine(3, 'one line')).not.toBe(3);
  });
});

const FILE = [
  'codeunit 68968 "CDO Handled Reset Event Sub"',
  '{',
  '    EventSubscriberInstance = Manual;',
  '    Access = Internal;',
  '',
  '    var',
  '        Suppress: Boolean;',
].join('\n');

describe('suggestionApplies', () => {
  test('accepts an exact single-line match', () => {
    expect(suggestionApplies(FILE, 3, '    EventSubscriberInstance = Manual;')).toBe(true);
  });

  test('accepts an exact multi-line match', () => {
    expect(suggestionApplies(FILE, 3, '    EventSubscriberInstance = Manual;\n    Access = Internal;')).toBe(true);
  });

  test('rejects a line that has drifted by one', () => {
    expect(suggestionApplies(FILE, 4, '    EventSubscriberInstance = Manual;')).toBe(false);
  });

  test('rejects a mismatch in indentation alone', () => {
    expect(suggestionApplies(FILE, 3, '  EventSubscriberInstance = Manual;')).toBe(false);
  });

  test('rejects trailing whitespace that is not in the file', () => {
    expect(suggestionApplies(FILE, 3, '    EventSubscriberInstance = Manual; ')).toBe(false);
  });

  test('rejects a range running past the end of the file', () => {
    expect(suggestionApplies(FILE, 7, '        Suppress: Boolean;\n    more')).toBe(false);
  });

  test('rejects a replacement ending on the last line — the anchor line after it does not exist', () => {
    // FILE has no trailing newline, so line 7 is the last line and there is no
    // line 8 for `rightFileEnd` to sit on. Untested territory; fail closed.
    expect(suggestionApplies(FILE, 7, '        Suppress: Boolean;')).toBe(false);
  });

  test('accepts that same line when the file ends with a newline, because line 8 then exists', () => {
    expect(suggestionApplies(FILE + '\n', 7, '        Suppress: Boolean;')).toBe(true);
  });

  test('rejects a line number below one', () => {
    expect(suggestionApplies(FILE, 0, 'anything')).toBe(false);
  });

  test('rejects empty claimed text rather than matching a blank line by accident', () => {
    expect(suggestionApplies(FILE, 5, '')).toBe(false);
  });

  test('matches a file that uses CRLF against claimed text that uses LF', () => {
    const crlf = FILE.replace(/\n/g, '\r\n');
    expect(suggestionApplies(crlf, 3, '    EventSubscriberInstance = Manual;')).toBe(true);
  });

  test('rejects when the file could not be read as text', () => {
    expect(suggestionApplies('', 1, 'anything')).toBe(false);
  });
});
