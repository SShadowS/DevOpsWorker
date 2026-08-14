import { describe, test, expect } from 'bun:test';
import {
  buildSuggestionBlock,
  suggestionEndLine,
  countReplacedLines,
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
