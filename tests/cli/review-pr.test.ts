import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  maybeInjectToolRule,
  maybeOverrideSubAgentModel,
  maybeRestrictAgentSet,
  buildAgentSetBlock,
  AGENT_SET_MARKER,
  SUBAGENT_TOOL_RULE,
  maybeInjectRouting,
  AGENT_TRIGGERS,
  ROUTING_MARKER,
  maybeInjectScopedPayload,
  SCOPED_PAYLOAD_MARKER,
  SCOPED_PAYLOAD_BLOCK,
  trimSecurityDomains,
  trimSecurityDispatchLine,
  maybeTrimSecurityDomains,
  applyInlineFindings,
  buildPriorFindingsBlock,
  parseReviewPrArgs,
  collectAppliedLevers,
  isTestRun,
  buildReviewBaseConfig,
} from '../../src/cli/review-pr.ts';
import { findingKey, markerFor } from '../../src/sdk/ado/finding-key.ts';
import type { ReviewThread } from '../../src/sdk/ado/pull-requests.ts';
import type { ISettingsStore } from '../../src/config/settings-store.interface.ts';

// ---------------------------------------------------------------------------
// EVAL-ONLY A/B hooks
//
// Both mutate sub-agent definition files on disk, so what matters most is that
// they are TRUE no-ops unless explicitly switched on — a production PR review
// must never have its prompts or pinned models rewritten underneath it.
// ---------------------------------------------------------------------------

function withEnv(key: string) {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[key]; delete process.env[key]; });
  afterEach(() => { if (saved === undefined) delete process.env[key]; else process.env[key] = saved; });
}

describe('maybeInjectToolRule', () => {
  withEnv('PR_REVIEW_SUBAGENT_TOOL_RULE');

  test('is a no-op when unset — production runs must not be mutated', () => {
    expect(maybeInjectToolRule()).toBe(0);
  });

  test('is a no-op for any value other than "1"', () => {
    process.env['PR_REVIEW_SUBAGENT_TOOL_RULE'] = 'true';
    expect(maybeInjectToolRule()).toBe(0);
    process.env['PR_REVIEW_SUBAGENT_TOOL_RULE'] = '0';
    expect(maybeInjectToolRule()).toBe(0);
    process.env['PR_REVIEW_SUBAGENT_TOOL_RULE'] = '';
    expect(maybeInjectToolRule()).toBe(0);
  });
});

describe('maybeOverrideSubAgentModel', () => {
  withEnv('PR_REVIEW_SUBAGENT_MODEL');

  test('is a no-op when unset', () => {
    expect(maybeOverrideSubAgentModel()).toBe(0);
  });

  test('is a no-op for an empty or whitespace value', () => {
    process.env['PR_REVIEW_SUBAGENT_MODEL'] = '   ';
    expect(maybeOverrideSubAgentModel()).toBe(0);
  });
});

describe('maybeRestrictAgentSet', () => {
  withEnv('PR_REVIEW_AGENT_SET');

  test('is a no-op when unset', () => {
    delete process.env['PR_REVIEW_AGENT_SET'];
    expect(maybeRestrictAgentSet()).toBe(0);
  });

  test('is a no-op when blank', () => {
    process.env['PR_REVIEW_AGENT_SET'] = '   ';
    expect(maybeRestrictAgentSet()).toBe(0);
  });

  test('builds a positive directive naming only the selected agents', () => {
    const block = buildAgentSetBlock(['code-review-validator', 'al-performance-analyzer']);
    expect(block).toContain('code-review-validator');
    expect(block).toContain('al-performance-analyzer');
    expect(block).not.toContain('al-integration-analyzer');
    // Positive framing only — no prohibition language.
    expect(block.toLowerCase()).not.toContain('never');
    expect(block.toLowerCase()).not.toContain('do not dispatch');
  });

  test('trims whitespace and drops empty entries', () => {
    const block = buildAgentSetBlock([' code-review-validator ', '', 'al-performance-analyzer']);
    expect(block).toContain('1. `code-review-validator`');
    expect(block).toContain('2. `al-performance-analyzer`');
  });

  // -------------------------------------------------------------------------
  // The apply branch — actually writes to the TRACKED orchestrator prompt at
  // src/agents/pr-reviewer/CLAUDE.md. Every test here snapshots the file's real
  // content before mutating it and restores that exact content in afterEach, so
  // the suite leaves the working tree exactly as clean as it found it — this is
  // deliberately the real file, not a temp copy, because `maybeRestrictAgentSet`
  // resolves the path from `import.meta.url` with no injection point; pointing
  // it elsewhere would mean these tests exercise a path the production code
  // never takes.
  // -------------------------------------------------------------------------
  describe('the write path (mutates the real orchestrator prompt, restored after each test)', () => {
    const promptPath = fileURLToPath(new URL('../../src/agents/pr-reviewer/CLAUDE.md', import.meta.url));
    let original: string;

    beforeEach(() => { original = readFileSync(promptPath, 'utf-8'); });
    afterEach(() => { writeFileSync(promptPath, original); });

    test('applies the block and reports 1 file modified', () => {
      // Fails if the final `return 1` were flipped to `return 0` — the write
      // would still happen but the caller would be told it didn't.
      process.env['PR_REVIEW_AGENT_SET'] = 'code-review-validator,al-performance-analyzer';
      const result = maybeRestrictAgentSet();
      expect(result).toBe(1);

      const updated = readFileSync(promptPath, 'utf-8');
      expect(updated).toContain(AGENT_SET_MARKER);
      expect(updated).toContain('code-review-validator');
      expect(updated).toContain('al-performance-analyzer');
    });

    test('appends after the existing prompt instead of clobbering it', () => {
      // Fails if `writeFileSync(promptPath, \`${content.trimEnd()}\n...\`)` lost
      // the `content.trimEnd()}\n` prefix and wrote only the new block — the
      // exact regression the reviewer named (deleting that prefix would pass
      // every other test in this suite undetected).
      process.env['PR_REVIEW_AGENT_SET'] = 'code-review-validator';
      maybeRestrictAgentSet();

      const updated = readFileSync(promptPath, 'utf-8');
      expect(original).toContain('Phase 4: Parallel Analysis with Specialized Agents');
      expect(updated).toContain('Phase 4: Parallel Analysis with Specialized Agents');
      // The pre-existing content must still come BEFORE the appended block —
      // proof this is an append, not a same-position overwrite.
      expect(updated.indexOf('Phase 4: Parallel Analysis with Specialized Agents'))
        .toBeLessThan(updated.indexOf(AGENT_SET_MARKER));
    });

    test('a second call is idempotent — the marker appears exactly once and the second call reports 0', () => {
      // Fails if the `if (content.includes(AGENT_SET_MARKER)) return 0;` guard
      // were removed or broken — the second call would append a duplicate block
      // and report 1 again instead of 0.
      process.env['PR_REVIEW_AGENT_SET'] = 'code-review-validator';
      const first = maybeRestrictAgentSet();
      const second = maybeRestrictAgentSet();
      expect(first).toBe(1);
      expect(second).toBe(0);

      const updated = readFileSync(promptPath, 'utf-8');
      const occurrences = updated.split(AGENT_SET_MARKER).length - 1;
      expect(occurrences).toBe(1);
    });
  });
});

