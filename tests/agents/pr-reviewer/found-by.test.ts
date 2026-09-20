import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { PRFindingSchema, PR_SUB_AGENTS } from '../../../src/agents/pr-reviewer/schema.ts';
import { AGENT_TRIGGERS } from '../../../src/cli/review-pr.ts';
import { findingKey } from '../../../src/sdk/ado/finding-key.ts';

// ---------------------------------------------------------------------------
// Which sub-agents found a finding.
//
// Nothing linked a finding to its source, so "would skipping this agent have
// lost a finding?" — the only question a router has to answer — was
// unanswerable. `foundBy` records it at the one place that can know: the
// orchestrator, after the merge.
//
// The field is deliberately forgiving. A validation error is not retried
// (run-agent.ts), so a required field would throw away a finished review over
// its last line. Absent attribution is an empty array, which is countable, and
// counted per review in the log.
// ---------------------------------------------------------------------------

const base = { severity: 'major' as const, title: 't', body: 'b' };

describe('foundBy on a finding', () => {
  test('accepts one agent, and several for a merged finding', () => {
    expect(PRFindingSchema.parse({ ...base, foundBy: ['al-performance-analyzer'] }).foundBy)
      .toEqual(['al-performance-analyzer']);
    expect(PRFindingSchema.parse({ ...base, foundBy: ['al-performance-analyzer', 'code-review-validator'] }).foundBy)
      .toEqual(['al-performance-analyzer', 'code-review-validator']);
  });

  test('an omitted field parses to an empty array rather than failing the review', () => {
    expect(PRFindingSchema.parse(base).foundBy).toEqual([]);
  });

  test('a name outside the roster costs this finding its attribution, not the review', () => {
    // "security agent" instead of the real name is exactly the drift a closed
    // enum exists to stop — but dropping a whole review over it would cost far
    // more than the attribution is worth.
    expect(PRFindingSchema.parse({ ...base, foundBy: ['security agent'] }).foundBy).toEqual([]);
  });

  test('the roster the model is shown is the real agent roster', () => {
    // The JSON schema sent to the SDK carries the enum, so the model sees the
    // exact spellings rather than guessing them.
    const json = z.toJSONSchema(PRFindingSchema) as unknown as { properties: { foundBy: { items: { enum: string[] } } } };
    expect(json.properties.foundBy.items.enum.sort()).toEqual([...PR_SUB_AGENTS].sort());
  });

  test('the roster and the routing table cannot drift apart', () => {
    expect(Object.keys(AGENT_TRIGGERS).sort()).toEqual([...PR_SUB_AGENTS].sort());
  });
});

describe('foundBy never changes a finding\'s identity', () => {
  test('two findings differing only in foundBy share a key', () => {
    // Which agents noticed a concern can change between re-reviews while the
    // concern does not. If that forked the key, the second review would open a
    // duplicate thread beside the first.
    const a = findingKey('App/X.al', 'Retry ceiling is written twice');
    const b = findingKey('App/X.al', 'Retry ceiling is written twice');
    expect(a).toBe(b);
    // The key is computed from file and title alone — foundBy is not an input.
    expect(findingKey.length).toBe(2);
  });
});

describe('the prompt tells the orchestrator to fill it in', () => {
  const PROMPT = readFileSync(join(import.meta.dir, '../../../src/agents/pr-reviewer/CLAUDE.md'), 'utf-8');

  test('deduplication rule 4 asks for the union, not just the kept entry', () => {
    const rule4 = PROMPT.slice(PROMPT.indexOf('4. Note which analysis domains flagged it'));
    expect(rule4.slice(0, 400)).toContain('foundBy');
    expect(rule4.slice(0, 400)).toMatch(/union/i);
  });

  test('the structured-output section names foundBy in the record', () => {
    expect(PROMPT).toContain('suggestedFix, body, foundBy}');
  });
});
