// tests/agents/pr-reviewer/severity-format.test.ts
//
// Pins the severity contract between the orchestrator prompt and the output
// schema. These drifted apart once already: Phase 5 mapped agent severities to
// "Critical / High / Medium" while PRReviewSchema only accepts
// critical/major/minor/nitpick, so two of the three mapped names could not be
// reported at all. The posted comment then flattened everything to a single
// "REAL ISSUE" label, and a review with 2 criticals, 5 majors and 1 minor
// reached the author as eight identical blockers.
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { PRReviewSchema } from '../../../src/agents/pr-reviewer/schema.ts';

const PROMPT = 'src/agents/pr-reviewer/CLAUDE.md';
const prompt = () => readFileSync(PROMPT, 'utf-8');

/** The only severity names the schema can count. */
const SCHEMA_SEVERITIES = Object.keys(PRReviewSchema.shape.findings.shape);

describe('pr-reviewer severity contract', () => {
  test('the schema still declares exactly the four expected severities', () => {
    expect(SCHEMA_SEVERITIES.sort()).toEqual(['critical', 'major', 'minor', 'nitpick']);
  });

  test('every severity the prompt maps to is one the schema can count', () => {
    // Grab the right-hand column of the severity mapping table rows.
    const rows = [...prompt().matchAll(/^\|\s*`(?:high|medium|low)`\s*\|\s*\*\*(\w+)\*\*/gm)];
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(SCHEMA_SEVERITIES).toContain(row[1]!.toLowerCase());
    }
  });

  test('the prompt names all four severities as labels', () => {
    const p = prompt();
    for (const label of ['Critical', 'Major', 'Minor', 'Nitpick']) {
      expect(p).toContain(`| ${label} |`);
    }
  });

  test('findings are labelled by severity, not by a flat verdict', () => {
    const p = prompt();
    expect(p).toContain('### Finding 1: [Title] — [Emoji] **[Severity]**');
    // The old flat label made a latent issue and a data-loss bug look identical.
    expect(p).toContain('Do not label findings "REAL ISSUE"');
  });

  test('the conclusion table carries severity rather than a verdict', () => {
    expect(prompt()).toContain('| Concern | Severity |');
  });

  test('the recommendation rule keys off Critical and Major, not raw counts', () => {
    const p = prompt();
    expect(p).toContain('**Request changes** if ANY **Critical** finding exists');
    expect(p).toContain('multiple **Major** findings');
    // Volume must not masquerade as severity.
    expect(p).toContain('Volume is not');
  });
});
