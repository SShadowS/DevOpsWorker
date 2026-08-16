import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { INFERRED_EFFORT_NOTE, SUB_AGENT_MODEL_ATTRIBUTION_NOTE } from '../../src/dashboard/stats.ts';

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
// So this file sweeps the card sources listed in FILES below for a deny-list of
// tokens that must never reach a reader: names of database columns and JSON
// keys, and the "PR" initialism. A reader of a card has no schema to resolve a
// column name against, and no reason to know that `read-band` means
// critical-or-major.
//
// FILES is a NAMED LIST, not "every card source" — that phrasing was here and
// was wrong. It omitted stats-ribbon.tsx and stats-config.tsx, both imported by
// the swept stats-view.tsx and both rendering on the same tab, so a leak planted
// in either left the suite at 858 pass / 0 fail. The ribbon is the very surface
// commit a7e5b0a was written to clean: the branch cleaned a card and then built
// a guard that could not see it. Anything a reader sees on the Stats tab belongs
// in FILES; the one deliberate omission is recorded in NOT_SWEPT below.
//
// It reads RENDERED text only — string and template literals, plus JSX text
// nodes — because all three of these legitimately name every token below:
//   - comments (developer documentation: `sub_agents` undercounts, and saying
//     so in a comment is the correct thing to do);
//   - identifiers (`modelUsage`, `READ_BAND_DANGER_MAX`);
//   - CSS class names (`read-band-gauge__track` is a selector, not a word).
// Same reasoning as stats-operational.test.ts's "find the return line" guards,
// generalised from one line to every literal in six files. Two more strings —
// built server-side, not written as a literal in any of the six — are checked
// against the same deny list directly; see SERVER_NOTES below.
// ---------------------------------------------------------------------------

const FILES = [
  'components/stats-review-value.tsx',
  'components/stats-costquality.tsx',
  'components/stats-integrity.tsx',
  'components/stats-operational.tsx',
  'components/stats-view.tsx',
  'components/stats-ribbon.tsx',
  'components/stats-config.tsx',
  'components/telemetry-table.tsx',
  'components/tool-usage.tsx',
  'components/card-glossary.tsx',
  'assessors.ts',
] as const;

/**
 * Card sources deliberately NOT swept, and why. An omission with a reason
 * written down is a known gap; an omission with nothing written down is the
 * defect this list exists to stop repeating — FILES silently missed two
 * surfaces for a whole branch.
 *
 * Nothing enforces this list (a test that asserted the file still leaks would
 * pin the leak in place, which is backwards). It is documentation, and the fix
 * is to make the wording decision and move the entry into FILES.
 *
 * Currently empty: stats-config.tsx, the last holdout, joined FILES when the
 * readability fix round retitled "PR-review credential" to "Pull-request
 * review credential" — the one wording decision its entry was waiting on.
 */
const NOT_SWEPT: ReadonlyArray<{ file: string; why: string }> = [];

