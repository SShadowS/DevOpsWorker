import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// The one cross-FILE prose guard.
//
// Every other prose guard on this branch — around 62 of them — is scoped to a
// single file. The defect class those guards cannot see is a fact rendered
// under two names by two files, and four of the six findings in this fix round
// were exactly that: a verdict table showing raw database keys under a glossary
// explaining the card's words; "PR" on one side of a card and "pull request" on
// the other; "flagged model key(s)" on a card that points the reader at a card
// saying "flagged model(s)". Nothing in the suite would have failed on any of
// them.
//
// So this file sweeps every card source for a deny-list of tokens that must
// never reach a reader: names of database columns and JSON keys, and the "PR"
// initialism. A reader of a card has no schema to resolve a column name
// against, and no reason to know that `read-band` means critical-or-major.
//
// It reads RENDERED text only — string and template literals, plus JSX text
// nodes — because all three of these legitimately name every token below:
//   - comments (developer documentation: `sub_agents` undercounts, and saying
//     so in a comment is the correct thing to do);
//   - identifiers (`modelUsage`, `READ_BAND_DANGER_MAX`);
//   - CSS class names (`read-band-gauge__track` is a selector, not a word).
// Same reasoning as stats-operational.test.ts's "find the return line" guards,
// generalised from one line to every literal in six files.
// ---------------------------------------------------------------------------

const FILES = [
  'components/stats-review-value.tsx',
  'components/stats-costquality.tsx',
  'components/stats-integrity.tsx',
  'components/stats-operational.tsx',
  'components/stats-view.tsx',
  'assessors.ts',
] as const;

const read = (f: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/dashboard/client/${f}`, import.meta.url)), 'utf8');

const basename = (f: string) => f.slice(f.lastIndexOf('/') + 1);

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * One pass over the source, tracking whether each character sits in code, a
 * comment, or a string. A regex cannot do this: `//` appears inside string
 * literals (URLs) and quotes appear inside comments, so either kind of naive
 * match mis-classifies the other's contents.
 *
 * Returns the source with comments removed, the literals it found (their SOURCE
 * text, `${...}` included), and a skeleton with every literal's contents
 * blanked — the skeleton is what JSX text is read off, so an apostrophe in
 * prose cannot open a phantom string.
 */
function scan(src: string): { code: string; literals: string[]; skeleton: string } {
  let code = '';
  let skeleton = '';
  const literals: string[] = [];
  let literal = '';
  let state: 'code' | 'line' | 'block' | "'" | '"' | '`' = 'code';
  let i = 0;

  while (i < src.length) {
    const c = src[i]!;
    const d = src[i + 1];

    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') {
        state = c;
        literal = '';
        code += c;
        skeleton += c;
        i++;
        continue;
      }
      code += c;
      skeleton += c;
      i++;
      continue;
    }

    if (state === 'line') {
      // Newlines survive comment removal so reported line numbers stay usable.
      if (c === '\n') { state = 'code'; code += c; skeleton += c; }
      i++;
      continue;
    }

    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') { code += c; skeleton += c; }
      i++;
      continue;
    }

    // Inside a literal.
    if (c === '\\') { literal += src.slice(i, i + 2); code += src.slice(i, i + 2); i += 2; continue; }
    if (c === state) {
      literals.push(literal);
      state = 'code';
      code += c;
      skeleton += c;
      i++;
      continue;
    }
    literal += c;
    code += c;
    if (c === '\n') skeleton += c;
    i++;
  }

  return { code, literals, skeleton };
}

/** A CSS class is markup, not prose. Blanked before extraction rather than
 *  filtered afterwards, so `class="read-band-gauge__track"` never becomes a
 *  candidate that something later has to excuse. */
