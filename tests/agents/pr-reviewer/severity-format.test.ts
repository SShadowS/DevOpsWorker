// tests/agents/pr-reviewer/severity-format.test.ts
//
// Pins the contract between the orchestrator prompt and the output schema —
// severities, and the structured findingsList the inline-comment feature runs on.
// These drifted apart once already: Phase 5 mapped agent severities to
// "Critical / High / Medium" while PRReviewSchema only accepts
// critical/major/minor/nitpick, so two of the three mapped names could not be
// reported at all. The posted comment then flattened everything to a single
// "REAL ISSUE" label, and a review with 2 criticals, 5 majors and 1 minor
// reached the author as eight identical blockers.
//
// findingsList has the same shape of hazard, quieter: it defaults to `[]`, so a
// prompt that never asks for it validates fine and posts no inline threads at all.
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { PRFindingSchema, PRReviewSchema } from '../../../src/agents/pr-reviewer/schema.ts';

const PROMPT = 'src/agents/pr-reviewer/CLAUDE.md';
const prompt = () => readFileSync(PROMPT, 'utf-8');

/** The only severity names the schema can count. */
const SCHEMA_SEVERITIES = Object.keys(PRReviewSchema.shape.findings.shape);

/** Step 11 (Return Structured Output), from its heading to the next `## ` heading. */
function structuredOutputSection(): string {
  const p = prompt();
  const start = p.indexOf('### 11. Return Structured Output');
  expect(start).toBeGreaterThan(-1);
  const end = p.indexOf('\n## ', start);
  return p.slice(start, end === -1 ? undefined : end);
}

/** Phase 5 step 7's deduplication rules, up to the blank line that ends the list. */
function deduplicationRules(): string {
  const p = prompt();
  const start = p.indexOf('**Deduplication rules**');
  expect(start).toBeGreaterThan(-1);
  const rest = p.slice(start);
  const end = rest.search(/\r?\n\r?\n/);
  return rest.slice(0, end === -1 ? undefined : end);
}

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

describe('pr-reviewer structured findingsList', () => {
  test('the prompt requires a structured findingsList with file and line', () => {
    const p = prompt();
    expect(p).toContain('**findingsList**');
    expect(p).toContain('repo-relative');
    expect(p).toContain('RIGHT (source-branch) side');
    // Guessing a line is worse than omitting one.
    expect(p).toContain('omit `file` and `line`');
  });

  test('the record shape step 11 documents is exactly the schema record', () => {
    // The drift this file exists to catch, in its quietest form: a field the
    // schema accepts but the prompt never mentions is simply never populated.
    const shorthand = /\*\*findingsList\*\*[^\n]*\{([^}]+)\}/.exec(structuredOutputSection());
    expect(shorthand).not.toBeNull();
    const documented = shorthand![1]!.split(',').map((f) => f.trim());
    expect(documented.sort()).toEqual(Object.keys(PRFindingSchema.shape).sort());
  });

  test('`location` is documented as the enclosing procedure', () => {
    // Findings are pooled across independent runs on file + location, because
    // line numbers drift between runs. It is the stable unit, so it has to be asked for.
    expect(structuredOutputSection()).toMatch(/`location`[^\n]*enclosing[^\n]*(procedure|trigger|method)/);
  });

  test('the `location` guidance reduces an agent-reported composite reference', () => {
    // Four sub-agents emit a per-finding field literally named `location` meaning
    // something else — "Object name and procedure/line reference"
    // (al-performance-analyzer.md:73, al-error-pattern-analyzer.md:75) and "Object
    // name and specific area" (al-architecture-analyzer.md:75,
    // al-integration-analyzer.md:86). Copied into findingsList verbatim it embeds the
    // line number this field exists to avoid, and the two families word it
    // differently, so pooling on file + location fails across domains and runs.
    expect(structuredOutputSection()).toMatch(/`location`[\s\S]{0,600}procedure name/);
  });

  test('anchors are asked for at every severity, not only the inline-eligible ones', () => {
    // reconcile-findings.ts:59-61 builds its suppression set from EVERY finding that
    // carries a `file`, at ANY severity. A finding downgraded to minor and re-emitted
    // without an anchor reads as absent, so its live thread collects a "not detected"
    // reply that is simply false — the outcome that code exists to prevent.
    expect(structuredOutputSection()).toMatch(/Minor and Nitpick/);
  });

  test('inline threads are documented as the pipeline\'s job and additive to the summary', () => {
    const section = structuredOutputSection();
    // The agent posts one summary comment; it must not try to post threads itself,
    // nor thin out the summary because a finding also gets an inline thread.
    expect(section).toMatch(/the pipeline/);
    expect(section).toContain('never a replacement');
    // The `findings` counters and the findingsList entries describe the same set.
    expect(section).toMatch(/must agree/);
  });

  test('the line guidance states a consequence rather than a prohibition', () => {
    // Measured on this codebase: prohibition wording suppresses the behaviour
    // outright rather than redirecting it, so the block gives the cost of a
    // guessed line and the cheap alternative instead of forbidding one.
    const section = structuredOutputSection();
    expect(section).not.toMatch(/\b(never|do not|don't|dont)\s+guess/i);
    expect(section).toContain('A guessed line is worse than none');
  });

  test('deduplication carries the finding location through a merge', () => {
    // "Keep the entry with the most detail" said nothing about file/line, so the
    // anchor could be dropped exactly when several domains agreed on a finding.
    const rules = deduplicationRules();
    expect(rules).toContain('`file`');
    expect(rules).toContain('`line`');
    expect(rules).toContain('`location`');
    expect(rules).toMatch(/through the merge/);
  });

  test('the prompt file has uniform line endings', () => {
    // A CRLF frontmatter delimiter has already made agent files undiscoverable in
    // the container. The Dockerfile strips CR from src/agents/**/*.md and
    // `.gitattributes` (`text=auto`) stores this file LF while checking it out CRLF
    // on Windows — so asserting "zero CR" here would fail on a Windows working tree
    // for the wrong reason. What a hand-edit genuinely breaks is uniformity: a block
    // pasted with the other convention leaves the file mixed.
    const raw = readFileSync(PROMPT, 'utf-8');
    const lf = (raw.match(/\n/g) ?? []).length;
    const crlf = (raw.match(/\r\n/g) ?? []).length;
    expect(lf).toBeGreaterThan(0);
    expect(crlf === 0 || crlf === lf).toBe(true);
    // No bare CR either — inside a line, or old-Mac endings.
    expect(raw.replace(/\r\n/g, '\n')).not.toContain('\r');
  });
});