const read = (f: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/dashboard/client/${f}`, import.meta.url)), 'utf8');

const basename = (f: string) => f.slice(f.lastIndexOf('/') + 1);

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** What the scanner is looking at. A STACK, not a single state: `${…}` inside a
 *  template returns to real code, which may open another template. */
type Frame = { kind: 'top' } | { kind: 'template' } | { kind: 'expr'; braces: number };

interface ScanResult {
  /** The source with comments removed. */
  code: string;
  /** Literal bodies: whole string literals, and each template's text between
   *  its `${…}` expressions. */
  literals: string[];
  /** The source again, with every literal body blanked. JSX text is read off
   *  this, so a quoted phrase inside prose cannot be mistaken for prose. */
  skeleton: string;
  /** False when the scanner did not return to the top frame — an unterminated
   *  string, template or expression. Always a bug in the scanner, never in the
   *  file (these files compile), so it is asserted rather than tolerated: a
   *  desync silently swallows the rest of the file. */
  balanced: boolean;
}

/**
 * One pass over the source, tracking whether each character sits in code, a
 * comment, a string, or a template. A regex cannot do this: `//` appears inside
 * string literals (URLs) and quotes appear inside comments, so either kind of
 * naive match mis-classifies the other's contents.
 *
 * THE APOSTROPHE RULE, which the first version of this file got wrong: a quote
 * opens a literal only when the character immediately before it is not a word
 * character. Rendered prose is full of possessives — "the panel's note", "this
 * window's rows" — and treating those as string openers flips quote parity for
 * the whole rest of the file. It did: `stats-costquality.tsx` desynced at its
 * first possessive and 34% of that file, including its own `CostOverview` note,
 * was invisible to the sweep. An apostrophe in prose always follows a letter; a
 * string literal never does (`return 'x'`, `+ 'x'`, `{ k: 'x' }` are all
 * preceded by a space or a punctuator).
 */
function scan(src: string): ScanResult {
  let code = '';
  let skeleton = '';
  const literals: string[] = [];
  const stack: Frame[] = [{ kind: 'top' }];
  let chunk = '';
  let unterminated = false;
  let i = 0;

  const isWordChar = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
  const keep = (text: string) => { if (text.trim() !== '') literals.push(text); };

  while (i < src.length) {
    const frame = stack[stack.length - 1]!;
    const c = src[i]!;
    const d = src[i + 1];

    if (frame.kind === 'template') {
      if (c === '\\') { chunk += src.slice(i, i + 2); code += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { keep(chunk); chunk = ''; stack.pop(); code += c; skeleton += c; i++; continue; }
      // An interpolation is code, not text — so `${data.model_usage}` is an
      // identifier the sweep must not read as a rendered word.
      if (c === '$' && d === '{') {
        keep(chunk); chunk = '';
        stack.push({ kind: 'expr', braces: 0 });
        code += '${'; skeleton += '${'; i += 2;
        continue;
      }
      chunk += c; code += c; if (c === '\n') skeleton += c;
      i++;
      continue;
    }

    // 'top' or 'expr' — real code.
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        // Newlines survive comment removal so reported positions stay usable.
        if (src[i] === '\n') { code += '\n'; skeleton += '\n'; }
        i++;
      }
      if (i >= src.length) unterminated = true;
      i += 2;
      continue;
    }

    if ((c === "'" || c === '"') && !isWordChar(src[i - 1])) {
      const quote = c;
      let j = i + 1;
      let body = '';
      while (j < src.length && src[j] !== quote) {
        if (src[j] === '\\') { body += src.slice(j, j + 2); j += 2; continue; }
        body += src[j]!;
        j++;
      }
      if (j >= src.length) unterminated = true;
      keep(body);
      code += src.slice(i, j + 1);
      skeleton += quote + quote;
      i = j + 1;
      continue;
    }

    if (c === '`') { stack.push({ kind: 'template' }); chunk = ''; code += c; skeleton += c; i++; continue; }

    if (frame.kind === 'expr') {
      if (c === '{') frame.braces++;
      else if (c === '}') {
        if (frame.braces === 0) { stack.pop(); code += c; skeleton += c; i++; continue; }
        frame.braces--;
      }
    }

    code += c; skeleton += c; i++;
  }

  return { code, literals, skeleton, balanced: !unterminated && stack.length === 1 };
}

/** A CSS class is markup, not prose. Blanked before extraction rather than
 *  filtered afterwards, so `class="read-band-gauge__track"` never becomes a
 *  candidate that something later has to excuse. */