describe('maybeInjectRouting', () => {
  withEnv('PR_REVIEW_AGENT_ROUTING');

  test('is a no-op unless set to 1', () => {
    delete process.env['PR_REVIEW_AGENT_ROUTING'];
    expect(maybeInjectRouting()).toBe(0);
    process.env['PR_REVIEW_AGENT_ROUTING'] = '0';
    expect(maybeInjectRouting()).toBe(0);
  });

  test('every always-on agent has an empty trigger list', () => {
    expect(AGENT_TRIGGERS['code-review-validator']).toEqual([]);
  });

  test('conditional agents carry AL-specific triggers', () => {
    expect(AGENT_TRIGGERS['al-integration-analyzer']).toContain('HttpClient');
    expect(AGENT_TRIGGERS['al-performance-analyzer']).toContain('SetLoadFields');
    expect(AGENT_TRIGGERS['al-error-pattern-analyzer']).toContain('FieldError');
  });

  test('all seven agents appear exactly once', () => {
    expect(Object.keys(AGENT_TRIGGERS).sort()).toEqual([
      'al-architecture-analyzer',
      'al-error-pattern-analyzer',
      'al-integration-analyzer',
      'al-performance-analyzer',
      'code-quality-assessor',
      'code-review-validator',
      'security-edge-case-analyzer',
    ]);
  });

  // -------------------------------------------------------------------------
  // Fix round 1, Important 2: the original list only covered codeunit/interface/
  // table constructs, so a PR touching only a Page or Report never dispatched
  // the architecture analyst — a coverage hole, not a routing decision.
  // -------------------------------------------------------------------------
  describe('al-architecture-analyzer trigger coverage', () => {
    const triggers = AGENT_TRIGGERS['al-architecture-analyzer']!;
    // The exact pre-fix list (this task's original brief value) — reused below
    // to prove the diffs it fails on are exactly the ones the fix closes.
    const preFixTriggers = ['codeunit ', 'interface ', 'implements ', 'table ', 'tableextension '];
    const matches = (list: string[], diff: string) => list.some((t) => diff.toLowerCase().includes(t.toLowerCase()));

    test('covers every AL object type keyword, not just codeunit/interface/table', () => {
      for (const kw of ['page ', 'pageextension ', 'report ', 'reportextension ', 'query ', 'xmlport ', 'enum ', 'enumextension ']) {
        expect(triggers).toContain(kw);
      }
    });

    test('a Page-only diff now dispatches al-architecture-analyzer — it did not before this fix', () => {
      const pageOnlyDiff = 'page 50100 "My Page"\n{\n    layout\n    {\n    }\n}\n';
      expect(matches(triggers, pageOnlyDiff)).toBe(true);
      expect(matches(preFixTriggers, pageOnlyDiff)).toBe(false);
    });

    test('a Report-only diff now dispatches al-architecture-analyzer — it did not before this fix', () => {
      const reportOnlyDiff = 'report 50100 "My Report"\n{\n    dataset\n    {\n    }\n}\n';
      expect(matches(triggers, reportOnlyDiff)).toBe(true);
      expect(matches(preFixTriggers, reportOnlyDiff)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // The apply branch — same tracked file `maybeRestrictAgentSet` writes to
  // (src/agents/pr-reviewer/CLAUDE.md). Snapshot/restore around every test so
  // the suite leaves the working tree exactly as clean as it found it — same
  // reasoning and same file as Task 1's write-path block above.
  // -------------------------------------------------------------------------
  describe('the write path (mutates the real orchestrator prompt, restored after each test)', () => {
    const promptPath = fileURLToPath(new URL('../../src/agents/pr-reviewer/CLAUDE.md', import.meta.url));
    let original: string;

    beforeEach(() => { original = readFileSync(promptPath, 'utf-8'); });
    afterEach(() => { writeFileSync(promptPath, original); });

    test('applies the block and reports 1 file modified', () => {
      // Fails if the final `return 1` were flipped to `return 0` — the write
      // would still happen but the caller would be told it didn't.
      process.env['PR_REVIEW_AGENT_ROUTING'] = '1';
      const result = maybeInjectRouting();
      expect(result).toBe(1);

      const updated = readFileSync(promptPath, 'utf-8');
      expect(updated).toContain(ROUTING_MARKER);
      expect(updated).toContain('code-review-validator');
      expect(updated).toContain('al-performance-analyzer');
    });

    test('appends after the existing prompt instead of clobbering it', () => {
      // Fails if `writeFileSync(promptPath, \`${content.trimEnd()}\n...\`)` lost
      // the `content.trimEnd()}\n` prefix and wrote only the new block — the
      // same regression class Task 1's write path guards against.
      process.env['PR_REVIEW_AGENT_ROUTING'] = '1';
      maybeInjectRouting();

      const updated = readFileSync(promptPath, 'utf-8');
      expect(original).toContain('Phase 4: Parallel Analysis with Specialized Agents');
      expect(updated).toContain('Phase 4: Parallel Analysis with Specialized Agents');
      // The pre-existing content must still come BEFORE the appended block —
      // proof this is an append, not a same-position overwrite.
      expect(updated.indexOf('Phase 4: Parallel Analysis with Specialized Agents'))
        .toBeLessThan(updated.indexOf(ROUTING_MARKER));
    });

    test('a second call is idempotent — the marker appears exactly once and the second call reports 0', () => {
      // Fails if the `if (content.includes(ROUTING_MARKER)) return 0;` guard
      // were removed or broken — the second call would append a duplicate block
      // and report 1 again instead of 0.
      process.env['PR_REVIEW_AGENT_ROUTING'] = '1';
      const first = maybeInjectRouting();
      const second = maybeInjectRouting();
      expect(first).toBe(1);
      expect(second).toBe(0);

      const updated = readFileSync(promptPath, 'utf-8');
      const occurrences = updated.split(ROUTING_MARKER).length - 1;
      expect(occurrences).toBe(1);
    });

    test('composes with PR_REVIEW_AGENT_SET — the rendered table is filtered to the active set', () => {
      // The brief's own reasoning for why this matters: cells 6 and 8 set both
      // env vars, and this block is appended AFTER the agent-set block. An
      // unfiltered table would silently re-add an agent Task 1's block just
      // excluded, and both interaction cells the matrix exists for would void.
      const savedSet = process.env['PR_REVIEW_AGENT_SET'];
      process.env['PR_REVIEW_AGENT_SET'] = 'code-review-validator,al-performance-analyzer';
      process.env['PR_REVIEW_AGENT_ROUTING'] = '1';
      try {
        maybeInjectRouting();
        const updated = readFileSync(promptPath, 'utf-8');
        const routingBlock = updated.slice(updated.indexOf(ROUTING_MARKER));
        expect(routingBlock).toContain('code-review-validator');
        expect(routingBlock).toContain('al-performance-analyzer');
        expect(routingBlock).not.toContain('al-integration-analyzer');
        expect(routingBlock).not.toContain('security-edge-case-analyzer');
      } finally {
        if (savedSet === undefined) delete process.env['PR_REVIEW_AGENT_SET'];
        else process.env['PR_REVIEW_AGENT_SET'] = savedSet;
      }
    });

    // ---------------------------------------------------------------------
    // Fix round 1, Important 1: Task 1's block reads as an unconditional
    // imperative ("dispatch these N in parallel") and this block reads as
    // trigger-gated. Landing in the same prompt with nothing saying which one
    // wins would let a model follow Task 1's wording literally and dispatch
    // the named set every time — cells 6/8 would collapse into cell 2's
    // behaviour while looking, from the outside, like routing still ran.
    // ---------------------------------------------------------------------
    test('reconciles with the named agent set — states the set is the ceiling and the table is the decision, with no negative framing', () => {
      const savedSet = process.env['PR_REVIEW_AGENT_SET'];
      process.env['PR_REVIEW_AGENT_SET'] = 'code-review-validator,al-performance-analyzer';
      process.env['PR_REVIEW_AGENT_ROUTING'] = '1';
      try {
        maybeInjectRouting();
        const updated = readFileSync(promptPath, 'utf-8');
        const routingBlock = updated.slice(updated.indexOf(ROUTING_MARKER));
        expect(routingBlock).toContain(
          'Treat the set named above as the agents available to this run, and this table',
        );
        expect(routingBlock).toContain('as what decides which of them to dispatch.');
        // Same broader regex SUBAGENT_TOOL_RULE's sibling test uses, rather than
        // two literal substrings — negative framing is measured on this codebase
        // to suppress the steered behaviour outright instead of redirecting it.
        expect(routingBlock).not.toMatch(/\bNEVER\b|\bDo NOT\b|\bdon't use\b/i);
      } finally {
        if (savedSet === undefined) delete process.env['PR_REVIEW_AGENT_SET'];
        else process.env['PR_REVIEW_AGENT_SET'] = savedSet;
      }
    });

    test('omits the reconciliation sentence when routing runs without a named agent set — there is nothing to reconcile', () => {
      // Without PR_REVIEW_AGENT_SET, Task 1's block does not exist in the prompt
      // at all, so "the set named above" would refer to nothing — the sentence
      // must not print in this case.
      const savedSet = process.env['PR_REVIEW_AGENT_SET'];
      delete process.env['PR_REVIEW_AGENT_SET'];
      process.env['PR_REVIEW_AGENT_ROUTING'] = '1';
      try {
        maybeInjectRouting();
        const updated = readFileSync(promptPath, 'utf-8');
        const routingBlock = updated.slice(updated.indexOf(ROUTING_MARKER));
        expect(routingBlock).not.toContain('Treat the set named above');
      } finally {
        if (savedSet === undefined) delete process.env['PR_REVIEW_AGENT_SET'];
        else process.env['PR_REVIEW_AGENT_SET'] = savedSet;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// maybeInjectScopedPayload
//
// Same shape as the two hooks above: TRUE no-op unless PR_REVIEW_SCOPED_PAYLOAD=1,
// appends to the same tracked orchestrator prompt, idempotent on a second call.
// ---------------------------------------------------------------------------

describe('maybeInjectScopedPayload', () => {
  withEnv('PR_REVIEW_SCOPED_PAYLOAD');

  test('is a no-op unless set to 1', () => {
    delete process.env['PR_REVIEW_SCOPED_PAYLOAD'];
    expect(maybeInjectScopedPayload()).toBe(0);
    process.env['PR_REVIEW_SCOPED_PAYLOAD'] = '';
    expect(maybeInjectScopedPayload()).toBe(0);
  });

  test('is a no-op for any value other than "1"', () => {
    process.env['PR_REVIEW_SCOPED_PAYLOAD'] = 'true';
    expect(maybeInjectScopedPayload()).toBe(0);
    process.env['PR_REVIEW_SCOPED_PAYLOAD'] = '0';
    expect(maybeInjectScopedPayload()).toBe(0);
  });

  test('the block preserves the always-full-context exemption', () => {
    expect(SCOPED_PAYLOAD_BLOCK).toContain('code-review-validator');
    expect(SCOPED_PAYLOAD_BLOCK).toContain('every changed file');
  });

  test('the block keeps the diff going to everyone', () => {
    expect(SCOPED_PAYLOAD_BLOCK).toContain('full diff');
  });

  test('positive framing only — no prohibition language', () => {
    // Same broader regex used throughout this file rather than literal substrings —
    // negative framing is measured on this codebase to suppress steered behaviour
    // outright instead of redirecting it.
    expect(SCOPED_PAYLOAD_BLOCK).not.toMatch(/\bNEVER\b|\bDo NOT\b|\bdon't use\b/i);
  });

  // -------------------------------------------------------------------------
  // Composition / correctness fix, found by reading this lever against its own
  // Interfaces section ("Consumes: AGENT_TRIGGERS from Task 2") before writing it.
  // -------------------------------------------------------------------------

  test('generalizes the full-source exemption to every empty-trigger agent, not just code-review-validator', () => {
    // AGENT_TRIGGERS gives code-quality-assessor an empty trigger list too (it is the
    // other "always-on" dispatch, per that constant's own doc comment). Read literally,
    // "include a file when it contains one of the agent's triggers" is vacuously false
    // for an agent with NO triggers — it would receive zero full-source files on every
    // single review, silently, forever. Fails if code-quality-assessor is dropped back
    // out of the "Always" treatment (e.g. the filter narrowed to exclude it too).
    expect(AGENT_TRIGGERS['code-quality-assessor']).toEqual([]);
    expect(SCOPED_PAYLOAD_BLOCK).toContain('code-quality-assessor');
    expect(SCOPED_PAYLOAD_BLOCK).toMatch(/`code-quality-assessor`\s*\|\s*Always/);
  });

  test('renders concrete trigger strings — the mechanism the brief\'s own Interfaces section names as consumed', () => {
    // Needed for matrix cell 4 (`scoped`): PR_REVIEW_SCOPED_PAYLOAD=1 with routing OFF,
    // so ROUTING_MARKER's table never renders in that cell's prompt. Without its own
    // copy of the trigger strings, this block would ask the orchestrator to scope
    // "using the same trigger strings that decide dispatch" while printing none of them
    // anywhere it can read — a lever that reads as active but has no defined mechanism.
    expect(SCOPED_PAYLOAD_BLOCK).toContain('HttpClient');
    expect(SCOPED_PAYLOAD_BLOCK).toContain('SetLoadFields');
    expect(SCOPED_PAYLOAD_BLOCK).toContain('FieldError');
  });

  test('no contradiction with the agent-set or routing blocks — different axis, not just different lever', () => {
    // Task 1 (AGENT_SET_MARKER) and Task 2 (ROUTING_MARKER) both govern WHICH agents
    // are dispatched. This block never states or implies a dispatch decision — it only
    // says what a DISPATCHED agent reads — so there is nothing for the three blocks to
    // disagree about even with all three active in one run. Pinned as a property of the
    // text itself, not just documentation.
    expect(SCOPED_PAYLOAD_BLOCK.toLowerCase()).not.toContain('dispatch these');
    expect(SCOPED_PAYLOAD_BLOCK.toLowerCase()).not.toContain('choose the roster');
  });

  // -------------------------------------------------------------------------
  // The apply branch — same tracked file `maybeRestrictAgentSet` and
  // `maybeInjectRouting` write to (src/agents/pr-reviewer/CLAUDE.md). Snapshot/restore
  // around every test so the suite leaves the working tree exactly as clean as it
  // found it, including when a test fails mid-way — same reasoning as Tasks 1 and 2.
  // -------------------------------------------------------------------------
  describe('the write path (mutates the real orchestrator prompt, restored after each test)', () => {
    const promptPath = fileURLToPath(new URL('../../src/agents/pr-reviewer/CLAUDE.md', import.meta.url));
    let original: string;

    beforeEach(() => { original = readFileSync(promptPath, 'utf-8'); });
    afterEach(() => { writeFileSync(promptPath, original); });

    test('applies the block and reports 1 file modified', () => {
      // Fails if the final `return 1` were flipped to `return 0` — the write would
      // still happen but the caller would be told it didn't.
      process.env['PR_REVIEW_SCOPED_PAYLOAD'] = '1';
      const result = maybeInjectScopedPayload();
      expect(result).toBe(1);

      const updated = readFileSync(promptPath, 'utf-8');
      expect(updated).toContain(SCOPED_PAYLOAD_MARKER);
      expect(updated).toContain('code-review-validator');
      expect(updated).toContain('code-quality-assessor');
    });

    test('appends after the existing prompt instead of clobbering it', () => {
      // Fails if `writeFileSync(promptPath, \`${content.trimEnd()}\n...\`)` lost the
      // `content.trimEnd()}\n` prefix and wrote only the new block — the same
      // regression class Tasks 1 and 2's write paths guard against.
      process.env['PR_REVIEW_SCOPED_PAYLOAD'] = '1';
      maybeInjectScopedPayload();

      const updated = readFileSync(promptPath, 'utf-8');
      expect(original).toContain('Phase 4: Parallel Analysis with Specialized Agents');
      expect(updated).toContain('Phase 4: Parallel Analysis with Specialized Agents');
      // The pre-existing content must still come BEFORE the appended block — proof
      // this is an append, not a same-position overwrite.
      expect(updated.indexOf('Phase 4: Parallel Analysis with Specialized Agents'))
        .toBeLessThan(updated.indexOf(SCOPED_PAYLOAD_MARKER));
    });

    test('a second call is idempotent — the marker appears exactly once and the second call reports 0', () => {
      // Fails if the `if (content.includes(SCOPED_PAYLOAD_MARKER)) return 0;` guard
      // were removed or broken — the second call would append a duplicate block and
      // report 1 again instead of 0.
      process.env['PR_REVIEW_SCOPED_PAYLOAD'] = '1';
      const first = maybeInjectScopedPayload();
      const second = maybeInjectScopedPayload();
      expect(first).toBe(1);
      expect(second).toBe(0);

      const updated = readFileSync(promptPath, 'utf-8');
      const occurrences = updated.split(SCOPED_PAYLOAD_MARKER).length - 1;
      expect(occurrences).toBe(1);
    });

    test('composes cleanly with agent-set + routing both active — all three blocks land, none clobber the others, and the scoping table excludes an agent the set already dropped', () => {
      // Direct proof for the "all three active" composition question the task asked
      // to be checked: apply Task 1's and Task 2's hooks first (the fixed order
      // reviewPR itself uses), then this one, and confirm all three markers survive
      // with the pre-existing prompt content still intact before all of them.
      const savedSet = process.env['PR_REVIEW_AGENT_SET'];
      const savedRouting = process.env['PR_REVIEW_AGENT_ROUTING'];
      process.env['PR_REVIEW_AGENT_SET'] = 'code-review-validator,al-performance-analyzer';
      process.env['PR_REVIEW_AGENT_ROUTING'] = '1';
      process.env['PR_REVIEW_SCOPED_PAYLOAD'] = '1';
      try {
        maybeRestrictAgentSet();
        maybeInjectRouting();
        maybeInjectScopedPayload();

        const updated = readFileSync(promptPath, 'utf-8');
        expect(updated).toContain(AGENT_SET_MARKER);
        expect(updated).toContain(ROUTING_MARKER);
        expect(updated).toContain(SCOPED_PAYLOAD_MARKER);
        expect(updated.indexOf('Phase 4: Parallel Analysis with Specialized Agents'))
          .toBeLessThan(updated.indexOf(AGENT_SET_MARKER));
        expect(updated.indexOf(AGENT_SET_MARKER)).toBeLessThan(updated.indexOf(ROUTING_MARKER));
        expect(updated.indexOf(ROUTING_MARKER)).toBeLessThan(updated.indexOf(SCOPED_PAYLOAD_MARKER));

        // Fix round 1, Critical: an agent excluded from the active set (here,
        // code-quality-assessor — not in PR_REVIEW_AGENT_SET above) must not appear as
        // a scoping row. Task 1's block already told the orchestrator "the available
        // sub-agent set is exactly these 2" (code-quality-assessor absent); a stray
        // "Always — full source of every changed file" row for it in THIS section
        // would be a direct contradiction in the same prompt, not an inert leftover —
        // the exact B1 defect class `buildRoutingBlock` already had to fix once for
        // cells 6/8, the interaction cells the matrix exists for.
        const scopedSection = updated.slice(updated.indexOf(SCOPED_PAYLOAD_MARKER));
        expect(scopedSection).not.toContain('code-quality-assessor');
        expect(scopedSection).toContain('al-performance-analyzer');
      } finally {
        if (savedSet === undefined) delete process.env['PR_REVIEW_AGENT_SET']; else process.env['PR_REVIEW_AGENT_SET'] = savedSet;
        if (savedRouting === undefined) delete process.env['PR_REVIEW_AGENT_ROUTING']; else process.env['PR_REVIEW_AGENT_ROUTING'] = savedRouting;
      }
    });
  });
});

describe('trimSecurityDomains', () => {
  test('drops the web-appsec domains and keeps the BC one', () => {
    const src = [
      '## Analysis Framework',
      '',
      '### 1. Input Validation & Sanitization',
      '- SQL injection vectors',
      '',
      '### 8. Business Central Platform Security',
      '- **Permission sets**: missing entries',
      '',
      '## Output Format',
      'json here',
    ].join('\n');
    const out = trimSecurityDomains(src);
    expect(out).not.toContain('SQL injection');
    expect(out).toContain('Business Central Platform Security');
    expect(out).toContain('Permission sets');
    // Everything after the framework must survive untouched.
    expect(out).toContain('## Output Format');
    expect(out).toContain('json here');
  });

  test('renumbers the surviving domain to 1 — a lone "### 8." reads as truncated and invites reconstruction', () => {
    const src = [
      '## Analysis Framework',
      '### 1. Input Validation & Sanitization',
      '- SQL injection vectors',
      '### 8. Business Central Platform Security',
      '- Permission sets',
      '## Output Format',
    ].join('\n');
    const out = trimSecurityDomains(src);
    expect(out).toContain('### 1. Business Central Platform Security');
    expect(out).not.toContain('### 8.');
  });

  test('is a no-op on text with no analysis framework', () => {
    expect(trimSecurityDomains('nothing here')).toBe('nothing here');
  });

  test('is a no-op on text with a framework but no Output Format boundary', () => {
    // Guards the second `indexOf` check — without a closing boundary the function
    // must not guess where the framework ends.
    const src = '## Analysis Framework\n### 1. Input Validation\n- x';
    expect(trimSecurityDomains(src)).toBe(src);
  });

  test('is idempotent — running it twice on an already-trimmed framework changes nothing further', () => {
    const src = [
      '## Analysis Framework',
      '### 1. Input Validation & Sanitization',
      '- SQL injection vectors',
      '### 8. Business Central Platform Security',
      '- Permission sets',
      '## Output Format',
    ].join('\n');
    const once = trimSecurityDomains(src);
    const twice = trimSecurityDomains(once);
    expect(twice).toBe(once);
  });

  // ---------------------------------------------------------------------------
  // Fix round 1, Critical — the reviewer's own repro. A structurally valid
  // framework (same headings, same boundaries) whose BC domain has been reworded
  // matches nothing in the `/Business Central Platform Security/` filter, so the
  // naive implementation kept only the pre-framework intro and stripped EVERY
  // domain, including the one this lever exists to preserve. That is silent
  // corruption: `trimmed !== content` is true, so the hook would have written it
  // to the tracked file with no error and no distinguishing log line. The fix is
  // to fail safe — return the original content completely unchanged — rather than
  // fail silent.
  // ---------------------------------------------------------------------------

  test('fails safe (changes nothing) when the BC heading has been reworded — the reviewer\'s exact repro', () => {
    const src = [
      '## Analysis Framework',
      '',
      'For every piece of code or system you analyze, systematically evaluate these security domains:',
      '',
      '### 1. Input Validation & Sanitization',
      '- SQL injection vectors',
      '',
      '### 8. BC Platform & Tenant Security',
      '- Permission sets',
      '',
      '## Output Format',
      'json here',
    ].join('\n');
    const out = trimSecurityDomains(src);
    // The failure mode this guards against: every domain gone, framework empty.
    // The fix is that NOTHING changes when the BC heading cannot be matched.
    expect(out).toBe(src);
  });

  test('fails safe when the framework has no domain matching "Business Central" at all', () => {
    const src = [
      '## Analysis Framework',
      '### 1. Input Validation & Sanitization',
      '- SQL injection vectors',
      '### 2. Authentication',
      '- Session fixation',
      '## Output Format',
    ].join('\n');
    expect(trimSecurityDomains(src)).toBe(src);
  });
});

describe('trimSecurityDispatchLine', () => {
  const withDispatch = (focusLine: string) => [
    '### Agent 3: Security and Edge Case Analysis',
    '',
    'Dispatch the `security-edge-case-analyzer` agent.',
    '',
    focusLine,
    '',
    '### Agent 4: Performance Analysis',
  ].join('\n');

  test('replaces the generic focus-areas line with the BC-only one', () => {
    const src = withDispatch('Focus areas: input validation, authorization gaps, data protection.');
    const out = trimSecurityDispatchLine(src);
    expect(out).not.toContain('input validation, authorization gaps');
    expect(out).toContain('Focus areas: Business Central platform security');
    expect(out).toContain('InherentPermissions');
    // Everything else must survive untouched.
    expect(out).toContain('### Agent 4: Performance Analysis');
  });

  test('is a no-op when the dispatch line is absent', () => {
    const src = '### Agent 3: Security and Edge Case Analysis\n\nSomething else entirely.';
    expect(trimSecurityDispatchLine(src)).toBe(src);
  });

  test('is idempotent — a second application reproduces the identical text', () => {
    const src = withDispatch('Focus areas: input validation, authorization gaps, data protection.');
    const once = trimSecurityDispatchLine(src);
    const twice = trimSecurityDispatchLine(once);
    expect(twice).toBe(once);
  });

  test('positive framing only — no prohibition language', () => {
    const out = trimSecurityDispatchLine(withDispatch('Focus areas: input validation.'));
    expect(out).not.toMatch(/\bNEVER\b|\bDo NOT\b|\bdon't use\b/i);
  });
});

describe('maybeTrimSecurityDomains', () => {
  withEnv('PR_REVIEW_SECURITY_BC_ONLY');
  withEnv('PR_REVIEW_AGENT_SET');

  test('is a no-op unless set to 1', () => {
    delete process.env['PR_REVIEW_SECURITY_BC_ONLY'];
    expect(maybeTrimSecurityDomains()).toBe(0);
  });

  test('is a no-op for any value other than "1"', () => {
    // Malformed values, not just unset — the global TRUE-NO-OP constraint this
    // plan holds every lever to.
    process.env['PR_REVIEW_SECURITY_BC_ONLY'] = '';
    expect(maybeTrimSecurityDomains()).toBe(0);
    process.env['PR_REVIEW_SECURITY_BC_ONLY'] = 'true';
    expect(maybeTrimSecurityDomains()).toBe(0);
    process.env['PR_REVIEW_SECURITY_BC_ONLY'] = '0';
    expect(maybeTrimSecurityDomains()).toBe(0);
  });

  test('is a no-op when the active agent set excludes security-edge-case-analyzer', () => {
    // Filtered the same way buildRoutingBlock/buildScopedPayloadBlock read
    // PR_REVIEW_AGENT_SET at call time: narrowing a prompt for an agent this run
    // never dispatches measures nothing and should not touch disk.
    process.env['PR_REVIEW_SECURITY_BC_ONLY'] = '1';
    process.env['PR_REVIEW_AGENT_SET'] = 'code-review-validator,al-performance-analyzer';
    expect(maybeTrimSecurityDomains()).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // The apply branch — mutates the two real tracked files
  // (src/agents/pr-reviewer/.claude/agents/security-edge-case-analyzer.md and
  // src/agents/pr-reviewer/CLAUDE.md). Snapshot/restore around every test, same
  // discipline Tasks 1-3 established, so the suite leaves the tree exactly as
  // clean as it found it, including when a test fails mid-way.
  // ---------------------------------------------------------------------------
  describe('the write path (mutates two real tracked files, restored after each test)', () => {
    const agentPath = fileURLToPath(new URL('../../src/agents/pr-reviewer/.claude/agents/security-edge-case-analyzer.md', import.meta.url));
    const promptPath = fileURLToPath(new URL('../../src/agents/pr-reviewer/CLAUDE.md', import.meta.url));
    let originalAgent: string;
    let originalPrompt: string;

    beforeEach(() => {
      originalAgent = readFileSync(agentPath, 'utf-8');
      originalPrompt = readFileSync(promptPath, 'utf-8');
    });
    afterEach(() => {
      writeFileSync(agentPath, originalAgent);
      writeFileSync(promptPath, originalPrompt);
    });

    test('applies the trim to both files and reports 2 files modified', () => {
      // Fails if either write were dropped, or if the count were hardcoded instead
      // of reflecting what actually changed.
      process.env['PR_REVIEW_SECURITY_BC_ONLY'] = '1';
      const result = maybeTrimSecurityDomains();
      expect(result).toBe(2);

      const updatedAgent = readFileSync(agentPath, 'utf-8');
      expect(updatedAgent).not.toContain('SQL injection');
      expect(updatedAgent).toContain('Business Central Platform Security');
      expect(updatedAgent).toContain('### 1. Business Central Platform Security');

      const updatedPrompt = readFileSync(promptPath, 'utf-8');
      expect(updatedPrompt).toContain('Focus areas: Business Central platform security');
      expect(updatedPrompt).not.toContain('Focus areas: input validation, authorization gaps, data protection, information disclosure');
    });

    // -------------------------------------------------------------------------
    // Fix round 1, Critical — the reviewer's own repro, at the hook level. If the
    // real sub-agent file's BC heading were ever reworded, the fix must make the
    // WHOLE hook report 0 and write NEITHER file — not just leave the sub-agent
    // file untouched while still rewriting the orchestrator's dispatch line to
    // say "BC only" (a half-pulled lever in the other direction).
    // -------------------------------------------------------------------------
    test('reports 0 and writes neither file when the sub-agent BC heading has drifted', () => {
      process.env['PR_REVIEW_SECURITY_BC_ONLY'] = '1';
      const drifted = originalAgent.replace(
        '### 8. Business Central Platform Security',
        '### 8. BC Platform & Tenant Security',
      );
      expect(drifted).not.toBe(originalAgent); // sanity: the replace actually matched something
      writeFileSync(agentPath, drifted);

      const result = maybeTrimSecurityDomains();
      expect(result).toBe(0);

      // The drifted sub-agent file is left exactly as it was handed in — not
      // corrupted, not silently "fixed".
      expect(readFileSync(agentPath, 'utf-8')).toBe(drifted);
      // The orchestrator's dispatch line must ALSO be left alone: narrowing it
      // while the sub-agent's own framework still lists every domain would be a
      // half-pulled lever the other way around.
      expect(readFileSync(promptPath, 'utf-8')).toBe(originalPrompt);
    });

    test('surgery only — everything outside the targeted section survives untouched', () => {
      // Proof this is targeted surgery, not a clobber: the frontmatter and every
      // other section of the sub-agent file, and every other agent's dispatch
      // text in the orchestrator prompt, must be byte-identical afterwards.
      process.env['PR_REVIEW_SECURITY_BC_ONLY'] = '1';
      maybeTrimSecurityDomains();

      const updatedAgent = readFileSync(agentPath, 'utf-8');
      expect(originalAgent).toContain('## Resolve Callees Before Flagging Behavior');
      expect(updatedAgent).toContain('## Resolve Callees Before Flagging Behavior');
      expect(updatedAgent).toContain('## Reporting a location');
      expect(updatedAgent.slice(updatedAgent.indexOf('## Output Format')))
        .toBe(originalAgent.slice(originalAgent.indexOf('## Output Format')));
      // Everything BEFORE the framework (frontmatter, the "Your Mission" prose, the
      // .dependencies note) must also survive byte-for-byte — trimSecurityDomains
      // must not clobber the prefix while rebuilding the framework slice.
      expect(updatedAgent.slice(0, updatedAgent.indexOf('## Analysis Framework')))
        .toBe(originalAgent.slice(0, originalAgent.indexOf('## Analysis Framework')));

      const updatedPrompt = readFileSync(promptPath, 'utf-8');
      // Agent 4's own dispatch text is a different agent entirely and must be untouched.
      expect(updatedPrompt).toContain('Focus areas: SetLoadFields usage, N+1 query patterns');
    });

    test('a second call is idempotent — reports 0 and leaves both files byte-identical to the first call\'s result', () => {
      // Fails if the write were unconditional (no content-equality guard) — the
      // second call would report a nonzero count again instead of 0.
      process.env['PR_REVIEW_SECURITY_BC_ONLY'] = '1';
      const first = maybeTrimSecurityDomains();
      const agentAfterFirst = readFileSync(agentPath, 'utf-8');
      const promptAfterFirst = readFileSync(promptPath, 'utf-8');

      const second = maybeTrimSecurityDomains();
      expect(first).toBe(2);
      expect(second).toBe(0);

      expect(readFileSync(agentPath, 'utf-8')).toBe(agentAfterFirst);
      expect(readFileSync(promptPath, 'utf-8')).toBe(promptAfterFirst);
    });

    test('composes cleanly with agent-set + routing + scoped payload all active (matrix cell "lean") — no block contradicts another', () => {
      // Direct render of the config the task brief asked to be checked before
      // writing this lever: all four levers on, in the fixed order reviewPR
      // itself calls them. security-edge-case-analyzer is IN the active set here
      // (only code-quality-assessor is excluded), so every block below must still
      // name it — narrowing its own analysis framework is not the same decision
      // as excluding it from the roster, and nothing here should read as if it did.
      const savedSet = process.env['PR_REVIEW_AGENT_SET'];
      const savedRouting = process.env['PR_REVIEW_AGENT_ROUTING'];
      const savedScoped = process.env['PR_REVIEW_SCOPED_PAYLOAD'];
      process.env['PR_REVIEW_AGENT_SET'] = 'code-review-validator,security-edge-case-analyzer,al-performance-analyzer,al-architecture-analyzer,al-error-pattern-analyzer,al-integration-analyzer';
      process.env['PR_REVIEW_AGENT_ROUTING'] = '1';
      process.env['PR_REVIEW_SCOPED_PAYLOAD'] = '1';
      process.env['PR_REVIEW_SECURITY_BC_ONLY'] = '1';
      try {
        maybeRestrictAgentSet();
        maybeInjectRouting();
        maybeInjectScopedPayload();
        const result = maybeTrimSecurityDomains();
        expect(result).toBe(2);

        const updatedPrompt = readFileSync(promptPath, 'utf-8');
        // All three appended blocks land, in order, none clobbered.
        expect(updatedPrompt).toContain(AGENT_SET_MARKER);
        expect(updatedPrompt).toContain(ROUTING_MARKER);
        expect(updatedPrompt).toContain(SCOPED_PAYLOAD_MARKER);
        // security-edge-case-analyzer is named as available and routed/scoped —
        // narrowing its own file does not, and must not, drop it from any of them.
        const agentSetSection = updatedPrompt.slice(updatedPrompt.indexOf(AGENT_SET_MARKER), updatedPrompt.indexOf(ROUTING_MARKER));
        expect(agentSetSection).toContain('security-edge-case-analyzer');
        const routingSection = updatedPrompt.slice(updatedPrompt.indexOf(ROUTING_MARKER), updatedPrompt.indexOf(SCOPED_PAYLOAD_MARKER));
        expect(routingSection).toContain('`security-edge-case-analyzer`');
        const scopedSection = updatedPrompt.slice(updatedPrompt.indexOf(SCOPED_PAYLOAD_MARKER));
        expect(scopedSection).toContain('`security-edge-case-analyzer`');
        // Agent 3's own dispatch text is narrowed to BC-only, consistent with what
        // its sub-agent file was just trimmed to.
        expect(updatedPrompt).toContain('Focus areas: Business Central platform security');

        const updatedAgent = readFileSync(agentPath, 'utf-8');
        expect(updatedAgent).not.toContain('SQL injection');
        expect(updatedAgent).toContain('### 1. Business Central Platform Security');
      } finally {
        if (savedSet === undefined) delete process.env['PR_REVIEW_AGENT_SET']; else process.env['PR_REVIEW_AGENT_SET'] = savedSet;
        if (savedRouting === undefined) delete process.env['PR_REVIEW_AGENT_ROUTING']; else process.env['PR_REVIEW_AGENT_ROUTING'] = savedRouting;
        if (savedScoped === undefined) delete process.env['PR_REVIEW_SCOPED_PAYLOAD']; else process.env['PR_REVIEW_SCOPED_PAYLOAD'] = savedScoped;
      }
    });
  });
});

describe('SUBAGENT_TOOL_RULE', () => {
  test('routes toward tools rather than forbidding Bash', () => {
    // Negative framing is measured to backfire on this codebase: telling an
    // agent what NOT to do suppresses the tool entirely instead of redirecting.
    expect(SUBAGENT_TOOL_RULE).not.toMatch(/\bNEVER\b|\bDo NOT\b|\bdon't use\b/i);
  });

  test('names specific LSP operations, not just "use LSP"', () => {
    // Four of the seven sub-agents already mention LSP once, in passing — and
    // made zero LSP calls. A bare mention is not steering.
    for (const op of ['goToDefinition', 'findReferences', 'hover', 'documentSymbol', 'incomingCalls']) {
      expect(SUBAGENT_TOOL_RULE).toContain(op);
    }
  });

  test('gives the cost reason, which is the persuasive part', () => {
    expect(SUBAGENT_TOOL_RULE).toContain('stays in your context');
  });

  test('points Read at partial reads — the exact sed use it replaces', () => {
    expect(SUBAGENT_TOOL_RULE).toContain('`Read` with `offset`/`limit`');
  });
});

// ---------------------------------------------------------------------------
// applyInlineFindings
//
// Posts Critical/Major findings as line-anchored threads after the agent has
// already posted its summary comment. Every ADO call is individually guarded
// — an inline failure must never fail the review.
// ---------------------------------------------------------------------------

const config = {
  azureDevOps: { orgUrl: 'https://dev.azure.com/o', project: 'p', repositoryId: 'r', pat: 'x' },
} as any;

describe('applyInlineFindings', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test('returns zeroes and makes no calls when findingsList is empty', async () => {
    const spy = mock(() => Promise.resolve(new Response('{}', { status: 200 })));
    globalThis.fetch = spy as unknown as typeof fetch;
    const r = await applyInlineFindings(1, [], config);
    expect(r).toEqual({ created: 0, updated: 0, stale: 0, failed: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  test('a rejected inline post is counted, not thrown', async () => {
    // Branch on METHOD, not URL: fetchReviewThreadsRaw (GET) and postInlineThread (POST)
    // hit the SAME url. Branching on the path alone hands the POST a 200 and the
    // test then passes against a correct implementation while proving nothing.
    globalThis.fetch = mock((_u: string, init?: any) =>
      (init?.method ?? 'GET') === 'GET'
        ? Promise.resolve(new Response('{"value":[]}', { status: 200 }))
        : Promise.resolve(new Response('bad request', { status: 400 })),
    ) as unknown as typeof fetch;

    const findings = [{ severity: 'critical', title: 'X', file: 'A.al', line: 3, body: 'b' }] as any;
    const r = await applyInlineFindings(1, findings, config);
    expect(r.failed).toBeGreaterThan(0); // did not throw
  });

  test('posts nothing when PR_REVIEW_NO_POST is set', async () => {
    const spy = mock(() => Promise.resolve(new Response('{"value":[]}', { status: 200 })));
    globalThis.fetch = spy as unknown as typeof fetch;
    process.env['PR_REVIEW_NO_POST'] = '1';
    try {
      // Call the same guarded expression reviewPR uses.
      const noPost = process.env['PR_REVIEW_NO_POST'] === '1';
      const findings = [{ severity: 'critical', title: 'X', file: 'A.al', line: 3, body: 'b' }] as any;
      if (!noPost) await applyInlineFindings(1, findings, config);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      delete process.env['PR_REVIEW_NO_POST'];
    }
  });

  test('applyInlineFindings itself makes no fetch call when PR_REVIEW_NO_POST is set — the internal guard, called directly rather than through the call-site guard', async () => {
    // Unlike the test above, this calls applyInlineFindings unconditionally — it
    // must refuse on its own. The call site is guarded today, but the function is
    // exported and an upcoming A/B harness calls it directly across many arms; a
    // caller that forgets the site guard must still be unable to write to a live PR.
    const spy = mock(() => Promise.resolve(new Response('{"value":[]}', { status: 200 })));
    globalThis.fetch = spy as unknown as typeof fetch;
    process.env['PR_REVIEW_NO_POST'] = '1';
    try {
      const findings = [{ severity: 'critical', title: 'X', file: 'A.al', line: 3, body: 'b' }] as any;
      const r = await applyInlineFindings(1, findings, config);
      expect(r).toEqual({ created: 0, updated: 0, stale: 0, failed: 0 });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      delete process.env['PR_REVIEW_NO_POST'];
    }
  });

  // Discrimination tests: each of the three reconcileFindings action kinds must
  // reach its OWN writer. All three writers take similar arguments and hit
  // similar (sometimes identical) URLs, so a mis-wire (e.g. 'update' calling
  // postInlineThread instead of updateThreadComment) would not throw — it would
  // silently post to the wrong endpoint. Each test asserts both which endpoint
  // WAS hit and that the other endpoints were NOT.

  test('a new critical finding creates a thread via postInlineThread (POST to the bare threads endpoint)', async () => {
    const calls: { method: string; url: string; body: any }[] = [];
    globalThis.fetch = mock((u: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return Promise.resolve(new Response('{"value":[]}', { status: 200 }));
      calls.push({ method, url: u, body: init.body ? JSON.parse(init.body) : undefined });
      return Promise.resolve(new Response('{"id":1}', { status: 200 }));
    }) as unknown as typeof fetch;

    const findings = [{ severity: 'critical', title: 'Boom', file: 'A.al', line: 5, body: 'it breaks' }] as any;
    const r = await applyInlineFindings(1, findings, config);

    expect(r).toEqual({ created: 1, updated: 0, stale: 0, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/pullrequests/1/threads?api-version=7.0');
    expect(calls[0]!.url).not.toMatch(/threads\/\d+/); // not the reply/update sub-resource
    const key = findingKey('A.al', 'Boom');
    expect(calls[0]!.body.comments[0].content).toContain(markerFor(key));
    expect(calls[0]!.body.comments[0].content).toContain('🔴 Critical');
    expect(calls[0]!.body.threadContext.filePath).toBe('/A.al');
    expect(calls[0]!.body.threadContext.rightFileStart.line).toBe(5);
  });

  test('a re-raised finding with an existing marker thread PATCHes via updateThreadComment, never creates', async () => {
    const key = findingKey('A.al', 'Boom');
    const calls: { method: string; url: string; body: any }[] = [];
    globalThis.fetch = mock((u: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return Promise.resolve(new Response(JSON.stringify({
          value: [{
            id: 7,
            comments: [{ id: 30, content: `${markerFor(key)}\nold`, commentType: 'text' }],
            threadContext: { filePath: '/A.al', rightFileStart: { line: 5 } },
          }],
        }), { status: 200 }));
      }
      calls.push({ method, url: u, body: init.body ? JSON.parse(init.body) : undefined });
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    const findings = [{ severity: 'critical', title: 'Boom', file: 'A.al', line: 5, body: 'still breaks' }] as any;
    const r = await applyInlineFindings(1, findings, config);

    expect(r).toEqual({ created: 0, updated: 1, stale: 0, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toContain('/pullrequests/1/threads/7/comments/30?api-version=7.0');
    expect(calls[0]!.body.content).toContain(markerFor(key));
    expect(calls[0]!.body.content).toContain('still breaks');
  });

  test('a finding that stopped being raised appends a stale notice via appendToThread, never PATCHes or creates', async () => {
    const key = findingKey('A.al', 'Gone');
    const calls: { method: string; url: string; body: any }[] = [];
    globalThis.fetch = mock((u: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return Promise.resolve(new Response(JSON.stringify({
          value: [{
            id: 9,
            comments: [{ id: 90, content: `${markerFor(key)}\nold`, commentType: 'text' }],
            threadContext: { filePath: '/A.al', rightFileStart: { line: 5 } },
          }],
        }), { status: 200 }));
      }
      calls.push({ method, url: u, body: init.body ? JSON.parse(init.body) : undefined });
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    // findings must be non-empty — an EMPTY findings array hits the early-return
    // guard (Step 1's first test) before threads are even fetched. This finding
    // has no `file`, so it is ineligible for create/update and excluded from the
    // "still detected" set — it exists purely to keep the array non-empty.
    const findings = [{ severity: 'critical', title: 'Unrelated, locationless', body: 'x' }] as any;
    const r = await applyInlineFindings(1, findings, config, { today: '2026-07-29' });

    expect(r).toEqual({ created: 0, updated: 0, stale: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/pullrequests/1/threads/9/comments?api-version=7.0');
    expect(calls[0]!.url).not.toContain('/threads?api-version=7.0'); // not the create endpoint
    expect(calls[0]!.body.content).toBe('_Not detected in review of 2026-07-29._');
    expect(calls[0]!.body.status).toBeUndefined(); // never closes the thread
  });

  test('suppressStale: true reaches reconcileFindings — no stale notice is appended, even though the finding above would trigger one', async () => {
    // Pins the FORWARDING, not just reconcileFindings' own behaviour (already
    // pinned in tests/sdk/ado/reconcile-findings.test.ts): a correct
    // reconcileFindings wired to an applyInlineFindings that forgets to pass
    // opts.suppressStale through is the failure that actually matters here.
    const key = findingKey('A.al', 'Gone');
    const calls: { method: string; url: string }[] = [];
    globalThis.fetch = mock((u: string, init?: any) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET') {
        return Promise.resolve(new Response(JSON.stringify({
          value: [{
            id: 9,
            comments: [{ id: 90, content: `${markerFor(key)}\nold`, commentType: 'text' }],
            threadContext: { filePath: '/A.al', rightFileStart: { line: 5 } },
          }],
        }), { status: 200 }));
      }
      calls.push({ method, url: u });
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;

    const findings = [{ severity: 'critical', title: 'Unrelated, locationless', body: 'x' }] as any;
    const r = await applyInlineFindings(1, findings, config, { today: '2026-07-29', suppressStale: true });

    expect(r).toEqual({ created: 0, updated: 0, stale: 0, failed: 0 });
    expect(calls).toHaveLength(0); // no write of any kind — nothing to create/update, stale suppressed
  });
});

// ---------------------------------------------------------------------------
// buildPriorFindingsBlock
//
// The lookup the whole reconciliation rests on. Sub-agents regenerate their
// findings from scratch every run, so unless the orchestrator is SHOWN the
// previous file+title pairs it has nothing to be stable against, and every
// re-review forks each thread while this suite stays green — every other test
// here hand-constructs its titles and so cannot detect drift.
// ---------------------------------------------------------------------------

function markerThread(over: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 1,
    firstCommentId: 1,
    lastCommentIsStaleNotice: false,
    rawContent: '',
    filePath: '/A.al',
    line: 3,
    ...over,
  };
}

/** The shape `buildCommentBody` renders — see the round-trip test for the real thing. */
function bodyFor(key: string, severity: string, title: string, body = 'why it matters'): string {
  return `${markerFor(key)}\n\n**${severity}** — ${title}\n\n${body}`;
}

function rowFor(block: string, filePrefix: string): string | undefined {
  return block.split('\n').find((l) => l.startsWith(`| ${filePrefix}`));
}

describe('buildPriorFindingsBlock', () => {
  test('lists prior findings so a re-review can reuse their titles', () => {
    const key = findingKey('A.al', 'Missing timeout');
    const block = buildPriorFindingsBlock([
      markerThread({ rawContent: bodyFor(key, '🔴 Critical', 'Missing timeout') }),
    ]);
    expect(block).toContain('Missing timeout');
    expect(block).toContain('A.al');
    expect(block).toContain('| File | Title |');
  });

  test('is empty when the PR has no prior inline findings', () => {
    expect(buildPriorFindingsBlock([])).toBe('');
  });

  test('the file and title it prints hash back to the thread\'s own key', () => {
    // The whole point of the block: what the model copies out of the table must
    // produce the SAME findingKey as the marker on the thread it should update.
    // ADO stores the anchor as `/App/...` while the model reports `App/...`, so
    // a block that passes the leading slash through would hand the model a path
    // that hashes to a different key — a duplicate thread on every re-review,
    // with the containment assertions above still green.
    const file = 'App/Cloud/Al/Codeunits/X.Codeunit.al';
    const key = findingKey(file, 'Missing HTTP timeout');
    const block = buildPriorFindingsBlock([
      markerThread({ filePath: `/${file}`, rawContent: bodyFor(key, '🟠 Major', 'Missing HTTP timeout') }),
    ]);

    const row = rowFor(block, 'App/');
    expect(row).toBeDefined();
    const [, printedFile, printedTitle] = row!.split('|').map((c) => c.trim());
    expect(findingKey(printedFile!, printedTitle!)).toBe(key);
  });

  test('parses a body written by the real inline renderer, not an approximation', async () => {
    // `buildCommentBody` is private, so reach it the way production does: post a
    // finding, capture the exact bytes ADO stores, and feed those back in. If
    // either side of that format drifts independently the parser silently stops
    // emitting rows — titles fork again and no hand-built fixture would notice.
    const realFetch = globalThis.fetch;
    let posted = '';
    globalThis.fetch = mock((_u: string, init?: any) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return Promise.resolve(new Response('{"value":[]}', { status: 200 }));
      }
      posted = JSON.parse(init.body).comments[0].content;
      return Promise.resolve(new Response('{"id":1}', { status: 200 }));
    }) as unknown as typeof fetch;

    try {
      const file = 'App/Cloud/Al/Codeunits/X.Codeunit.al';
      const findings = [{ severity: 'critical', title: 'HttpClient has no timeout', file, line: 12, body: 'b' }] as any;
      const r = await applyInlineFindings(1, findings, config);
      expect(r.created).toBe(1);
      expect(posted).not.toBe('');

      const block = buildPriorFindingsBlock([markerThread({ filePath: `/${file}`, rawContent: posted })]);
      expect(block).toContain(`| ${file} | HttpClient has no timeout |`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('a human thread carries no marker and never reaches the table', () => {
    const block = buildPriorFindingsBlock([
      markerThread({ rawContent: 'Please rename this to something clearer.' }),
    ]);
    expect(block).toBe('');
  });

  test('keeps the marker thread and drops the human one when both are present', () => {
    const key = findingKey('A.al', 'Missing timeout');
    const block = buildPriorFindingsBlock([
      markerThread({ id: 1, rawContent: 'By design — see the linked ticket.' }),
      markerThread({ id: 2, rawContent: bodyFor(key, '🔴 Critical', 'Missing timeout') }),
    ]);
    expect(block).toContain('Missing timeout');
    expect(block).not.toContain('By design');
    expect(block.split('\n').filter((l) => l.startsWith('| A.al')).length).toBe(1);
  });

  test('a marker thread with no severity line yields no row and does not throw', () => {
    const key = findingKey('A.al', 'Whatever');
    expect(buildPriorFindingsBlock([
      markerThread({ rawContent: `${markerFor(key)}\n\nsomeone reflowed this by hand\n\nbody` }),
    ])).toBe('');
    // Marker and nothing else — the body was deleted in the ADO web UI.
    expect(buildPriorFindingsBlock([markerThread({ rawContent: markerFor(key) })])).toBe('');
  });

  test('only the first line after the marker can be the title', () => {
    // A parser that scanned the whole body would lift this severity-shaped line
    // out of the prose and emit a garbage row the model is then told to reuse.
    const key = findingKey('A.al', 'x');
    expect(buildPriorFindingsBlock([
      markerThread({
        rawContent: `${markerFor(key)}\n\nsomeone replaced the heading with prose\n\n**🔴 Critical** — quoted from an earlier review\n`,
      }),
    ])).toBe('');
  });

  test('a bold em-dash line that is not a severity line is not taken for the title', () => {
    // Dropping the Critical/Major requirement from the parser would lift `a
    // hand-written reply` here — the row would look plausible and be wrong.
    const key = findingKey('A.al', 'x');
    expect(buildPriorFindingsBlock([
      markerThread({ rawContent: `${markerFor(key)}\n\n**Note** — a hand-written reply\n` }),
    ])).toBe('');
  });

  test('an unanchored marker thread is skipped', () => {
    // The orchestrator reads existing PR comments in Phase 2; if it ever echoes a
    // marker into the summary it posts, that thread has no filePath and no path
    // for the model to reuse. Same guard reconcileFindings applies.
    const key = findingKey('A.al', 'Missing timeout');
    expect(buildPriorFindingsBlock([
      markerThread({ filePath: undefined, rawContent: bodyFor(key, '🔴 Critical', 'Missing timeout') }),
    ])).toBe('');
  });

  test('a CRLF body still yields a clean title', () => {
    // ADO round-trips comment bodies through JSON and can hand back CRLF. A
    // parser that splits on \n alone leaves a trailing \r glued to the title,
    // which changes nothing about the key but prints a broken table row.
    const key = findingKey('A.al', 'Missing timeout');
    const block = buildPriorFindingsBlock([
      markerThread({ rawContent: bodyFor(key, '🔴 Critical', 'Missing timeout').replace(/\n/g, '\r\n') }),
    ]);
    expect(block).toContain('| A.al | Missing timeout |');
    expect(block).not.toContain('\r');
  });

  test('a pipe in a title is escaped, and escaping cannot fork the key', () => {
    const title = 'Error() | ErrorInfo() mismatch';
    const key = findingKey('A.al', title);
    const block = buildPriorFindingsBlock([markerThread({ rawContent: bodyFor(key, '🟠 Major', title) })]);

    expect(rowFor(block, 'A.al')).toBe('| A.al | Error() \\| ErrorInfo() mismatch |');
    // Safe because findingKey collapses every non-alphanumeric run to one space:
    // the escaped form the model copies back normalises to the same key.
    expect(findingKey('A.al', 'Error() \\| ErrorInfo() mismatch')).toBe(key);
  });

  test('escaping a pipe is idempotent — a title copied back already escaped does not accrete a second backslash', () => {
    // The re-review cycle this guards against: the model copies a title verbatim
    // out of a previous prior-findings row, which already contains `\|`. A naive
    // `replace(/\|/g, '\\|')` would then escape the pipe a second time on top of
    // the existing backslash — one extra backslash per re-review, unbounded on a
    // long-lived PR.
    const alreadyEscaped = 'Error() \\| ErrorInfo() mismatch'; // one backslash, as printed by a prior row
    const key = findingKey('A.al', alreadyEscaped);
    const block = buildPriorFindingsBlock([markerThread({ rawContent: bodyFor(key, '🟠 Major', alreadyEscaped) })]);
    expect(rowFor(block, 'A.al')).toBe('| A.al | Error() \\| ErrorInfo() mismatch |');
  });

  test('a file reported with a leading slash prints the spelling that hashes back', () => {
    // `findingKey` applies no slash normalisation, and `postInlineThread` tolerates
    // a leading slash — so the key on this thread may have been built from
    // '/App/…'. ADO stores the anchor with a leading slash either way, so the
    // thread alone does not say which spelling was hashed. Stripping it
    // unconditionally prints a pair that names a DIFFERENT identity than the
    // thread it sits on: the model reuses the row verbatim, reconcileFindings
    // matches nothing, and the re-review both creates a duplicate and drops a
    // false "not detected" reply on the original.
    const reported = '/App/Cloud/Al/Codeunits/X.Codeunit.al';
    const key = findingKey(reported, 'Missing timeout');
    const block = buildPriorFindingsBlock([
      markerThread({ filePath: reported, rawContent: bodyFor(key, '🔴 Critical', 'Missing timeout') }),
    ]);

    const row = block.split('\n').find((l) => l.includes('Missing timeout'));
    expect(row).toBeDefined();
    const [, printedFile, printedTitle] = row!.split('|').map((c) => c.trim());
    expect(findingKey(printedFile!, printedTitle!)).toBe(key);
  });

  test('a title that spans lines never prints a truncated pair', () => {
    // `PRFinding.title` is a bare z.string(), so a newline is reachable. findingKey
    // normalises it to a space; parseFindingTitle only ever sees the first line.
    const title = 'Missing timeout\nin the document sender';
    const key = findingKey('A.al', title);
    const block = buildPriorFindingsBlock([
      markerThread({ rawContent: bodyFor(key, '🔴 Critical', title) }),
    ]);

    // This is the row an unguarded strip prints. It hashes to a different identity
    // than the thread it names, so the model would reuse it and still fork.
    expect(block).not.toContain('| A.al | Missing timeout |');
    // Asserting the invariant rather than `toBe('')`: a parser that recovered the
    // whole title would print a row that DOES reproduce the key, and that is a
    // better outcome this test should not forbid.
    for (const row of block.split('\n').filter((l) => l.startsWith('| A.al'))) {
      const [, file, printedTitle] = row.split('|').map((c) => c.trim());
      expect(findingKey(file!, printedTitle!)).toBe(key);
    }
  });

  test('a hand-edited body whose title no longer matches its marker is dropped and logged', () => {
    // Someone reworded the comment in the ADO web UI, so no parse can recover the
    // title the key was built from. The row must be withheld — and visibly: Task 8
    // measures duplicate threads on a live re-review, and a silent drop makes a
    // duplicate unattributable between "the model reworded" and "the table withheld
    // the row it was supposed to reuse".
    const key = findingKey('A.al', 'Missing timeout');
    const logs: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    try {
      expect(buildPriorFindingsBlock([
        markerThread({ id: 42, rawContent: bodyFor(key, '🔴 Critical', 'Reworded by a reviewer') }),
      ])).toBe('');
    } finally {
      console.log = realLog;
    }
    expect(logs.join('\n')).toContain('42');
  });

  test('two threads sharing a key print one row', () => {
    const key = findingKey('A.al', 'Missing timeout');
    const block = buildPriorFindingsBlock([
      markerThread({ id: 1, rawContent: bodyFor(key, '🔴 Critical', 'Missing timeout') }),
      markerThread({ id: 2, rawContent: bodyFor(key, '🟠 Major', 'Missing timeout') }),
    ]);
    expect(block.split('\n').filter((l) => l.startsWith('| A.al')).length).toBe(1);
  });

  test('states the consequence of rewording rather than forbidding it', () => {
    // Prohibition wording is measured on this codebase to suppress the behaviour
    // outright instead of redirecting it.
    const key = findingKey('A.al', 'Missing timeout');
    const block = buildPriorFindingsBlock([
      markerThread({ rawContent: bodyFor(key, '🔴 Critical', 'Missing timeout') }),
    ]);
    expect(block).not.toMatch(/\bnever\b|\bdo not\b|\bdon't\b|\bavoid\b/i);
    expect(block).toContain('reuse');
  });
});

describe('reviewPR call site — the prior-findings block reaches the agent', () => {
  // The block is worthless if it is computed and dropped, and exercising reviewPR()
  // would need the full agent + DB stack — so pin the wiring in the real source.
  const src = readFileSync(fileURLToPath(new URL('../../src/cli/review-pr.ts', import.meta.url)), 'utf-8');

  test('the block is built from a pre-agent thread read', () => {
    expect(src).toMatch(/priorFindingsBlock\s*=\s*buildPriorFindingsBlock\(\s*await fetchReviewThreadsRaw\(prId, config\)\s*\)/);
  });

  test('the read happens before the agent runs, not after', () => {
    // `runPRReview` is now wrapped in a `runFullReview` closure so the sanity path can
    // fall back to it; the closure is DEFINED before the read but INVOKED after, so
    // anchor on the definition — that is where the argument list, and therefore the
    // block, is actually captured.
    const readAt = src.indexOf('priorFindingsBlock = buildPriorFindingsBlock(');
    const defAt = src.indexOf('const runFullReview = () => runPRReview(');
    expect(readAt).toBeGreaterThan(-1);
    expect(defAt).toBeGreaterThan(-1);
    // Both call sites go through the closure, so no invocation can precede the read.
    const invocations = src.match(/runFullReview\(\)/g) ?? [];
    expect(invocations.length).toBeGreaterThanOrEqual(2);
    for (const m of src.matchAll(/runFullReview\(\)/g)) {
      expect(m.index!).toBeGreaterThan(readAt);
    }
  });

  test('the block is passed into the full review', () => {
    const call = src.match(/const runFullReview = \(\) => runPRReview\(\s*\{([\s\S]*?)\},/);
    expect(call).not.toBeNull();
    expect(call![1]).toContain('priorFindingsBlock');
    // Exactly one runPRReview call site: two would let the fallback path drift from
    // the primary one, which is the whole reason it was extracted.
    expect((src.match(/runPRReview\(/g) ?? []).length).toBe(1);
  });

  test('the block also reaches runBackportReview — the sanity path forks threads too without it', () => {
    // Task 7 flagged this and Task 8 correctly declined to expand its own scope;
    // it belongs here because this task is about inline-thread identity. Without
    // it, every re-review of a backport opens a duplicate thread instead of
    // updating the one Task 8's sanity review already posted.
    const call = src.match(/await runBackportReview\(\s*\{([\s\S]*?)\},\s*\n\s*config,/);
    expect(call).not.toBeNull();
    expect(call![1]).toContain('priorFindingsBlock');
  });

  test('the read happens before runBackportReview too', () => {
    const readAt = src.indexOf('priorFindingsBlock = buildPriorFindingsBlock(');
    const runAt = src.indexOf('await runBackportReview(');
    expect(readAt).toBeGreaterThan(-1);
    expect(runAt).toBeGreaterThan(-1);
    expect(readAt).toBeLessThan(runAt);
  });
});

describe('reviewPR call site — inline posting honours PR_REVIEW_NO_POST', () => {
  // The guard is the single most important line in this feature: an A/B runner
  // sets PR_REVIEW_NO_POST on every arm and expects zero side effects. Reading
  // the actual source pins the guard at the REAL call site, since exercising it
  // via reviewPR() would require standing up the full agent + DB stack.
  test('the inline-post call is guarded by `!noPost &&`', () => {
    const src = readFileSync(fileURLToPath(new URL('../../src/cli/review-pr.ts', import.meta.url)), 'utf-8');
    // Allows an optional `inlineThreads = ` capture in front of the call — the
    // counters are persisted to pr_reviews — but still pins the call directly
    // inside the guard body, with nothing else between them.
    expect(src).toMatch(/if\s*\(\s*!noPost\s*&&\s*result\.output\?\.findingsList\?\.length\s*\)\s*\{\s*\n\s*(?:\w+\s*=\s*)?await applyInlineFindings\(/);
  });
});

describe('reviewPR call site — inlineThreads counters actually reach save()', () => {
  // The guard test above only pins that applyInlineFindings is called inside
  // `!noPost && ...` — it deliberately allows an optional capture, so it does
  // NOT catch a future edit that drops just the `inlineThreads = ` assignment
  // while leaving `await applyInlineFindings(...)` for its side effect. That
  // still typechecks (inlineThreads stays declared, always null) and still
  // satisfies the guard regex, but silently defeats this feature's whole
  // point — the counters would always persist as null instead of a measured
  // result. Pin the specific assignment, not just its optional shape.
  const src = readFileSync(fileURLToPath(new URL('../../src/cli/review-pr.ts', import.meta.url)), 'utf-8');

  test('the applyInlineFindings return value is captured into inlineThreads', () => {
    expect(src).toMatch(/inlineThreads\s*=\s*await applyInlineFindings\(/);
  });

  test('the success-branch save() call passes both findingsList and inlineThreads', () => {
    // Isolate the success-branch `prReviewStore.save({...})` object literal —
    // not the catch-block save(), which intentionally always persists null
    // for both fields since nothing was computed before the run errored.
    const saveMatch = src.match(/if \(prReviewStore\) \{\s*\n\s*try \{\s*\n\s*await prReviewStore\.save\(\{([\s\S]*?)\}\);/);
    expect(saveMatch).not.toBeNull();
    const body = saveMatch![1]!;
    expect(body).toContain('findingsList: result.output.findingsList ?? null');
    expect(body).toContain('inlineThreads,');
  });
});

describe('reviewPR call site — the sanity path suppresses stale notices', () => {
  // A sanity review deliberately never examines style/performance/security, so it
  // has no basis to declare a full-review finding "not detected" — reconcileFindings'
  // suppressStale option exists for exactly this, but a call site that forgets to
  // pass it through is the failure that actually matters (the pure-function
  // behaviour alone is pinned in tests/sdk/ado/reconcile-findings.test.ts).
  const src = readFileSync(fileURLToPath(new URL('../../src/cli/review-pr.ts', import.meta.url)), 'utf-8');

  test('the applyInlineFindings call passes suppressStale: true only when route.path is sanity', () => {
    const call = src.match(/inlineThreads = await applyInlineFindings\(prId, result\.output\.findingsList, config, ([^;]*)\);/);
    expect(call).not.toBeNull();
    const optsArg = call![1]!.trim();
    expect(optsArg).toBe(`route.path === 'sanity' ? { suppressStale: true } : {}`);
  });

  test("negative control: the full-path arm of the ternary carries no suppressStale", () => {
    // Guards against a regression that suppresses stale notices unconditionally —
    // which would silently break the invariant that a full review's stale-marking
    // is unchanged. Matched as a whole expression (rather than splitting on ':',
    // which also appears inside the truthy arm's `{ suppressStale: true }`).
    expect(src).toMatch(/route\.path === 'sanity' \? \{ suppressStale: true \} : \{\}/);
    expect(src).not.toMatch(/route\.path === 'sanity' \? \{\} : \{ suppressStale: true \}/);
  });
});

describe('reviewPR routes before spending and records which path ran', () => {
  // Exercising this behaviourally would need the full agent + DB stack (same
  // trade-off already accepted throughout this file), so it is pinned in the
  // real source: the routing decision must precede BOTH agent calls, and the
  // chosen path must be recorded so a cheap review and a failed detection stay
  // distinguishable in `pr_reviews`.
  const src = readFileSync(fileURLToPath(new URL('../../src/cli/review-pr.ts', import.meta.url)), 'utf-8');

  test('reviewPR routes before spending and records which path ran', () => {
    const routeAt = src.indexOf('chooseReviewPath(');
    const fullAt = src.indexOf('runPRReview(');
    const sanityAt = src.indexOf('runBackportReview(');
    expect(routeAt).toBeGreaterThan(-1);
    expect(sanityAt).toBeGreaterThan(-1);
    expect(routeAt).toBeLessThan(fullAt);
    expect(routeAt).toBeLessThan(sanityAt);
    // A cheap review and a failed detection must be distinguishable in the data.
    expect(src).toMatch(/reviewPath:/);
  });

  test('a failed checkout reassigns the route to full rather than proceeding on a broken checkout', () => {
    // Pins the fallback itself, not just its ordering above: on `!checkout.ok`,
    // `route` must be reassigned to the 'full' variant before the second
    // `route.path === 'sanity'` check that decides which agent runs.
    expect(src).toMatch(/if\s*\(!checkout\.ok\)\s*\{[\s\S]*?route\s*=\s*\{\s*path:\s*'full'/);
  });

  test('the five model-echoed fields are overwritten from already-known values after the agent runs', () => {
    // Task 7's carried-forward concern: sourcePrId/sourceReviewStatus/sourceRecommendation/
    // checkoutOk/mergePreviewStale are known to TypeScript before the agent runs, so the
    // model's echo of them must be replaced rather than trusted — a transcription slip is
    // otherwise invisible, and mergePreviewStale alone can flip the verdict.
    const overwriteBlock = src.match(/result = \{\s*\.\.\.backportResult,\s*output: \{([\s\S]*?)\},\s*\};/);
    expect(overwriteBlock).not.toBeNull();
    const body = overwriteBlock![1]!;
    for (const field of ['sourcePrId', 'sourceReviewStatus', 'sourceRecommendation', 'checkoutOk', 'mergePreviewStale']) {
      expect(body).toContain(field);
    }
  });

  test('the sanity branch never calls runPRReview, and the full branch never calls runBackportReview', () => {
    // Discrimination, not just presence: a mis-wire that called the wrong reviewer
    // inside the wrong branch would still satisfy the ordering test above.
    // Plain indexOf slicing rather than one regex spanning the whole dispatch —
    // this file is CRLF in the Windows working tree (`.gitattributes` `text=auto`),
    // and a regex anchored on literal `\n\n` sequences is exactly the kind of thing
    // that passes on a fresh Linux checkout and silently stops matching here.
    //
    // Anchored on `runBackportReview(` — the one thing that is BY DEFINITION inside
    // the sanity dispatch — and walked outward from there.
    //
    // The previous anchor was "the first `} else {` after the first
    // `if (route.path === 'sanity')`", on the reasoning that guards would keep being
    // added above it but the else would stay the dispatch's. That held until a guard
    // grew an else of its OWN: the port-diff fallback became
    // `if (port.ok) { … } else { … }` when `fetchPRDiff` stopped throwing, and the
    // search then sliced out the guard instead of the dispatch. Walking out from the
    // call cannot be fooled that way, however many branches appear above it.
    const backportCallAt = src.indexOf('await runBackportReview(');
    expect(backportCallAt).toBeGreaterThan(-1);
    const dispatchSanityIf = src.lastIndexOf(`if (route.path === 'sanity') {`, backportCallAt);
    expect(dispatchSanityIf).toBeGreaterThan(-1);
    const elseAt = src.indexOf('} else {', backportCallAt);
    expect(elseAt).toBeGreaterThan(dispatchSanityIf);

    const likeliestAt = src.indexOf('// The likeliest way', elseAt);
    expect(likeliestAt).toBeGreaterThan(elseAt);

    const sanityBody = src.slice(dispatchSanityIf, elseAt);
    const fullBody = src.slice(elseAt, likeliestAt);

    expect(sanityBody).toContain('runBackportReview(');
    expect(fullBody).toContain('runFullReview(');
    expect(fullBody).not.toContain('runBackportReview(');

    // The sanity branch MAY reach the full reviewer, but only as a failure fallback:
    // a sanity-agent throw used to leave the PR with no review at all, which is worse
    // than the expensive review this path replaces. So the invariant is no longer
    // "never" — it is "only inside the catch".
    //
    // Assert the position, not merely the presence: on the SUCCESS path the sanity
    // branch must still never call it, or the cost saving is gone.
    const catchAt = sanityBody.indexOf('} catch (err) {');
    expect(catchAt).toBeGreaterThan(-1);
    expect(sanityBody.slice(0, catchAt)).not.toContain('runFullReview(');
    expect(sanityBody.slice(catchAt)).toContain('runFullReview(');
  });

  test('checkoutBranch and resolveRef target the repo subdirectory, not the bare session root', () => {
    // CRITICAL, caught by review: docker/entrypoint.sh clones the repo ONE LEVEL
    // BELOW the session root (MAIN_REPO_DIR="${SESSION_ROOT}/${REPO_KEY}") — the
    // session root itself is never a git repository. Passing it bare to
    // checkoutBranch/resolveRef makes every checkout fail in a container, silently:
    // route falls back to 'full' and the sanity path never runs, looking exactly
    // like the fail-safe working as designed. Pin that both calls go through the
    // joined directory instead.
    expect(src).toMatch(/const repoDir = join\(config\.paths\.sessionRoot, config\.repoKey\)/);
    expect(src).toMatch(/checkoutBranch\(repoDir,/);
    expect(src).toMatch(/resolveRef\(repoDir,/);
    // And the bug's exact shape must not reappear at either call site.
    expect(src).not.toMatch(/checkoutBranch\(config\.paths\.sessionRoot,/);
    expect(src).not.toMatch(/resolveRef\(config\.paths\.sessionRoot,/);
  });

  test('a sanity-agent failure falls back to a full review and records it as a cost signal', () => {
    // Measured: the sanity agent exhausted its turn budget on 1 of 2 runs of the same
    // PR, returned NULL structured output and threw — and the throw left the PR with
    // NO review at all, strictly worse than the expensive review this path replaces.
    //
    // Unlike the checkout and port-diff fallbacks, this one is not free: the sanity
    // attempt has already spent its turns, so falling back pays twice. That makes the
    // fallback RATE something to watch, which is why it must land in `review_path`
    // and not only in a log line nobody queries.
    expect(src).toMatch(/sanity review failed, falling back to the full review/);
    expect(src).toMatch(/reason: `sanity review failed: \$\{why\.slice\(0, 200\)\}`/);
    // Persisted, not just logged.
    expect(src).toMatch(/reviewPath = `full:\$\{route\.reason\}`/);
  });

  test('the checkout is offered lastMergeCommit, so a completed PR still takes the sanity path', () => {
    // Measured on PR 52308: completed PRs here carry
    // `completionOptions.deleteSourceBranch: true`, so the source branch is GONE and
    // the checkout cannot succeed. Without the fallback the sanity path degrades to
    // the full review for every completed PR — fail-safe, and therefore invisible,
    // at ~3x the cost. It also voids any A/B run over historical PRs, since every
    // arm silently takes the fallback and the null result looks like data.
    expect(src).toMatch(/checkoutBranch\(repoDir, effectiveSourceBranch, prMetadata\?\.lastMergeCommit\)/);
    // The two-argument shape is the bug — pin that it does not come back.
    expect(src).not.toMatch(/checkoutBranch\(repoDir, effectiveSourceBranch\)/);
  });

  test('a merge-commit checkout suppresses mergePreviewStale instead of computing it', () => {
    // Second-order trap: for a COMPLETED PR, `lastMergeTargetCommit` is the target
    // tip at merge time, and the merge itself moved the tip past it — so the computed
    // comparison is unconditionally "stale". That flag flips the verdict on its own
    // (review-pr.ts overwrites the model's echo of it), so leaving it computed makes
    // every completed-PR review return the same verdict: uniform, and worthless both
    // as a signal and as A/B data.
    expect(src).toMatch(/const mergePreviewStale = reviewedMergeCommit\s*\?\s*false/);
    // The suppression must be driven by the checkout result, not assumed.
    expect(src).toMatch(/reviewedMergeCommit = true/);
  });

  test('a failed port-diff fetch falls back to full rather than aborting the review', () => {
    // Important, caught by review: the source-diff fetch 80 lines above is
    // guarded, but the port's OWN diff fetch was not — a transient failure there
    // used to throw into the outer catch, saving an error row and giving the PR no
    // review at all (worse than before this feature existed, which always ran the
    // full review). No agent has run at this point, so falling back is still free
    // — same invariant as the checkout fallback above it.
    //
    // `fetchPRDiff` now returns a result instead of throwing, so the guard is an
    // `if (!port.ok)` rather than a catch. The fallback it protects is unchanged
    // and is what this pins.
    const guardMatch = src.match(/let portDiff: FileDiff\[\] = \[\];\s*\n\s*if \(route\.path === 'sanity'\) \{([\s\S]*?)\n\s{4}\}/);
    expect(guardMatch).not.toBeNull();
    const [, body] = guardMatch!;
    // The clone directory is required — a diff is computed with git now, not fetched.
    expect(body).toContain('fetchPRDiff(prId, repoDir, config)');
    expect(body).toMatch(/route = \{ path: 'full', reason:/);
    expect(body).toMatch(/reviewPath = `full:/);
  });

  test('an empty PORT diff falls back to full, symmetrically with the source side', () => {
    // The source side already refuses to route `sanity` on an empty diff
    // (`sourceDiffFetchable: sourceDiff.length > 0`), but the port side did not.
    // An empty port diff compares cleanly and reports EVERY source file as
    // `missingFromPort` — the safe direction, but it dresses a computation failure
    // up as a damning finding about the port, which is worse than saying nothing.
    const guardMatch = src.match(/let portDiff: FileDiff\[\] = \[\];\s*\n\s*if \(route\.path === 'sanity'\) \{([\s\S]*?)\n\s{4}\}/);
    expect(guardMatch).not.toBeNull();
    const [, body] = guardMatch!;
    expect(body).toMatch(/port\.ok && port\.files\.length === 0/);
    expect(body).toMatch(/reason: 'port PR changed no comparable files'/);
  });

  test('the source-diff failure distinguishes a missing PR from an uncomputable diff', () => {
    // The CRITICAL that hid a dead endpoint for this feature's whole lifetime:
    // `sourcePrExists` was set only inside the success branch, so EVERY failure —
    // 404, 500, auth, network, a URL that does not exist — reported
    // "source PR !<id> not found in this repository" and persisted that
    // unfalsifiable sentence into `review_path`. Only an ADO 404 may say that now.
    expect(src).toMatch(/sourcePrExists = !source\.prMissing/);
    expect(src).toMatch(/sourceDiffError = source\.error/);
    // And the reason reaches the router, so `review_path` carries the real cause.
    expect(src).toMatch(/sourceDiffError,/);
    // The old shape must not come back: a bare `sourcePrExists = true` right after
    // an unguarded fetch is exactly what made every failure look like absence.
    expect(src).not.toMatch(/sourceDiff = await fetchPRDiff\(/);
  });

  test('repoDir is declared before the first diff read, not just before the checkout', () => {
    // A diff is now computed with `git diff` inside the clone, so `repoDir` has to
    // exist by the time the SOURCE diff is read — which happens well above the
    // checkout it was originally declared for. Declared too late, this is a
    // use-before-declaration TypeScript catches; pinned here so a later reshuffle
    // that moves it back down is caught as the ordering decision it is.
    const repoDirAt = src.indexOf('const repoDir = join(config.paths.sessionRoot, config.repoKey)');
    const sourceFetchAt = src.indexOf('await fetchPRDiff(cherryPick.originalPrId, repoDir, config)');
    expect(repoDirAt).toBeGreaterThan(-1);
    expect(sourceFetchAt).toBeGreaterThan(-1);
    expect(repoDirAt).toBeLessThan(sourceFetchAt);
  });

  test("a mismatch between the model's echo and the computed mergePreviewStale/checkoutOk is logged, not just silently overwritten", () => {
    // Important, caught by review: the overwrite deletes the evidence that the
    // model misread the inverted "Merge preview current" prompt line unless a
    // mismatch is logged BEFORE the overwrite happens. The artifacts a mis-echo
    // corrupts (the posted comment, recommendation, reviewBody) are produced
    // during the run and cannot be fixed after the fact — a log line is the only
    // thing that would ever surface this to a human.
    // `...backportResult,` alone (not a multi-line literal spanning the `result = {`
    // opener) so this survives the file's CRLF line endings unchanged.
    const overwriteAt = src.indexOf('...backportResult,');
    expect(overwriteAt).toBeGreaterThan(-1);
    const beforeOverwrite = src.slice(0, overwriteAt);
    expect(beforeOverwrite).toMatch(/backportResult\.output\.mergePreviewStale !== mergePreviewStale/);
    expect(beforeOverwrite).toMatch(/backportResult\.output\.checkoutOk !== true/);
    expect(beforeOverwrite).toMatch(/console\.warn/);
  });

  test('the backport params repoKey is the folder name, not the registry key the save() calls persist', () => {
    // Caught alongside the CRITICAL directory fix: `params.repoKey` is now named
    // literally as the checkout subdirectory in cherry-pick-reviewer's prompt, so
    // it must be `config.repoKey` (the folder name `repoDir` is also built from),
    // not `repo.key` (the registry key `save()` persists as `repo_key`).
    const paramsMatch = src.match(/const backportResult = await runBackportReview\(\s*\{([\s\S]*?)\},\s*\n\s*config,/);
    expect(paramsMatch).not.toBeNull();
    expect(paramsMatch![1]).toMatch(/repoKey:\s*config\.repoKey/);
  });
});

describe('reviewPR resolves the PR title rather than always storing the fallback', () => {
  // action-processor.ts forwards no --pr-title, so on the watcher path prTitle is
  // always empty and this fallback used to be the ONLY value ever stored — pinned
  // here in the real source, since exercising reviewPR() would need the full
  // agent + DB stack (same reasoning as the call-site tests above).
  const src = readFileSync(fileURLToPath(new URL('../../src/cli/review-pr.ts', import.meta.url)), 'utf-8');

  test('reviewPR resolves the PR title rather than always storing the fallback', () => {
    // The fallback must remain as a fallback, not as the only value.
    expect(src).toMatch(/title:\s*resolvedTitle\s*\|\|\s*`PR #\$\{prId\}`/);
    expect(src).toMatch(/prTitle:\s*resolvedTitle/);

    // Both prReviewStore.save() call sites persist a `title` — the success path
    // and the catch block (used when the run errors before completing).
    // resolvedTitle is in scope at both, and a debugger looking at a failed
    // review deserves the real title too, not `PR #123` next to a sibling row
    // that has it. Asserting a count (rather than just the single `toMatch`
    // above, which is satisfied by one occurrence) is what actually catches a
    // regression at either site.
    const occurrences = src.match(/title:\s*resolvedTitle\s*\|\|\s*`PR #\$\{prId\}`/g) ?? [];
    expect(occurrences).toHaveLength(2);
    // And no bare fallback-only spelling should remain anywhere.
    expect(src).not.toMatch(/title:\s*`PR #\$\{prId\}`,/);
  });
});

// ---------------------------------------------------------------------------
// parseReviewPrArgs — the CLI-flag end of the /review-full escape hatch.
//
// `--full` is the automated-caller half (eval harness, scripts); `/review-full`
// (webhook-server/parse.ts) is the human half. Both must independently be able
// to force `chooseReviewPath`'s full path, since a PR comment cannot serve an
// automated caller and vice versa.
// ---------------------------------------------------------------------------

describe('parseReviewPrArgs', () => {
  test('--full sets forceFull true', () => {
    expect(parseReviewPrArgs(['--pr-id', '1', '--repo-id', 'r', '--full']).forceFull).toBe(true);
  });

  test('forceFull defaults to false when --full is absent (the watcher never passes it today)', () => {
    expect(parseReviewPrArgs(['--pr-id', '1', '--repo-id', 'r']).forceFull).toBe(false);
  });

  test('every other flag still parses to the same shape as before the refactor', () => {
    const parsed = parseReviewPrArgs([
      '--pr-id', '5', '--repo-id', 'guid',
      '--source-branch', 'refs/heads/x', '--target-branch', 'refs/heads/y',
      '--pr-url', 'https://example/pr/5',
      '--pr-title', 'Cherry-pick: fix', '--pr-description', 'Cherry-picked from pull request !3',
      '--action-id', '9',
    ]);
    expect(parsed).toEqual({
      prId: 5,
      repoId: 'guid',
      sourceBranch: 'refs/heads/x',
      targetBranch: 'refs/heads/y',
      prUrl: 'https://example/pr/5',
      prTitle: 'Cherry-pick: fix',
      prDescription: 'Cherry-picked from pull request !3',
      actionId: 9,
      forceFull: false,
    });
  });

  test('an empty argv still defaults sourceBranch/targetBranch to empty strings, not undefined', () => {
    const parsed = parseReviewPrArgs([]);
    expect(parsed.sourceBranch).toBe('');
    expect(parsed.targetBranch).toBe('');
    expect(parsed.forceFull).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildReviewBaseConfig — review-pr's config assembly now honours database
// settings. Before this existed, `reviewPR` called `loadConfig(sessionRoot)`
// directly with no settings at all — the only config-assembly path in the
// pipeline that never read the settings table, so a database model/maxTurns
// override silently never reached pr-reviewer or cherry-pick-reviewer.
// ---------------------------------------------------------------------------

function fakeSettingsStore(overrides: Record<string, unknown> = {}): ISettingsStore {
  return {
    async getAll() { return { ...overrides }; },
    async get<T>(key: string) { return (key in overrides ? overrides[key] : null) as T | null; },
    async set() {},
    async delete() {},
  };
}

describe('buildReviewBaseConfig', () => {
  test('a database models.default setting reaches the resolved config', async () => {
    const config = await buildReviewBaseConfig('/tmp/session', fakeSettingsStore({ 'models.default': 'db-model' }));
    expect(config.models.default).toBe('db-model');
  });

  test('the raw settings snapshot is carried through as settingsApplied', async () => {
    const settings = { 'models.perAgent': { coder: 'db-coder-model' } };
    const config = await buildReviewBaseConfig('/tmp/session', fakeSettingsStore(settings));
    expect(config.settingsApplied).toEqual(settings);
  });

  test('omitting the settings store falls back to env/code defaults, matching the pre-fix behaviour', async () => {
    const config = await buildReviewBaseConfig('/tmp/session');
    expect(config.settingsApplied).toEqual({});
  });

  test('a settings-store read failure falls back to {} rather than throwing (review must not fail over a DB outage)', async () => {
    const rejecting: ISettingsStore = {
      async getAll() { throw new Error('settings table unreachable (fake)'); },
      async get<T>() { return null as T | null; },
      async set() {},
      async delete() {},
    };
    const original = console.warn;
    console.warn = () => {};
    try {
      const config = await buildReviewBaseConfig('/tmp/session', rejecting);
      expect(config.settingsApplied).toEqual({});
    } finally {
      console.warn = original;
    }
  });
});

describe('reviewPR forwards --full into chooseReviewPath as forceFull', () => {
  // parseReviewPrArgs' own tests above prove the flag parses correctly; this
  // pins that reviewPR actually uses its result rather than a stray hardcoded
  // value — the exact regression this feature had until this task landed
  // ("Task 10 wires `/review-full` and `--full`; until either exists ... this is
  // always false").
  const src = readFileSync(fileURLToPath(new URL('../../src/cli/review-pr.ts', import.meta.url)), 'utf-8');

  test('forceFull comes from parseReviewPrArgs(args), not a hardcoded false', () => {
    expect(src).toMatch(/const \{[^}]*forceFull[^}]*\} = parseReviewPrArgs\(args\)/);
    expect(src).not.toMatch(/const forceFull = false;/);
  });

  test('forceFull reaches the chooseReviewPath call', () => {
    const callBlock = src.match(/chooseReviewPath\(\{([\s\S]*?)\}\)/);
    expect(callBlock).not.toBeNull();
    expect(callBlock![1]).toMatch(/\bforceFull\b/);
  });
});

// ---------------------------------------------------------------------------
// collectAppliedLevers (task 9) — the record that closes the compliance gap
// on prompt-CONTENT levers (scoped payload, BC-only security). Two of the six
// PR_REVIEW_* env vars ('' vs '1') mean "enabled" for different levers, and
// the container runner supplies ALL SIX to every run, '' for a disabled one —
// so the critical property under test is that a lever's ABSENCE from the
// returned map means "not enabled", never "enabled and recorded a zero".
// ---------------------------------------------------------------------------
describe('collectAppliedLevers', () => {
  const LEVER_ENV_KEYS = [
    'PR_REVIEW_AGENT_SET',
    'PR_REVIEW_AGENT_ROUTING',
    'PR_REVIEW_SCOPED_PAYLOAD',
    'PR_REVIEW_SECURITY_BC_ONLY',
    'PR_REVIEW_SUBAGENT_MODEL',
    'PR_REVIEW_SUBAGENT_TOOL_RULE',
  ] as const;

  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const key of LEVER_ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  });
  afterEach(() => {
    for (const key of LEVER_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });

  const allCounts = { agentSet: 1, routing: 1, scopedPayload: 1, securityBcOnly: 2, subagentModel: 3, subagentToolRule: 7 };

  test('every lever env var unset returns null, not an all-zeros/all-counts map', () => {
    expect(collectAppliedLevers(allCounts)).toBeNull();
  });

  // C2: the runner passes every PR_REVIEW_* var into the container, '' for a
  // disabled lever — this is the exact shape a baseline arm's container sees,
  // and a naive `!== undefined` test would have read every key here as "set".
  test('every lever env var present but blank (container baseline shape) still returns null', () => {
    process.env['PR_REVIEW_AGENT_SET'] = '';
    process.env['PR_REVIEW_AGENT_ROUTING'] = '';
    process.env['PR_REVIEW_SCOPED_PAYLOAD'] = '';
    process.env['PR_REVIEW_SECURITY_BC_ONLY'] = '';
    process.env['PR_REVIEW_SUBAGENT_MODEL'] = '';
    process.env['PR_REVIEW_SUBAGENT_TOOL_RULE'] = '';
    expect(collectAppliedLevers(allCounts)).toBeNull();
  });

  test('PR_REVIEW_AGENT_SET non-blank records only agentSet, passing the count through unchanged', () => {
    process.env['PR_REVIEW_AGENT_SET'] = 'code-review-validator,al-performance-analyzer';
    expect(collectAppliedLevers(allCounts)).toEqual({ agentSet: 1 });
  });

  test('a whitespace-only PR_REVIEW_AGENT_SET is treated as unset, mirroring maybeRestrictAgentSet\'s own predicate', () => {
    process.env['PR_REVIEW_AGENT_SET'] = '   ';
    expect(collectAppliedLevers(allCounts)).toBeNull();
  });

  test('PR_REVIEW_AGENT_ROUTING=1 and PR_REVIEW_SCOPED_PAYLOAD=1 record both, and only those two', () => {
    process.env['PR_REVIEW_AGENT_ROUTING'] = '1';
    process.env['PR_REVIEW_SCOPED_PAYLOAD'] = '1';
    expect(collectAppliedLevers(allCounts)).toEqual({ routing: 1, scopedPayload: 1 });
  });

  test('PR_REVIEW_AGENT_ROUTING="true" (not exactly "1") is not enabled', () => {
    process.env['PR_REVIEW_AGENT_ROUTING'] = 'true';
    expect(collectAppliedLevers(allCounts)).toBeNull();
  });

  test('PR_REVIEW_SECURITY_BC_ONLY=1 records the raw returned count, even a half-applied 1', () => {
    // collectAppliedLevers only gates on whether the lever was enabled — it is
    // not the place that judges whether the count is a valid fully-applied
    // value; that judgment belongs to checkArmCompliance's REQUIRED_LEVER_COUNTS.
    process.env['PR_REVIEW_SECURITY_BC_ONLY'] = '1';
    expect(collectAppliedLevers({ ...allCounts, securityBcOnly: 1 })).toEqual({ securityBcOnly: 1 });
  });

  test('a blank PR_REVIEW_SUBAGENT_MODEL is not enabled, mirroring maybeOverrideSubAgentModel\'s own predicate', () => {
    process.env['PR_REVIEW_SUBAGENT_MODEL'] = '   ';
    expect(collectAppliedLevers(allCounts)).toBeNull();
  });

  test('all six enabled records all six counts', () => {
    for (const key of ['PR_REVIEW_AGENT_ROUTING', 'PR_REVIEW_SCOPED_PAYLOAD', 'PR_REVIEW_SECURITY_BC_ONLY', 'PR_REVIEW_SUBAGENT_TOOL_RULE']) {
      process.env[key] = '1';
    }
    process.env['PR_REVIEW_AGENT_SET'] = 'code-review-validator';
    process.env['PR_REVIEW_SUBAGENT_MODEL'] = 'claude-sonnet-5';
    expect(collectAppliedLevers(allCounts)).toEqual(allCounts);
  });
});

// ---------------------------------------------------------------------------
// reviewPR wires collectAppliedLevers' output into both save() call sites and
// preserves the hooks' original call order (each hook appends to the same
// prompt file, so calling them out of order changes prompt structure even
// though collectAppliedLevers itself only reads return values). No live-DB
// test is possible here (DATABASE_URL is production) — pinned in the source
// text, the same approach the forceFull/chooseReviewPath tests above use.
// ---------------------------------------------------------------------------
describe('reviewPR threads appliedLevers through both save() calls', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/cli/review-pr.ts', import.meta.url)), 'utf-8');

  test('the six hooks are still called in their original order inside the collectAppliedLevers call', () => {
    const callBlock = src.match(/const appliedLevers = collectAppliedLevers\(\{([\s\S]*?)\}\);/);
    expect(callBlock).not.toBeNull();
    const body = callBlock![1]!;
    const order = [
      'maybeOverrideSubAgentModel',
      'maybeInjectToolRule',
      'maybeRestrictAgentSet',
      'maybeInjectRouting',
      'maybeInjectScopedPayload',
      'maybeTrimSecurityDomains',
    ];
    let lastIndex = -1;
    for (const fn of order) {
      const idx = body.indexOf(`${fn}()`);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });

  test('both prReviewStore.save() calls include appliedLevers', () => {
    const saveCalls = src.match(/await prReviewStore\.save\(\{[\s\S]*?\}\);/g) ?? [];
    expect(saveCalls.length).toBe(2);
    for (const call of saveCalls) {
      expect(call).toMatch(/\bappliedLevers\b/);
    }
  });
});

describe('isTestRun', () => {
  withEnv('PR_REVIEW_NO_POST');
  withEnv('PR_REVIEW_TEST_RUN');

  test('neither flag set is not a test run', () => {
    expect(isTestRun()).toBe(false);
  });

  test('PR_REVIEW_NO_POST=1 alone is a test run', () => {
    process.env['PR_REVIEW_NO_POST'] = '1';
    expect(isTestRun()).toBe(true);
  });

  test('PR_REVIEW_TEST_RUN=1 alone is a test run', () => {
    process.env['PR_REVIEW_TEST_RUN'] = '1';
    expect(isTestRun()).toBe(true);
  });

  test('both set is still a test run', () => {
    process.env['PR_REVIEW_NO_POST'] = '1';
    process.env['PR_REVIEW_TEST_RUN'] = '1';
    expect(isTestRun()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guards the fix for a real drift bug: isTest was originally inlined as its own
// `process.env[...] === '1' || process.env[...] === '1'` expression at each
// save() site independently. A single source of truth means a third condition
// added to isTestRun() reaches both call sites automatically — pinned here the
// same way appliedLevers' threading is pinned above, since no live-DB test is
// possible (DATABASE_URL is production).
// ---------------------------------------------------------------------------
describe('reviewPR threads isTest through both save() calls via isTestRun()', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/cli/review-pr.ts', import.meta.url)), 'utf-8');

  test('both prReviewStore.save() calls derive isTest from isTestRun(), not an inlined duplicate', () => {
    const saveCalls = src.match(/await prReviewStore\.save\(\{[\s\S]*?\}\);/g) ?? [];
    expect(saveCalls.length).toBe(2);
    for (const call of saveCalls) {
      expect(call).toMatch(/isTest:\s*isTestRun\(\)/);
    }
  });
});
