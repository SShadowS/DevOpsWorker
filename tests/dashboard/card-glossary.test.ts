import { describe, test, expect } from 'bun:test';
import { glossaryText } from '../../src/dashboard/client/components/card-glossary.tsx';

describe('glossaryText', () => {
  test('renders nothing for an empty list', () => {
    expect(glossaryText([])).toBeNull();
  });

  test('one term reads as a sentence, not a list', () => {
    expect(glossaryText([{ term: 'a finding', plain: 'a problem the reviewer flagged' }]))
      .toBe('In this card, a finding means a problem the reviewer flagged.');
  });

  test('two terms are joined with "and", not a comma', () => {
    expect(glossaryText([
      { term: 'a finding', plain: 'a problem the reviewer flagged' },
      { term: 'settled', plain: 'merged or closed' },
    ])).toBe('In this card, a finding means a problem the reviewer flagged, and settled means merged or closed.');
  });

  test('three or more terms use an Oxford comma', () => {
    expect(glossaryText([
      { term: 'a', plain: 'one' }, { term: 'b', plain: 'two' }, { term: 'c', plain: 'three' },
    ])).toBe('In this card, a means one, b means two, and c means three.');
  });
});