function blankClassAttributes(src: string): string {
  return src
    .replace(/\bclass=(["'])(?:\\.|(?!\1)[\s\S])*?\1/g, 'class=""')
    .replace(/\bclass=\{`(?:\\.|[^`])*`\}/g, 'class={``}');
}

/** Text a reader sees: literal bodies plus JSX text nodes. */
function renderedText(src: string): string[] {
  const withoutComments = scan(src).code;
  const { literals, skeleton } = scan(blankClassAttributes(withoutComments));
  const out = [...literals];
  // A JSX text run ends at the next `<` or `{`, and starts either at a tag's
  // closing `>` or at the `}` that closed an interpolation — "…{n} total
  // row(s)." is two runs, and only reading the first would miss the second.
  // Generic closings, arrow functions and ordinary block braces also match, but
  // yield code fragments made of camelCase identifiers and operators, which no
  // pattern on the deny list can match. If one ever does, the exact-set check
  // below fails loudly rather than hiding it.
  for (const m of skeleton.matchAll(/[>}]([^<>{}]+)[<{]/g)) out.push(m[1]!);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Every swept file, scanned end to end without losing sync. */
function scansCleanly(src: string): boolean {
  const first = scan(src);
  return first.balanced && scan(blankClassAttributes(first.code)).balanced;
}

// ---------------------------------------------------------------------------
// The deny list
// ---------------------------------------------------------------------------

// Case-insensitive wherever a token's case can vary in prose. "read-band" is
// the one that bit: it reached the page as "Read-band" in two section titles
// ("Read-band findings raised", "Read-band health"), which Tasks 8 and 9 fixed
// by hand — a case-sensitive pattern would not have caught either, and would
// not catch them coming back at the start of a sentence or heading.
//
// `PR` stays case-SENSITIVE on purpose. It is an initialism, so its case does
// not vary, and `/\bpr\b/i` would start matching ordinary lowercase fragments
// that are not the initialism at all.
const DENIED: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'tool_calls', pattern: /tool_calls/i },
  { name: 'model_usage', pattern: /model_usage/i },
  { name: 'sub_agents', pattern: /sub_agents/i },
  { name: 'findings_list', pattern: /findings_list/i },
  { name: 'said_confidence', pattern: /said_confidence/i },
  { name: 'error_max_turns', pattern: /error_max_turns/i },
  { name: 'read-band', pattern: /read-band/i },
  { name: 'PR', pattern: /\bPRs?\b/ },
  // `(s)` as a plural placeholder. The page has `countOf()` for this and used
  // both conventions at once — 14 rendered sites against a helper built to
  // replace them. Escaped: `/(s)/` is a capture group matching a bare `s`.
  { name: '(s) placeholder', pattern: /\(s\)/ },
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
 */
const KNOWN_REMAINING: ReadonlyArray<{ file: string; text: string; why: string }> = [];

/**
 * Two more sites the extractor above cannot reach: `inferredEffort.note` and
 * `subAgentModelAttribution.note`, rendered verbatim by the Integrity panel but
 * built server-side in `src/dashboard/stats.ts`, not as a literal in any of the
 * client files above — a note handed to a card through a variable never
 * appears there as source text, so `renderedText()` cannot see it no matter how
 * the extractor is improved. Widening the sweep to read the whole of stats.ts
 * would pull in that module's non-rendered surface for two strings; instead
 * (Task 6) both notes were hoisted to exported constants, so the ALREADY
 * EVALUATED string can be checked directly against the same DENIED list, no
 * extraction needed. This closes the gap the comment above used to describe as
 * permanent — but ONLY IN COMPANY WITH A BINDING HELD IN ANOTHER FILE. Checking
 * the constant proves nothing about the card unless the card's note really IS
 * that constant, and nothing here can see that: it is pinned by
 * tests/dashboard/stats.test.ts's two wiring pins, which require the
 * getIntegrityStats return object to read exactly `note: <CONSTANT>,`. Delete or
 * loosen those and this check silently goes back to reading a string the card no
 * longer renders — which is not hypothetical: while those pins matched a mere
 * MENTION of the constant, `note: CONSTANT + ' …sub_agents… PR… '` put four
 * denied tokens on the card with the whole suite green. Change either side and
 * check the other.
 *
 * It also makes tests/dashboard/stats.test.ts's narrower 4-token
 * schema-name check ("the inferredEffort and subAgentModelAttribution notes
 * name no schema token") a partial subset of the check below — NOT fully
 * redundant, because two of its four tokens (`dispatch.mismatchRate`,
 * `/api/config`) are not in this file's `DENIED` list and so still need their
 * own guard.
 */
const SERVER_NOTES: ReadonlyArray<{ name: string; text: string }> = [
  { name: 'stats.ts: inferredEffort.note', text: INFERRED_EFFORT_NOTE },
  { name: 'stats.ts: subAgentModelAttribution.note', text: SUB_AGENT_MODEL_ATTRIBUTION_NOTE },
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
    // A template contributes its TEXT, one chunk per gap between `${…}`. The
    // interpolations themselves are code and are deliberately not read: an
    // expression naming `data.model_usage` is an identifier, not a word on
    // screen.
    expect(found).toContain('a');
    expect(found).toContain('template');
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

  test('a possessive in rendered prose is an apostrophe, not a string opener', () => {
    const sample = "const a = <p>this window's rows and the panel's note</p>;\nconst b = 'still a literal';";
    const found = renderedText(sample);
    expect(found).toContain("this window's rows and the panel's note");
    expect(found).toContain('still a literal');
  });

  test('text after an interpolation is read, not only the run before it', () => {
    const found = renderedText('const a = <p>before {n} after the tool_calls table</p>;');
    expect(found.some((s) => s.includes('after the tool_calls table'))).toBe(true);
  });

  test('a nested template does not end its parent early', () => {
    const found = renderedText('const a = `outer ${x ? `inner` : y} tail`;');
    expect(found).toContain('outer');
    expect(found).toContain('inner');
    expect(found).toContain('tail');
  });

  // ---- Coverage, measured rather than assumed -----------------------------
  //
  // The first version of this file checked only that each file yielded "more
  // than 10" rendered strings. Every file passed that while one of them was
  // 34% blind: a yield count cannot see a region, only a total. These two tests
  // plant a known leak and check it is found, which is the only question that
  // matters.

  test('every swept file scans end to end without losing sync', () => {
    for (const f of FILES) {
      expect(scansCleanly(read(f)), `${basename(f)}: scanner did not return to the top frame`).toBe(true);
    }
  });

  test('a leak planted ANYWHERE in a swept file is caught — every blank line, and the end of file', () => {
    const PLANT = "const planted = 'PLANTED leak on the PR from tool_calls';";
    const caught = (src: string) =>
      renderedText(src).some((t) => t.includes('PLANTED') && DENIED.some((d) => d.pattern.test(t)));

    for (const f of FILES) {
      const lines = read(f).split('\n');
      const points: number[] = [];
      for (let i = 0; i < lines.length; i++) if (lines[i]!.trim() === '') points.push(i);
      // A file with nowhere to plant would make this test vacuous. The floor is
      // 1, not the 10 it was while FILES held only six large modules: a small
      // presentational component legitimately has few blank lines, and three of
      // the four files added to FILES sit at or below 10 (card-glossary.tsx 3,
      // telemetry-table.tsx 9, tool-usage.tsx 10, against 16-62 for the rest).
      // Keeping 10 would have meant either dropping those files from the sweep
      // or padding them with blank lines to satisfy a test.
      //
      // What licenses the lower floor is a MEASUREMENT, not the argument above.
      // Blank lines are a sample, and a clean sample is not the same as a
      // representative one — so the extractor was re-run planting at EVERY line
      // of all ten files, not just the blank ones: 3,939 plants, 512 of them
      // blind, and every single blind point inside a comment, a JSDoc block or a
      // template-literal interior, where a plant is genuinely not rendered text.
      // ZERO blind outside those. The blank-line sample is therefore not hiding
      // a region, which is the property the old floor of 10 was a crude proxy
      // for. Re-run that measurement if the extractor changes; the count here is
      // not what protects the sweep, `blind` being empty is, and the end-of-file
      // plant below is a second independent site that runs whatever this is.
      expect(points.length, `${basename(f)}: no plant points`).toBeGreaterThan(0);

      const blind = points.filter((i) => !caught([...lines.slice(0, i), PLANT, ...lines.slice(i)].join('\n')));
      expect(blind, `${basename(f)}: leak invisible at ${blind.length}/${points.length} points, first at line ${blind[0]! + 1}`)
        .toEqual([]);
      // End of file is its own case: a scanner that desyncs part-way through
      // swallows everything after, and the tail is what it swallows last.
      expect(caught(`${read(f)}\n${PLANT}\n`), `${basename(f)}: leak at end of file invisible`).toBe(true);
    }
  });

  test('the deny list catches what it is for', () => {
    const hit = (s: string) => DENIED.filter((d) => d.pattern.test(s)).map((d) => d.name);
    expect(hit('N of M raised on the PR')).toEqual(['PR']);
    expect(hit('across 3 PRs')).toEqual(['PR']);
    expect(hit('read-band items per review')).toEqual(['read-band']);
    expect(hit('no rows in tool_calls')).toEqual(['tool_calls']);
    expect(hit('the model_usage breakdown')).toEqual(['model_usage']);
    expect(hit('the sub_agents roster')).toEqual(['sub_agents']);
    // The three entries below were deletable in SILENCE: removing any one of
    // them from DENIED left this file at 25 pass / 0 fail, because no card
    // currently renders them and nothing else named them. A deny entry that
    // nothing exercises is one tidy-up away from being dropped as dead weight,
    // and it would take the guard with it — error_max_turns is the token this
    // branch has just removed from the page, so it is precisely the one that
    // must still fail if it comes back.
    expect(hit('findings_list is empty')).toEqual(['findings_list']);
    expect(hit('said_confidence below threshold')).toEqual(['said_confidence']);
    expect(hit('stopped with error_max_turns')).toEqual(['error_max_turns']);
    // Title case reaches the page — these are the two real titles Tasks 8 and 9
    // fixed by hand, and a case-sensitive pattern caught neither.
    expect(hit('Read-band findings raised')).toEqual(['read-band']);
    expect(hit('Read-band health (avg critical+major findings per review)')).toEqual(['read-band']);
    expect(hit('3 review(s) excluded')).toEqual(['(s) placeholder']);
    // ...and does not fire on the words that replaced them.
    expect(hit('across 3 pull requests')).toEqual([]);
    expect(hit('critical or major items per review')).toEqual([]);
    expect(hit('No tool activity recorded in this window.')).toEqual([]);
  });

  // The pattern is a plain substring match — `/\(s\)/` fires on ANY text
  // containing that literal three characters, including `.map((s) => ...)`'s
  // arrow-function parameter, which two of the six swept files use
  // (stats-costquality.tsx:717,719 and stats-operational.tsx:140). That is not
  // a false positive to guard against in the pattern itself (a raw string like
  // 'rows.map((s) => s.name)' legitimately matches — it really does contain
  // "(s)"); the guarantee has to come from the EXTRACTOR never handing that
  // code fragment to the pattern as rendered text in the first place. This
  // pins that property the way it is actually exercised: through
  // `renderedText()`, on that same code shape, not through `hit()` on a
  // hand-picked string.
  test('an arrow-function parameter named `s` is code, not a rendered plural placeholder', () => {
    const sample = "return <ul>{items.map((s) => <li key={s.id}>{s.label} entries</li>)}</ul>;";
    const found = renderedText(sample);
    // Not vacuous: the list item's own text IS extracted.
    expect(found.some((t) => t.includes('entries'))).toBe(true);
    expect(found.some((t) => /\(s\)/.test(t))).toBe(false);
  });

  // The reviewer's decisive measurement, kept as a test: real strings that were
  // on these cards before this branch, replanted at their own sites. Two of the
  // six were invisible — one to the apostrophe desync, one to the case
  // sensitivity — which is how both holes were found.
  test('every pre-branch string that this branch removed would be caught if it came back', () => {
    const REPLANTED: Array<[string, string]> = [
      ['stats-costquality.tsx', 'Same model_usage breakdown as the Integrity panel'],
      ['stats-costquality.tsx', 'Read-band findings raised'],
      ['stats-costquality.tsx', 'Read-band health (avg critical+major findings per review)'],
      ['stats-operational.tsx', 'No tool_calls recorded'],
      ['stats-integrity.tsx', 'the sub_agents roster'],
      ['stats-review-value.tsx', 'across 3 PRs these findings came from'],
    ];
    for (const [file, text] of REPLANTED) {
      const path = FILES.find((f) => basename(f) === file)!;
      // Planted as JSX text, which is where three of these six really lived.
      const planted = `${read(path)}\nconst Replanted = () => <p>${text}</p>;\n`;
      const found = renderedText(planted).filter((t) => t.includes(text));
      expect(found.length, `${file}: replanted string not extracted at all — "${text}"`).toBeGreaterThan(0);
      expect(found.some((t) => DENIED.some((d) => d.pattern.test(t))), `${file}: extracted but not denied — "${text}"`).toBe(true);
    }
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

  // The two server-built notes (see SERVER_NOTES above): already-evaluated
  // strings, not source text, so this checks them directly against DENIED —
  // no extractor involved, and none needed, since there is no comment,
  // identifier or class= to strip out of a plain string.
  for (const { name, text } of SERVER_NOTES) {
    test(name, () => {
      const offences = DENIED.filter((d) => d.pattern.test(text)).map((d) => `${d.name} — ${text}`);
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
