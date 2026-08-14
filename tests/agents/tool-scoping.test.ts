import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PipelineConfig } from '../../src/types/pipeline.types.ts';
import { createAnalyzerConfig } from '../../src/agents/analyzer/config.ts';
import { createBackportReviewConfig } from '../../src/agents/cherry-pick-reviewer/config.ts';
import { createCodeReviewerConfig } from '../../src/agents/code-reviewer/config.ts';
import { createCoderConfig } from '../../src/agents/coder/config.ts';
import { createDocsWriterConfig } from '../../src/agents/docs-writer/config.ts';
import { createDocumenterConfig } from '../../src/agents/documenter/config.ts';
import { createDraftPRConfig } from '../../src/agents/draft-pr/config.ts';
import { createPlanReviewerConfig } from '../../src/agents/plan-reviewer/config.ts';
import { createPlannerConfig } from '../../src/agents/planner/config.ts';
import { createPRReviewConfig } from '../../src/agents/pr-reviewer/config.ts';
import { createTestCaseReviewerConfig } from '../../src/agents/test-case-reviewer/config.ts';
import { createTestCasesConfig } from '../../src/agents/test-cases/config.ts';
import {
  ALLOWED_TOOLS as RULE_LEARNER_ALLOWED,
  DISALLOWED_TOOLS as RULE_LEARNER_DISALLOWED,
} from '../../src/agents/rule-learner/config.ts';

// ---------------------------------------------------------------------------
// Why this file exists
//
// `allowedTools` does NOT restrict what an agent can call. The SDK documents it
// as the list auto-approved *without prompting*, and `runAgent`
// (src/sdk/run-agent.ts) passes `permissionMode: 'bypassPermissions'` while
// never passing a `tools:` option — so the claude_code preset's full default
// tool set stays reachable whether or not a tool is named in `allowedTools`.
//
// This pipeline's own telemetry says the same: `pr-reviewer` lists neither
// `Write` nor `Edit`, yet across recorded reviews its orchestrator turn issued
// 125 `Write` calls and 2 `Edit` calls. `analyzer` lists no dispatch tool and
// defines no sub-agents, yet its stage runs called `Agent` 24 times.
//
// `disallowedTools` is the mechanism that actually removes a tool. Measured on
// the same data: the two Bash calls recorded against Bash-denying stages both
// came back `<tool_use_error>Error: No such tool available: Bash. Bash exists
// but is not enabled in this context.` — the model attempted it and the SDK
// refused. (Telemetry counts tool_use *attempts*, not successful executions.)
//
// So these tests pin the principle, not the current text of each config:
// an agent whose declared surface is read-only must DENY the mutating tools
// rather than merely omit them.
// ---------------------------------------------------------------------------

/** Tools that let an agent change files on disk. */
const MUTATING_TOOLS = ['Write', 'Edit', 'NotebookEdit'] as const;

/**
 * Denied alongside MUTATING_TOOLS on read-only agents, on an asymmetry argument
 * rather than a proof.
 *
 * `REPL` executes arbitrary JavaScript with persistent state
 * (`sdk-tools.d.ts` REPLInput). What its sandbox permits is NOT established, and
 * nothing here claims it can write. The point is the payoff matrix: usage is
 * zero (0 across 1483 recorded reviews, 0 of 90,218 recorded stage tool calls),
 * so denying it removes no capability anyone uses — while if it IS a write
 * route, leaving it open silently voids the mutation denial on every read-only
 * agent. Cheap insurance against an unverified risk beats an unverified
 * assurance of safety.
 *
 * Deliberately NOT denied on the writers: they already hold Write/Edit and
 * mostly Bash, so REPL grants them no capability class they lack, and denying it
 * there would be theatre rather than a control.
 */
const READ_ONLY_ONLY_DENIALS = ['REPL'] as const;

