import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import type { PipelineConfig, PipelineContext, PipelineState } from '../../../src/types/pipeline.types.ts';
import { BackportReviewSchema } from '../../../src/agents/cherry-pick-reviewer/schema.ts';
import {
  createBackportReviewConfig,
  type BackportReviewParams,
} from '../../../src/agents/cherry-pick-reviewer/config.ts';
import { renderDiffComparison } from '../../../src/sdk/ado/backport.ts';

const PROMPT_URL = new URL('../../../src/agents/cherry-pick-reviewer/CLAUDE.md', import.meta.url);
const PROMPT = readFileSync(PROMPT_URL, 'utf8');

/**
 * The body of the `## ` section whose heading matches, up to the next `## `.
 *
 * Assertions are scoped through this rather than run against the whole file: a
 * whole-file `toContain` passes on a word that happens to appear anywhere, which
 * on an earlier plan meant a test that passed before its own fix and asserted
 * nothing. Throwing on a missing section also makes a renamed heading a failure
 * with a readable message rather than a silent `undefined`.
 */
function section(heading: RegExp): string {
  const parts = PROMPT.split(/^## /m).slice(1);
  const match = parts.find((p) => heading.test(p.split('\n')[0] ?? ''));
  if (!match) throw new Error(`no "## " section whose heading matches ${heading}`);
  return match;
}

/** Bullets of a section, each joined with its wrapped continuation lines. */
function bullets(body: string): string[] {
  const out: string[] = [];
  let open = false;
  for (const line of body.split('\n')) {
    if (/^\s*[-*]\s/.test(line)) {
      out.push(line.trim());
      open = true;
    } else if (!line.trim()) {
      open = false;
    } else if (open) {
      out[out.length - 1] += ` ${line.trim()}`;
    }
  }
  return out;
}

/** Paragraphs, so a claim can be asserted against the prose that carries it. */
function paragraphs(): string[] {
  return PROMPT.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

// Enough of a config + params to render buildPrompt, so assertions about what the
// runtime prompt says can be derived from it rather than transcribed.
const config = {
  azureDevOps: { orgUrl: 'https://dev.azure.com/o', project: 'p', repositoryId: 'r', pat: 'x', repositoryName: 'Repo' },
  paths: { sessionRoot: '/workspace', targetRepo: '/workspace/repo' },
} as unknown as PipelineConfig;

const params: BackportReviewParams = {
  prId: 52307,
  sourcePrId: 52117,
  repoKey: 'k',
  sourceBranch: 'refs/heads/bug/x',
  targetBranch: 'refs/heads/hotfix/28.3.2',
  diffComparison: renderDiffComparison({ missingFromPort: [], extraInPort: [], changedFiles: [] }),
  sourceReviewStatus: 'not-reviewed',
  sourceRecommendation: null,
  mergePreviewStale: false,
  checkoutOk: true,
  noPost: false,
};

const NO_STATE = {} as PipelineState;
const NO_CTX = {} as PipelineContext;

describe('cherry-pick-reviewer prompt — the three checks', () => {
  test('each check is its own section and names the field it reports', () => {
    // The agent's whole remit. A section that stops naming its schema field is a
    // prompt that asks for a judgement with nowhere to put it.
    expect(section(/^1\./)).toContain('`diffFaithful`');
    expect(section(/^2\./)).toContain('`symbolsResolve`');
    expect(section(/^3\./)).toContain('`coverageIntact`');
  });

  test('check 1 points at the heading renderDiffComparison actually emits', () => {
    // Derived, not transcribed: renaming the heading in backport.ts fails here
    // rather than silently pointing the agent at a heading that no longer exists.
    // The comparison is pre-computed evidence; asking the agent to derive it
    // re-spends the money this path exists to save.
    const heading = renderDiffComparison({ missingFromPort: [], extraInPort: [], changedFiles: [] })
      .split('\n')[0]!;
    const s = section(/^1\./);
    expect(s).toMatch(/faithful/i);
    expect(s).toContain(heading);
  });

  test('check 2 is symbol resolution on this branch, done with the LSP tool', () => {
    // Named as `LSP <operation>`, the form every sibling prompt uses: this agent has
    // no .claude/rules and no lsp-reinforcement fragment, so CLAUDE.md is the only
    // channel telling it which tool carries these operations. Bare operation names
    // leave a Grep-shaped skim reportable as `all`.
    const s = section(/^2\./);
    expect(s).toMatch(/resolve/i);
    expect(s).toContain('LSP hover');
    expect(s).toContain('LSP documentSymbol');
  });

  test('check 2 states the checked-out tree lives in a subdirectory, not at the top of the working directory', () => {
    // The session root (this agent's cwd) is not itself the checked-out tree — the
    // entrypoint clones one level down. A prompt implying otherwise costs the agent
    // turns discovering the true layout, with no retry to absorb it (maxTurns 60).
    const s = section(/^2\./);
    expect(s).toMatch(/subdirectory/i);
  });

  test('check 3 is coverage, done with LSP findReferences', () => {
    // The most valuable class of backport defect lives here: faithful port, every
    // symbol resolves, and a call site this branch has bypasses the fix.
    const s = section(/^3\./);
    expect(s).toMatch(/cover/i);
    expect(s).toContain('LSP findReferences');
  });

  test('the LSP operations are reachable from a task, not just named in prose', () => {
    // The measured `operation-mapping-plus-append` result: a task -> operation
    // mapping in CLAUDE.md is the channel that moves LSP usage. Prose alone was
    // never shown sufficient.
    const s = section(/code intelligence/i);
    for (const op of ['LSP hover', 'LSP documentSymbol', 'LSP findReferences']) {
      expect(`${op} mapped from a task: ${s.includes(op)}`).toBe(`${op} mapped from a task: true`);
    }
    expect(s).toMatch(/\| I need to/);
  });

  test('every permitted value of every check field is spelled out', () => {
    // Derived from the schema, so adding an enum value it does not explain fails
    // here rather than in production as an unexplained verdict.
    for (const field of ['diffFaithful', 'symbolsResolve', 'coverageIntact'] as const) {
      const values = (BackportReviewSchema.shape[field] as { options: readonly string[] }).options;
      for (const v of values) {
        expect(`${field}.${v} explained: ${PROMPT.includes(`\`${v}\``)}`)
          .toBe(`${field}.${v} explained: true`);
      }
    }
  });
});

describe('cherry-pick-reviewer prompt — scope', () => {
  test('states what was already judged, so the deep review is not re-run', () => {
    const s = section(/already been judged/i);
    expect(s).toMatch(/already (been )?(judged|reviewed)/i);
    // Naming the categories is what keeps them out: "focus on the port" alone has
    // not stopped a reviewer from re-deriving the source review.
    for (const topic of ['style', 'performance', 'security', 'architecture', 'test coverage']) {
      expect(`${topic} named as already judged: ${s.toLowerCase().includes(topic)}`)
        .toBe(`${topic} named as already judged: true`);
    }
  });
});

describe('cherry-pick-reviewer prompt — findings', () => {
  test('a finding carries a repo-relative file and a RIGHT-side line', () => {
    const s = section(/^Reporting/);
    expect(s).toContain('repo-relative');
    expect(s).toMatch(/RIGHT \(source-branch\) side/);
    expect(s).toContain('`location`');
  });

  test('a finding with no single location omits file and line', () => {
    // A guessed line anchors an inline comment to unrelated code.
    const s = section(/^Reporting/);
    expect(s).toMatch(/omit/i);
  });
});

describe('cherry-pick-reviewer prompt — recommendation', () => {
  test('maps the check outcomes to the three recommendation strings', () => {
    const s = section(/^Recommendation/);
    for (const r of ['approve', 'request changes', 'needs discussion']) {
      expect(`recommendation "${r}" mapped: ${s.includes(r)}`)
        .toBe(`recommendation "${r}" mapped: true`);
    }
  });

  test('unverified maps to needs discussion, and to nothing else', () => {
    // "I could not check" is a caveat, not an endorsement. A rule that lets an
    // unverified check reach `approve` turns the cheap path into a rubber stamp.
    const unverified = bullets(section(/^Recommendation/)).filter((b) => /unverified/i.test(b));
    expect(unverified.length).toBeGreaterThan(0);
    for (const b of unverified) {
      expect(b).toContain('needs discussion');
      expect(b).not.toMatch(/\bapproves?\b/i);
    }
  });

  test('a not-reviewed source PR is called out in the summary', () => {
    // That change has no recorded deep review anywhere; a human may want to ask
    // for a full one, and can only do that if the summary says so.
    const said = paragraphs().filter((p) => p.includes('not-reviewed'));
    expect(said.length).toBeGreaterThan(0);
    expect(said.some((p) => /summary/i.test(p) && /full review/i.test(p))).toBe(true);
  });
});

describe('cherry-pick-reviewer prompt — incompleteness', () => {
  test('unverified covers any unestablished answer, not only missing infrastructure', () => {
    // The rubber-stamp path. Defined as exactly two infrastructure conditions — no
    // checkout, no LSP — `unverified` has no bucket for "I did not actually finish
    // this check". A model in that state can only report `all` / `intact`, and the
    // verdict mapping then does its job perfectly and reaches approve.
    for (const check of [/^2\./, /^3\./]) {
      const bullet = bullets(section(check)).find((b) => /`unverified`/.test(b)) ?? '';
      expect(bullet).toMatch(/did not establish|could not establish/i);
    }
  });

  test('a check that cannot be finished still posts and returns a review', () => {
    // Without this, running short of room is a maxTurns death: no structured
    // output, no retry, every telemetry column null — the failure erases its own
    // evidence. With it, the same run lands as a needs-discussion review naming
    // what it skipped.
    const s = section(/cannot be completed/i);
    expect(s).toContain('`unverified`');
    expect(s).toMatch(/short of room/i);
    expect(s).toMatch(/summary/i);
    expect(s).toMatch(/return/i);
  });

  test('the clean verdicts are stated as things checked, not things assumed', () => {
    const resolve = bullets(section(/^2\./)).find((b) => b.startsWith('- `all`')) ?? '';
    const coverage = bullets(section(/^3\./)).find((b) => b.startsWith('- `intact`')) ?? '';
    expect(resolve).toMatch(/you checked|you looked|you walked/i);
    expect(coverage).toMatch(/you checked|you looked|you walked/i);
  });
});

describe('cherry-pick-reviewer prompt — structured output', () => {
  test('names every field the schema requires, in the section that lists them', () => {
    // The assertion that catches prompt and schema drifting apart: a field added
    // to BackportReviewSchema that the prompt never asks for comes back invented
    // or absent, and the run fails validation with nothing pointing here.
    //
    // Scoped to the output section rather than the whole file: 8 of the 14 field
    // names also appear in the prose above, so a whole-file match stays green when
    // a field's output-section bullet is deleted.
    const s = section(/^The structured result/);
    for (const key of Object.keys(BackportReviewSchema.shape)) {
      expect(`\`${key}\` listed in the structured result: ${s.includes(`\`${key}\``)}`)
        .toBe(`\`${key}\` listed in the structured result: true`);
    }
  });

  test('explains the polarity of the one boolean the prompt renders inverted', () => {
    // config.ts:145 renders the GOOD case ("Merge preview current: yes/no") while
    // the field records the BAD one, so the model has to invert a boolean whose
    // name negates its label — and this is the single boolean that flips a verdict.
    // Derived from buildPrompt, so rewording the rendered line fails here unless
    // the explanation follows it.
    const rendered = createBackportReviewConfig(config, { ...params, mergePreviewStale: true })
      .buildPrompt(NO_STATE, NO_CTX);
    const line = rendered.split('\n').find((l) => l.includes('Merge preview current')) ?? '';
    const label = line.replace(/[*\-]/g, '').split('—')[0]!.trim();
    expect(label).toMatch(/^Merge preview current/); // the derivation found something real

    const explains = paragraphs().filter((p) => p.includes(label));
    expect(explains.length).toBeGreaterThan(0);
    expect(explains.some((p) => p.includes('`mergePreviewStale`') && /\btrue\b/.test(p))).toBe(true);
  });

  test('says what sourceRecommendation is when there is none to state', () => {
    // buildPrompt renders nothing at all for a null recommendation, so the field is
    // the one place the model can learn what to put there.
    const b = bullets(section(/^The structured result/))
      .find((x) => x.includes('`sourceRecommendation`')) ?? '';
    expect(b).toContain('`null`');
  });

  test('names the MCP comment tool it must post through', () => {
    // runBackportReview fails the run when neither comment tool was called, so a
    // prompt that leaves the channel implicit fails every non-replay review.
    expect(PROMPT).toContain('mcp__azureDevOps__add_pull_request_comment');
  });

  test('tells the model to reuse a prior finding\'s file and title verbatim, in positive framing', () => {
    // Without this, a re-review of a backport has nothing to be stable against
    // and forks every existing thread into a duplicate instead of updating it.
    // pr-reviewer/CLAUDE.md carries the identical instruction for its own
    // re-review case; framed as what TO do, not as a prohibition — negative
    // framing is measured on this codebase to suppress the behaviour outright.
    const b = bullets(section(/^The structured result/))
      .find((x) => x.includes('`findingsList`')) ?? '';
    expect(b).toMatch(/already tracked on this PR/i);
    expect(b).toContain('verbatim');
    expect(b).not.toMatch(/\b(never|must not|shall not|do not|don't)\b/i);
  });
});

describe('cherry-pick-reviewer prompt — framing', () => {
  test('uses no prohibition framing', () => {
    // Measured on this codebase: "never do X" suppresses the behaviour outright
    // rather than redirecting it. Consequences, not prohibitions.
    expect(PROMPT).not.toMatch(
      /\b(never|must not|shall not|do not|don't|do NOT)\s+(use|call|dispatch|run|guess|invent|post|report|open|read|repeat|re-?review|include|add|edit|write|modify|assume|skip|omit|flag)\b/i,
    );
    // The bare forms carry the same framing whatever verb follows them.
    expect(PROMPT).not.toMatch(/\b(never|must not|shall not)\b/i);
  });
});

describe('cherry-pick-reviewer prompt — line endings', () => {
  test('is committed LF-only', () => {
    // A CRLF frontmatter delimiter makes an agent undiscoverable, the orchestrator
    // falls back, and cost triples with nothing in the logs.
    //
    // Read from the working tree, which `.gitattributes` (`* text=auto`) renders
    // platform-native — CRLF on a Windows checkout, LF on Linux — so uniformity is
    // what this can assert, not absence. What it does catch is the realistic
    // corruption: a lone CR, or a file half-converted by a tool that rewrote some
    // lines and not others. That the committed blob itself is LF is enforced by
    // that same `text=auto` rule, and verified by hand with
    // `git show HEAD:src/agents/cherry-pick-reviewer/CLAUDE.md | grep -c $'\r'`.
    const raw = readFileSync(PROMPT_URL, 'utf8');
    expect(/\r(?!\n)/.test(raw)).toBe(false);
    const crlf = (raw.match(/\r\n/g) ?? []).length;
    const lf = (raw.match(/\n/g) ?? []).length;
    expect(crlf === 0 || crlf === lf).toBe(true);
  });
});