function blankClassAttributes(src: string): string {
  return src
    .replace(/\bclass=(["'])(?:\\.|(?!\1)[\s\S])*?\1/g, 'class=""')
    .replace(/\bclass=\{`(?:\\.|[^`])*`\}/g, 'class={``}');
}

/** Text a reader sees: literals plus JSX text nodes. */
function renderedText(src: string): string[] {
  const withoutComments = scan(src).code;
  const { literals, skeleton } = scan(blankClassAttributes(withoutComments));
  const out = [...literals];
  // A JSX text node runs from a tag's closing `>` to the next `<` or `{`.
  // Generic closings and arrow functions also match, but only ever yield short
  // code fragments — harmless, since the deny list holds no operator.
  for (const m of skeleton.matchAll(/>([^<>{}]+)[<{]/g)) out.push(m[1]!);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// The deny list
// ---------------------------------------------------------------------------

const DENIED: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'tool_calls', pattern: /tool_calls/ },
  { name: 'model_usage', pattern: /model_usage/ },
  { name: 'sub_agents', pattern: /sub_agents/ },
  { name: 'findings_list', pattern: /findings_list/ },
  { name: 'said_confidence', pattern: /said_confidence/ },
  { name: 'error_max_turns', pattern: /error_max_turns/ },
  { name: 'read-band', pattern: /read-band/ },
  { name: 'PR', pattern: /\bPRs?\b/ },
];

/**
 * Sites that still render a denied token and are deliberately NOT fixed in this
 * round. The sweep fails on introduction without them, and weakening the deny
 * list to get it green would throw away the whole guard — so the remaining
 * leaks are listed instead, one entry per rendered string.
 *
 * An entry excuses ONE exact string in ONE file, never a token and never a
 * file, so a new occurrence of the same token anywhere else still fails. When a
 * site is fixed its entry must be deleted; the staleness check below fails
 * until it is.
 *
 * There are two further known leaks the sweep cannot see, because they are
 * rendered verbatim by the Integrity panel from strings built in
 * `src/dashboard/stats.ts` (`inferredEffort.note` and
 * `subAgentModelAttribution.note`, ~stats.ts:1069 and ~:1085): between them they
 * put `model_usage`, `sub_agents`, `dispatch.mismatchRate` and `/api/config` on
 * the page. Widening the sweep to stats.ts would pull in the server module and
 * its whole non-rendered surface, so they are recorded here rather than
 * guarded.
 */
const KNOWN_REMAINING: ReadonlyArray<{ file: string; text: string; why: string }> = [
  {
    file: 'stats-integrity.tsx',
    text: '"Error" here includes every kind of pipeline failure recorded on the row, including error_max_turns',
    why: 'Known and deferred: names the stored value for one failure mode, and no plain wording yet identifies it as precisely.',
  },
  {
    file: 'assessors.ts',
    text: 'runs off declared pin across ${contaminatedRows.length} sub-agent(s) (floor — sub_agents undercounts, see Integrity panel)${notObservedText}',
    why: 'Known and deferred: the ribbon\'s contamination text, which also says "floor" where this branch settled on "at least this much".',
  },
];

// ---------------------------------------------------------------------------
// The extractor's own tests. A sweep that silently extracts nothing passes
// every assertion below it, so the extractor is checked before it is trusted.
// ---------------------------------------------------------------------------

describe('rendered-text extraction', () => {
  test('finds string, template and JSX text, and ignores comments, identifiers and class names', () => {
    const sample = [
      '// a comment naming tool_calls',
      '/* a block comment naming read-band */',
      'const modelUsageRows = 1;',
      "const a = 'the visible sentence';",
      'const b = `a ${count} template`;',
      '<div class="read-band-gauge__track">visible node</div>',
      '<div class={`read-band-gauge__marker--${x}`}>another node</div>',
    ].join('\n');
    const found = renderedText(sample);
    expect(found).toContain('the visible sentence');
    expect(found).toContain('a ${count} template');
    expect(found).toContain('visible node');
    expect(found).toContain('another node');
    expect(found.some((s) => s.includes('tool_calls'))).toBe(false);
    expect(found.some((s) => s.includes('read-band'))).toBe(false);
    expect(found.some((s) => s.includes('modelUsageRows'))).toBe(false);
  });

  test("a quote inside a comment does not swallow the code after it", () => {
    const sample = ["// it's a comment", "const a = 'kept';"].join('\n');
    expect(renderedText(sample)).toContain('kept');
  });

  test('a // inside a string is not treated as a comment', () => {
    expect(renderedText("const u = 'https://example.test/tool_calls';")).toContain('https://example.test/tool_calls');
  });

  test('every swept file yields text — an extractor returning nothing would pass every check below', () => {
    for (const f of FILES) {
      expect(renderedText(read(f)).length, `${basename(f)} yielded no rendered text`).toBeGreaterThan(10);
    }
  });

  test('the deny list catches what it is for', () => {
    const hit = (s: string) => DENIED.filter((d) => d.pattern.test(s)).map((d) => d.name);
    expect(hit('N of M raised on the PR')).toEqual(['PR']);
    expect(hit('across 3 PRs')).toEqual(['PR']);
    expect(hit('read-band items per review')).toEqual(['read-band']);
    expect(hit('no rows in tool_calls')).toEqual(['tool_calls']);
    // ...and does not fire on the words that replaced them.
    expect(hit('across 3 pull requests')).toEqual([]);
    expect(hit('critical or major items per review')).toEqual([]);
    expect(hit('No tool activity recorded in this window.')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

describe('no card renders a database name or the PR initialism', () => {
  for (const file of FILES) {
    const name = basename(file);
    test(`${name}`, () => {
      const excused = new Set(KNOWN_REMAINING.filter((k) => k.file === name).map((k) => k.text));
      const offences: string[] = [];
      for (const text of renderedText(read(file))) {
        if (excused.has(text)) continue;
        for (const { name: token, pattern } of DENIED) {
          if (pattern.test(text)) offences.push(`${token} — ${text}`);
        }
      }
      expect(offences).toEqual([]);
    });
  }

  // The allow-list is exactly the set of leaks, not a superset. Stated as one
  // equality so it cannot be widened by adding an entry: an entry for a site
  // that is not leaking fails here, and so does a leak with no entry. Without
  // the allow-list this sweep fails on introduction, which is the deliverable —
  // the remaining leaks become visible instead of quietly tolerated, and a new
  // one anywhere still fails.
  test('the allow-list excuses exactly the sites that leak, and no others', () => {
    const leaking: string[] = [];
    for (const file of FILES) {
      for (const text of renderedText(read(file))) {
        if (DENIED.some((d) => d.pattern.test(text))) leaking.push(`${basename(file)}\t${text}`);
      }
    }
    expect(leaking.sort()).toEqual(KNOWN_REMAINING.map((k) => `${k.file}\t${k.text}`).sort());
  });

  // An excuse for a string that is no longer there excuses nothing, and hides
  // the fact that the leak was fixed. Deleting the entry is what hands the site
  // back to the sweep.
  test('every known-remaining entry still describes a real site', () => {
    for (const k of KNOWN_REMAINING) {
      const file = FILES.find((f) => basename(f) === k.file);
      expect(file, `${k.file} is not one of the swept files`).toBeDefined();
      expect(renderedText(read(file!)), `${k.file}: known-remaining entry no longer matches anything — delete it`)
        .toContain(k.text);
      // Every entry excuses a string that really is denied — an entry for a
      // clean string would quietly widen the allow-list for free.
      expect(DENIED.some((d) => d.pattern.test(k.text)), `${k.file}: entry excuses a string with nothing denied in it`).toBe(true);
      expect(k.why.length).toBeGreaterThan(0);
    }
  });
});