function mockPipelineConfig(): PipelineConfig {
  return {
    azureDevOps: {
      organization: 'test', orgUrl: 'https://test', project: 'Test',
      repositoryId: 'r', repositoryName: 'R', ciPipelineId: 1, cdPipelineId: 2,
      areaPath: 'T', iterationPath: 'T', pat: 'p',
    },
    paths: { sessionRoot: '/tmp', targetRepo: '/tmp/repo', stateDir: '/tmp/state' },
    checkpoints: {
      planApproval: { tag: 't', rerunCommand: '/r', timeoutHours: 1 },
      prPublished: { fixCommand: '/f', timeoutHours: 1 },
      pollIntervalMinutes: 1,
    },
    revisionLoops: { maxAttempts: 5 },
    models: { default: 'claude-sonnet-5' },
    costs: {},
    repoKey: 'Repo',
    layout: { appRoot: 'Cloud', source: 'Cloud/Al', testAppRoot: 'Test', test: 'Test/Src' },
  } as unknown as PipelineConfig;
}

const cfg = mockPipelineConfig();

interface AgentSurface {
  name: string;
  allowedTools: string[];
  disallowedTools: string[];
}

/**
 * Every agent the pipeline can run, described by its tool surface.
 *
 * Adding an agent here is deliberately cheap; the invariants below then apply
 * to it automatically. An agent that is NOT listed is not covered — the
 * `covers every agent directory` test makes forgetting one a failure.
 */
function agentSurfaces(): AgentSurface[] {
  const surface = (name: string, c: { allowedTools: string[]; disallowedTools?: string[] }): AgentSurface => ({
    name,
    allowedTools: c.allowedTools,
    disallowedTools: c.disallowedTools ?? [],
  });

  return [
    surface('analyzer', createAnalyzerConfig(cfg)),
    surface('cherry-pick-reviewer', createBackportReviewConfig(cfg, {
      prId: 1, sourcePrId: 2, repoKey: 'k',
      sourceBranch: 'refs/heads/a', targetBranch: 'refs/heads/b',
      diffComparison: '', sourceReviewStatus: 'not-reviewed',
      sourceRecommendation: null, mergePreviewStale: false,
      checkoutOk: true, noPost: true,
    })),
    surface('code-reviewer', createCodeReviewerConfig(cfg)),
    surface('coder', createCoderConfig(cfg)),
    surface('docs-writer', createDocsWriterConfig(cfg)),
    surface('documenter', createDocumenterConfig(cfg)),
    surface('draft-pr', createDraftPRConfig(cfg)),
    surface('plan-reviewer', createPlanReviewerConfig(cfg)),
    surface('planner', createPlannerConfig(cfg)),
    surface('pr-reviewer', createPRReviewConfig(cfg, {
      prId: 1, repoKey: 'k', repoUrl: 'https://x', repositoryId: 'r',
      project: 'p', sourceBranch: 'refs/heads/a', targetBranch: 'refs/heads/b',
      noPost: true,
    })),
    surface('test-case-reviewer', createTestCaseReviewerConfig(cfg)),
    surface('test-cases', createTestCasesConfig(cfg)),
    // rule-learner is not an AgentConfig — it is invoked by src/cli/learn-rules.ts,
    // which calls the SDK's query() directly with the same bypassPermissions mode.
    // It is in scope for exactly the same reason.
    surface('rule-learner', {
      allowedTools: RULE_LEARNER_ALLOWED,
      disallowedTools: RULE_LEARNER_DISALLOWED,
    }),
  ];
}

/** An agent is a writer only if it DECLARES a mutating tool. */
function isWriter(a: AgentSurface): boolean {
  return MUTATING_TOOLS.some(t => a.allowedTools.includes(t));
}

