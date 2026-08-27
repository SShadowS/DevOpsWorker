import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { TestCasesOutputSchema } from '../../../src/agents/test-cases/schema.ts';

// ---------------------------------------------------------------------------
// What a test case is for, and who reads it
//
// The agent was writing cases that tell someone to open the AL Test Tool and run
// a named test codeunit — 24 such rows across 5 work items. It was not
// misbehaving: the prompt defined a "Test-runner case" vehicle and told it to do
// exactly that.
//
// Two things were wrong underneath it.
//
// The READER was wrong. Running the automated tests is not a person's job — CI
// does it. A test case is read by a technical writer and a solution specialist,
// for two purposes: checking what automated tests cannot reach, and learning
// what the change now does.
//
// The SCOPE was wrong. Test cases were treated as a coverage exercise over every
// scenario in the development plan, with the reviewer calling any gap CRITICAL.
// That is what produced the Test Tool cases: faced with a scenario only an
// automated test can observe, and a rule demanding a case for it, the only move
// left was to write "run the automated test" as a manual step.
//
// So the reviewer's coverage rule is REPLACED, not narrowed. Fixing the writer
// alone would deadlock the loop — writer drops the scenario, reviewer demands it
// back, next round re-adds the Test Tool case it just removed.
// ---------------------------------------------------------------------------

const WRITER = readFileSync(join(import.meta.dir, '../../../src/agents/test-cases/CLAUDE.md'), 'utf-8');
const REVIEWER = readFileSync(
  join(import.meta.dir, '../../../src/agents/test-case-reviewer/CLAUDE.md'),
  'utf-8',
);

describe('test-cases agent — who reads it', () => {
  test('names both readers', () => {
    const lower = WRITER.toLowerCase();
    expect(lower).toContain('technical writer');
    expect(lower).toContain('solution specialist');
  });

  test('states both purposes, including the one that is not testing', () => {
    const lower = WRITER.toLowerCase();
    // Checking what automation cannot reach.
    expect(lower).toMatch(/cannot|can not|out of reach/);
    // Learning what the change does — easy to drop, because it is not testing.
    expect(lower).toMatch(/quick|at a glance|learn what/);
  });
});

describe('test-cases agent — scope', () => {
  test('says test cases are not a pass over every plan scenario', () => {
    // The correction that removes the pressure producing Test Tool cases.
    expect(WRITER.toLowerCase()).toMatch(/not (a |an )?(complete |full )?(coverage|pass|sweep)|not every (test )?scenario/);
  });

  test('sends anything automation can check back to the automated tests', () => {
    expect(WRITER.toLowerCase()).toMatch(/belongs? in the automated tests|leave it to the automated tests/);
  });

  test('does not send anyone to the test runner', () => {
    // The complaint itself, in one assertion.
    expect(WRITER).not.toMatch(/Test-runner case/i);
    expect(WRITER).not.toMatch(/open the Test Tool/i);
    expect(WRITER).not.toMatch(/AL Test Tool/i);
  });
});

describe('test-case-reviewer — the replaced rule', () => {
  test('no longer demands a case for every plan scenario', () => {
    // THE DEADLOCK GUARD. This exact sentence is what forced the Test Tool
    // cases into existence; if it survives, the writer's change cannot hold.
    expect(REVIEWER).not.toMatch(/[Ee]very test scenario from the development plan must be covered/);
  });

  test('treats a case that asks someone to run the tests as a defect', () => {
    expect(REVIEWER.toLowerCase()).toMatch(/test tool|test runner/);
  });

  test('treats an automatable case as a defect too', () => {
    // The inverse of the old rule: the problem is no longer "a scenario with no
    // case", it is "a case for something the automated tests already cover".
    expect(REVIEWER.toLowerCase()).toMatch(/automated tests? (already )?(cover|check)/);
  });

  test('still names both readers, so step quality is judged for them', () => {
    const lower = REVIEWER.toLowerCase();
    expect(lower).toContain('technical writer');
    expect(lower).toContain('solution specialist');
  });
});

describe('TestCasesOutputSchema', () => {
  test('carries what was deliberately left to the automated tests', () => {
    // Structured rather than buried in prose, so a reader can see what the agent
    // considered and declined — otherwise "few cases" and "lazy run" look alike.
    const parsed = TestCasesOutputSchema.parse({
      testCases: [],
      summary: 'nothing here needs a person',
      leftToAutomatedTests: ['Retry backoff timing — asserted in CDOFooTests.RetryBackoff'],
    });

    expect(parsed.leftToAutomatedTests).toHaveLength(1);
  });

  test('defaults to empty so a run with nothing to declare needs no extra field', () => {
    expect(TestCasesOutputSchema.parse({ testCases: [], summary: 's' }).leftToAutomatedTests).toEqual([]);
  });
});
