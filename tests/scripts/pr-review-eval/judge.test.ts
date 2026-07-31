import { describe, test, expect } from 'bun:test';
import {
  buildJudgePrompt,
  POOL_JUDGE_SYSTEM_PROMPT,
} from '../../../scripts/pr-review-eval/judge.ts';

// Deliberately does NOT import/call `judgePooledFinding` — that function
// makes a real Claude Agent SDK `query()` call, and no test in this repo may
// make a real LLM or network call. Importing `buildJudgePrompt` and
// `POOL_JUDGE_SYSTEM_PROMPT` from the same module is enough to pull the
// whole file into `tsc`'s program (see the tsconfig "include" note: files
// under scripts/ are only type-checked when something under tests/ or src/
// imports them), so `judgePooledFinding`'s signature still gets typechecked
// even though nothing here invokes it.

describe('POOL_JUDGE_SYSTEM_PROMPT', () => {
  // C5 — 'unverifiable' must be offered as a real, correct answer, not just
  // exist in the Grade union with no channel telling the model to use it.
  test('offers "unverifiable" as an explicit, correct grade', () => {
    expect(POOL_JUDGE_SYSTEM_PROMPT).toContain('"unverifiable"');
    expect(POOL_JUDGE_SYSTEM_PROMPT.toLowerCase()).toContain('correct answer');
  });

  test('still offers all three original grades', () => {
    expect(POOL_JUDGE_SYSTEM_PROMPT).toContain('"real-bug"');
    expect(POOL_JUDGE_SYSTEM_PROMPT).toContain('"nit"');
    expect(POOL_JUDGE_SYSTEM_PROMPT).toContain('"false-positive"');
  });

  test('tells the model not to guess to avoid "unverifiable"', () => {
    expect(POOL_JUDGE_SYSTEM_PROMPT.toLowerCase()).toContain('do not guess');
  });
});

describe('buildJudgePrompt', () => {
  test('renders file, location, and title', () => {
    const prompt = buildJudgePrompt(
      { title: 'Missing timeout', file: 'Cod.al', location: 'SaveFile', line: undefined },
      '@@ -1,3 +1,4 @@\n+timeout: 30,',
    );
    expect(prompt).toContain('File: Cod.al');
    expect(prompt).toContain('Location: SaveFile');
    expect(prompt).toContain('Claim: Missing timeout');
    expect(prompt).toContain('@@ -1,3 +1,4 @@');
  });

  test('falls back to "line N" when location is absent but line is present', () => {
    const prompt = buildJudgePrompt(
      { title: 'x', file: 'Cod.al', location: '', line: 42 },
      'evidence',
    );
    expect(prompt).toContain('Location: line 42');
  });

  test('falls back to a placeholder when neither location nor line is present', () => {
    const prompt = buildJudgePrompt(
      { title: 'x', file: 'Cod.al', location: '', line: undefined },
      'evidence',
    );
    expect(prompt).toContain('Location: (no location given)');
  });

  test('falls back to a placeholder when file is absent', () => {
    const prompt = buildJudgePrompt(
      { title: 'x', file: '', location: '', line: undefined },
      'evidence',
    );
    expect(prompt).toContain('File: (no file given)');
  });
});