describe('tool scoping — omission is not restriction', () => {
  test('every read-only agent denies all mutating tools', () => {
    // THE invariant. It is derived from each agent's own declared surface, so it
    // keeps holding as agents are added or their tool sets change:
    //  - add a read-only agent and forget disallowedTools  -> fails here
    //  - hand a read-only agent Write via a TOOL_SETS edit  -> it reclassifies as
    //    a writer, which the writer test below then forces someone to justify
    const offenders = agentSurfaces()
      .filter(a => !isWriter(a))
      .flatMap(a => MUTATING_TOOLS
        .filter(t => !a.disallowedTools.includes(t))
        .map(t => `${a.name} does not deny ${t}`));

    expect(offenders).toEqual([]);
  });

  test('every read-only agent also denies REPL', () => {
    // Separate from the mutation invariant because the reason differs: REPL is
    // denied on an asymmetry argument, not because it is known to write. The
    // reason travels in the assertion message so a future reader who wonders why
    // a never-used tool is denied gets the answer from the failure output rather
    // than deleting it. See READ_ONLY_ONLY_DENIALS above.
    const why = 'potential bypass of the mutation denial; sandbox unestablished; zero recorded usage';
    for (const a of agentSurfaces().filter(x => !isWriter(x))) {
      for (const t of READ_ONLY_ONLY_DENIALS) {
        expect(`${a.name} denies ${t} (${why}): ${a.disallowedTools.includes(t)}`)
          .toBe(`${a.name} denies ${t} (${why}): true`);
      }
    }
  });

  test('the writers are deliberately left holding REPL', () => {
    // Pins the other half of the decision. They already have Write/Edit and
    // mostly Bash, so denying REPL there would be theatre, not a control —
    // and a blanket "deny everywhere" rule would quietly erase that distinction.
    const writers = agentSurfaces().filter(isWriter);
    expect(writers.map(a => a.name).sort()).toEqual(['coder', 'docs-writer', 'pr-reviewer']);
    for (const a of writers) {
      expect(`${a.name} denies REPL: ${a.disallowedTools.includes('REPL')}`)
        .toBe(`${a.name} denies REPL: false`);
    }
  });

  test('only the agents whose job is to produce files are writers', () => {
    // Pins the classification itself. `coder` writes AL source; `docs-writer`
    // writes documentation drafts; `pr-reviewer` writes scratch context files it
    // hands to its sub-agents. If a fourth agent ever appears in this list, the
    // invariant above silently stopped applying to it.
    const writers = agentSurfaces().filter(isWriter).map(a => a.name).sort();
    expect(writers).toEqual(['coder', 'docs-writer', 'pr-reviewer']);
  });

  test('no agent relies on omission alone for a mutating tool', () => {
    // The failure mode this whole file exists for: a tool that is neither
    // allowed nor denied is still fully callable at runtime.
    for (const a of agentSurfaces()) {
      for (const t of MUTATING_TOOLS) {
        const decided = a.allowedTools.includes(t) || a.disallowedTools.includes(t);
        expect(`${a.name}:${t}:${decided}`).toBe(`${a.name}:${t}:true`);
      }
    }
  });

  test('covers every agent in src/agents', async () => {
    // Guards the registry above: a new agent directory must be added here, or
    // the invariants quietly skip it.
    const { readdirSync } = await import('fs');
    const dirs = readdirSync(new URL('../../src/agents', import.meta.url), { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
    expect(agentSurfaces().map(a => a.name).sort()).toEqual(dirs);
  });
});

describe('tool scoping — deliberate exceptions', () => {
  test('pr-reviewer keeps Write: its sub-agent context files depend on it', () => {
    // NOT an oversight. The orchestrator writes a scratch context file
    // (/tmp/pr<id>/CONTEXT.md) and passes that path to its 7 sub-agents instead
    // of inlining the full PR context into each dispatch prompt — 929 recorded
    // Agent dispatches reference such a path. Denying Write here would break the
    // review's context-passing, so it is allowed on purpose.
    const pr = agentSurfaces().find(a => a.name === 'pr-reviewer')!;
    expect(pr.disallowedTools).not.toContain('Write');
    expect(pr.disallowedTools).not.toContain('Edit');
  });

  test('pr-reviewer keeps its dispatch tools: fanning out is its design', () => {
    const pr = agentSurfaces().find(a => a.name === 'pr-reviewer')!;
    expect(pr.disallowedTools).not.toContain('Agent');
    expect(pr.disallowedTools).not.toContain('Task');
  });

  test('coder keeps every tool it needs to change the repo', () => {
    // Denying any of these would break the one agent whose job is to write code.
    const coder = agentSurfaces().find(a => a.name === 'coder')!;
    for (const t of ['Write', 'Edit', 'Bash', 'Agent', 'Task']) {
      expect(coder.disallowedTools).not.toContain(t);
    }
  });

  test('docs-writer keeps Write and Bash', () => {
    // It produces documentation drafts, and its Bash use is read-only navigation.
    const dw = agentSurfaces().find(a => a.name === 'docs-writer')!;
    for (const t of ['Write', 'Edit', 'Bash']) {
      expect(dw.disallowedTools).not.toContain(t);
    }
  });
});

// ---------------------------------------------------------------------------
// The pr-reviewer's own sub-agents must not be able to post to the PR.
//
// Measured, twice: on PR 52726 (2026-08-06) and PR 53254 (2026-08-14) the
// `code-review-validator` sub-agent called `add_pull_request_comment` itself,
// with the "Code Review In Progress" template copied character for character
// out of the ORCHESTRATOR's CLAUDE.md. It then updated its own thread with a
// full review of its own. The PR ended up with two bot threads: the
// orchestrator's, which the pipeline tracks, and the sub-agent's, which nothing
// tracks — no reconciliation, no stale marking, invisible to finding-outcome
// tooling.
//
// The sub-agents inherit the orchestrator's MCP servers, and the orchestrator
// must keep both write tools (posting the review is its job), so the denial has
// to be per-agent. `AgentDefinition.disallowedTools` is that mechanism, and the
// CLI parses it from agent-file frontmatter (`disallowedTools`, or the
// kebab-case `disallowed-tools`).
//
// CRITICAL: the CLI's own frontmatter schema says `disallowedTools` is
// "Ignored if `tools` is set." A sub-agent file that grows a `tools:` key later
// silently loses this denial, so both halves are asserted here.
//
// This pins the DECLARATION only. It cannot prove the CLI honoured it — verify
// that by effect, with zero sub-agent post calls in telemetry:
//
//   SELECT agent_name, count(*) FROM stage_logs
//   WHERE content LIKE '%TOOL INPUT: mcp__azureDevOps__add_pull_request_comment%'
//     AND agent_name <> 'pr-reviewer' AND created_at > '<deploy time>'
//   GROUP BY 1;
// ---------------------------------------------------------------------------

const PR_WRITE_TOOLS: string[] = [
  'mcp__azureDevOps__add_pull_request_comment',
  'mcp__azureDevOps__update_pull_request_comment',
];

/** Every sub-agent file the pr-reviewer dispatches, with its parsed frontmatter. */
function prReviewerSubAgents(): { file: string; frontmatter: string }[] {
  const dir = fileURLToPath(new URL('../../src/agents/pr-reviewer/.claude/agents/', import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const raw = readFileSync(join(dir, f), 'utf8');
      const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
      if (!m) throw new Error(`${f} has no frontmatter block`);
      return { file: f, frontmatter: m[1]! };
    });
}

describe('pr-reviewer sub-agents cannot post to the PR', () => {
  test('there are sub-agent files to check at all', () => {
    // Guards the whole block: a rename of the agents directory would otherwise
    // turn every assertion below into a vacuous pass over an empty list.
    expect(prReviewerSubAgents().length).toBeGreaterThanOrEqual(7);
  });

  test.each(PR_WRITE_TOOLS)('every sub-agent denies %s', (tool) => {
    for (const { file, frontmatter } of prReviewerSubAgents()) {
      expect(`${file}: ${frontmatter}`).toContain(tool);
    }
  });

  test('every sub-agent declares a disallowedTools key', () => {
    for (const { file, frontmatter } of prReviewerSubAgents()) {
      expect(`${file}: ${frontmatter}`).toMatch(/^(disallowedTools|disallowed-tools):/m);
    }
  });

  test('no sub-agent sets `tools:`, which would silently void the denial', () => {
    // The CLI frontmatter schema: "Tools removed from the default set. Ignored
    // if `tools` is set." A `tools:` key added later would disable the guard
    // above with nothing failing anywhere else.
    for (const { file, frontmatter } of prReviewerSubAgents()) {
      expect(`${file}: ${frontmatter}`).not.toMatch(/^tools:/m);
    }
  });
});
