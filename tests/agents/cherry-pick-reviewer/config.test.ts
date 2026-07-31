import { describe, test, expect, afterEach } from 'bun:test';
import { readFileSync } from 'fs';
import type { PipelineConfig, PipelineContext, PipelineState } from '../../../src/types/pipeline.types.ts';
import {
  createBackportReviewConfig,
  postedThroughMcp,
  type BackportReviewParams,
} from '../../../src/agents/cherry-pick-reviewer/config.ts';
import { BackportReviewSchema } from '../../../src/agents/cherry-pick-reviewer/schema.ts';
import { createInitialState } from '../../../src/pipeline/initial-state.ts';

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
  diffComparison: '## Diff comparison against the source PR\n\nnone',
  sourceReviewStatus: 'not-reviewed',
  sourceRecommendation: null,
  mergePreviewStale: false,
  checkoutOk: true,
  noPost: false,
};

/** buildPrompt reads neither argument — params is its only channel. */
const NO_STATE = {} as PipelineState;
const NO_CTX = {} as PipelineContext;

const SOURCE = readFileSync(
  new URL('../../../src/agents/cherry-pick-reviewer/config.ts', import.meta.url),
  'utf8',
);

describe('cherry-pick-reviewer config', () => {
  test('cannot fan out — neither Agent nor Task is allowed', () => {
    // THE structural cost guarantee. The full reviewer costs ~$10 because seven
    // sub-agents each cache their own context. Adding either tool here silently
    // restores that with nothing failing. Both names have existed across SDK versions.
    const c = createBackportReviewConfig(config, params);
    expect(c.allowedTools).not.toContain('Agent');
    expect(c.allowedTools).not.toContain('Task');
  });

  test('cannot fan out — every dispatch route the SDK offers is disallowed', () => {
    // Four names, and each is here for its own reason. Anyone tempted to prune
    // the two that "look unused" should read these first — none of the four has
    // ever been called, which is the point of a structural guarantee.
    const denied = createBackportReviewConfig(config, params).disallowedTools ?? [];
    const routes: Array<[string, string]> = [
      ['Agent', 'the dispatch tool proper'],
      ['Task', 'the same tool under the name the SDK used in earlier versions'],
      ['Workflow', 'takes a script of agent()/parallel()/pipeline() calls — fan-out under a third name'],
      ['REPL', 'arbitrary JavaScript with persistent state, which can reach anything the other three can'],
    ];
    for (const [tool, why] of routes) {
      expect(`${tool} denied (${why}): ${denied.includes(tool)}`)
        .toBe(`${tool} denied (${why}): true`);
    }
  });

  test('cannot fan out — both dispatch tools are disallowed, which is what enforces it', () => {
    // The assertion above does not, on its own, guarantee anything: allowedTools is
    // the SDK's auto-allow-without-prompting list, and runAgent passes
    // permissionMode 'bypassPermissions', so the claude_code preset's default tools
    // remain reachable whether or not they are named there. Measured on this
    // pipeline's own telemetry: analyzer lists neither dispatch tool and has no
    // sub-agents, yet 6 of its stage runs called `Agent`. disallowedTools is the
    // mechanism that removes a tool from the model's context — in the same data,
    // Bash (which analyzer disallows) appears in 0 of its 14 runs.
    const c = createBackportReviewConfig(config, params);
    expect(c.disallowedTools).toContain('Agent');
    expect(c.disallowedTools).toContain('Task');
  });

  test('caps turns below the full reviewer, but above the work it replaces', () => {
    // Measured: 30 was too tight. Two acceptance runs on the same PR took 25 and 31
    // turns; the 31-turn run hit the cap, returned NULL structured output
    // (`subtype=error_max_turns`) and errored the review out entirely — leaving a
    // cherry-pick PR with NO review, worse than the full review this path replaces.
    // The full reviews it stands in for run a median of 33 turns (p90 43, max 56,
    // n=310), so the old cap sat below the median of that work.
    const turns = createBackportReviewConfig(config, params).maxTurns;
    expect(turns).toBe(60);
    // Both bounds matter: comfortably above the observed 31, still cheaper than the
    // full reviewer's 100.
    expect(turns).toBeGreaterThan(43); // p90 of the full reviews this replaces
    expect(turns).toBeLessThan(100); // pr-reviewer's cap
  });

  test('pins the model explicitly rather than inheriting', () => {
    // The model is the measured cost lever here: seven sub-agents silently running
    // opus instead of sonnet took one review from $10.06 to $18.77 on the same image.
    expect(createBackportReviewConfig(config, params).model).toBe('claude-sonnet-5');
  });

  test('does not retry — the review posts comments', () => {
    expect(createBackportReviewConfig(config, params).maxRetries).toBe(1);
  });

  test('reviews without writing — no Edit, no Write', () => {
    // A reviewer that can edit the working tree can silently "fix" the port it is
    // judging, and the checked-out tree is the evidence for checks 2 and 3.
    const c = createBackportReviewConfig(config, params);
    expect(c.allowedTools).not.toContain('Edit');
    expect(c.allowedTools).not.toContain('Write');
  });

  test('can post its review through the supported channel', () => {
    // runBackportReview fails the run when neither of these was called, so an
    // agent that cannot call them fails every non-replay review.
    const c = createBackportReviewConfig(config, params);
    expect(c.allowedTools).toContain('mcp__azureDevOps__add_pull_request_comment');
    expect(c.allowedTools).toContain('mcp__azureDevOps__update_pull_request_comment');
  });

  test('runs in the session root, where the container clones the repo', () => {
    expect(createBackportReviewConfig(config, params).cwd).toBe('/workspace');
  });

  test('wires the azureDevOps MCP server', () => {
    const c = createBackportReviewConfig(config, params);
    const servers = typeof c.mcpServers === 'function'
      ? c.mcpServers(createInitialState('cherry-pick-reviewer'))
      : c.mcpServers!;
    expect(servers['azureDevOps']).toBeDefined();
  });
});

describe('cherry-pick-reviewer config — LSP', () => {
  const savedMechanism = process.env['CALLEE_MECHANISM'];
  afterEach(() => {
    if (savedMechanism === undefined) delete process.env['CALLEE_MECHANISM'];
    else process.env['CALLEE_MECHANISM'] = savedMechanism;
  });

  test('enables the LSP tool unconditionally', () => {
    // pr-reviewer gates LSP on CALLEE_MECHANISM, which container-dispatcher does
    // NOT forward — so in production it runs with mechanism 'none' and no LSP. If
    // this agent copied that, checks 2 and 3 would always be 'unverified' and the
    // agent would never approve anything, silently.
    delete process.env['CALLEE_MECHANISM'];
    expect(createBackportReviewConfig(config, params).allowedTools).toContain('LSP');

    // 'none' is what pr-reviewer's own default resolves to; assert it explicitly so
    // a gate reintroduced with that default cannot pass on the unset case alone.
    process.env['CALLEE_MECHANISM'] = 'none';
    expect(createBackportReviewConfig(config, params).allowedTools).toContain('LSP');
  });

  test('the AL LSP plugin is resolved unconditionally too', () => {
    // The LSP tool without the plugin registers nothing. `plugins` is [] on a host
    // with no AL plugin installed, so this pins the field's presence, and the
    // CALLEE_MECHANISM test below pins that nothing gates its contents.
    delete process.env['CALLEE_MECHANISM'];
    expect(Array.isArray(createBackportReviewConfig(config, params).plugins)).toBe(true);
  });

  test('no part of this config is gated on an environment variable', () => {
    // The behavioural assertions above cannot see a plugin gate on a host without
    // the AL plugin installed — both branches yield []. This covers both, and any
    // other env gate: what this agent may do must not vary with the environment,
    // which is exactly how pr-reviewer ended up running with no LSP in production.
    expect(SOURCE).not.toMatch(/process\.env/);
  });
});

describe('cherry-pick-reviewer config — buildPrompt', () => {
  test('names the subdirectory the repo is cloned into — the session root is not the checked-out tree itself', () => {
    // A review found review-pr.ts running checkoutBranch/resolveRef in
    // config.paths.sessionRoot itself, when the entrypoint actually clones the repo one
    // level down (${SESSION_ROOT}/${REPO_KEY}). The prompt must not repeat that false
    // claim — an agent told the repo is at its cwd, when it is one level down, burns
    // turns discovering that, and this agent has a bounded turn budget (60) with no retry.
    const p = createBackportReviewConfig(config, params).buildPrompt(NO_STATE, NO_CTX);
    expect(p).toContain(`\`${params.repoKey}\` subdirectory`);
    expect(p).not.toMatch(/cloned at the current working directory/i);
  });

  test('the prompt carries the pre-computed diff comparison, not an instruction to derive it', () => {
    const p = createBackportReviewConfig(config, params).buildPrompt(NO_STATE, NO_CTX);
    expect(p).toContain('## Diff comparison against the source PR');
    expect(p).toContain('!52117');
  });

  test('the prompt states the source PR was never reviewed when that is so', () => {
    const p = createBackportReviewConfig(config, params).buildPrompt(NO_STATE, NO_CTX);
    expect(p).toContain('not-reviewed');
  });

  test('a reviewed source PR carries its recommendation instead', () => {
    const p = createBackportReviewConfig(config, {
      ...params,
      sourceReviewStatus: 'reviewed',
      sourceRecommendation: 'approve',
    }).buildPrompt(NO_STATE, NO_CTX);
    expect(p).toContain('approve');
    expect(p).not.toContain('not-reviewed');
  });

  test('REPLAY MODE appears when noPost is set', () => {
    const p = createBackportReviewConfig(config, { ...params, noPost: true }).buildPrompt(NO_STATE, NO_CTX);
    expect(p).toContain('REPLAY MODE');
  });

  test('REPLAY MODE is absent on a real review', () => {
    const p = createBackportReviewConfig(config, params).buildPrompt(NO_STATE, NO_CTX);
    expect(p).not.toContain('REPLAY MODE');
  });

  test('a failed checkout tells the agent the tree is not the merge preview', () => {
    // checkoutOk false means the working tree is the registry default branch, not
    // this port. Checks 2 and 3 answered from it would be confidently wrong.
    const p = createBackportReviewConfig(config, { ...params, checkoutOk: false }).buildPrompt(NO_STATE, NO_CTX);
    expect(p).toContain('unverified');
  });

  test('a stale merge preview is stated as such', () => {
    const p = createBackportReviewConfig(config, { ...params, mergePreviewStale: true }).buildPrompt(NO_STATE, NO_CTX);
    expect(p).toMatch(/target advanced/i);
  });
});

describe('cherry-pick-reviewer config — priorFindingsBlock', () => {
  // Mirrors pr-reviewer's own handling (config.ts's buildPrompt): without this, a
  // re-review of a backport has nothing to be stable against, and every re-review
  // forks each thread into a duplicate rather than updating it — the exact defect
  // Task 8's inline-comment feature was built to prevent.
  const priorBlock = [
    '## Findings already tracked on this PR',
    '',
    '| File | Title |',
    '|---|---|',
    '| App/Cloud/Al/Codeunits/X.Codeunit.al | Partial port |',
  ].join('\n');

  test('prepends the prior-findings block when one is supplied', () => {
    // buildPrompt ignores both its arguments, so this block can only arrive
    // through BackportReviewParams. Computing it and never reaching the prompt
    // is the failure mode worth pinning.
    const prompt = createBackportReviewConfig(config, { ...params, priorFindingsBlock: priorBlock }).buildPrompt(NO_STATE, NO_CTX);
    expect(prompt.startsWith(priorBlock)).toBe(true);
    expect(prompt).toContain('Partial port');
    expect(prompt).toContain('## Task');
  });

  test('omits the prior-findings block when it is empty', () => {
    // An unconditional heading with an empty table would tell the model prior
    // findings exist when they do not.
    const prompt = createBackportReviewConfig(config, { ...params, priorFindingsBlock: '' }).buildPrompt(NO_STATE, NO_CTX);
    expect(prompt.startsWith('## Task')).toBe(true);
    expect(prompt).not.toContain('Findings already tracked');
  });

  test('omits the prior-findings block when the field is absent', () => {
    const prompt = createBackportReviewConfig(config, params).buildPrompt(NO_STATE, NO_CTX);
    expect(prompt.startsWith('## Task')).toBe(true);
    expect(prompt).not.toContain('Findings already tracked');
  });
});

describe('BackportReviewSchema', () => {
  test('schema requires the fields the save path persists', () => {
    // review-pr.ts persists findingsCount, findings and commentId; runPRReview's
    // no-comment assertion polices the MCP posting calls.
    const shape = Object.keys(BackportReviewSchema.shape);
    for (const k of ['commentId', 'findingsCount', 'findings', 'recommendation', 'findingsList', 'reviewBody']) {
      expect(shape).toContain(k);
    }
  });

  test('schema carries a verdict per check', () => {
    const shape = Object.keys(BackportReviewSchema.shape);
    for (const k of ['diffFaithful', 'symbolsResolve', 'coverageIntact', 'sourceReviewStatus', 'checkoutOk', 'mergePreviewStale']) {
      expect(shape).toContain(k);
    }
  });

  test('findingsList entries are the shape the inline-comment poster consumes', () => {
    // applyInlineFindings anchors on file+line+title; a divergent finding shape here
    // would post nothing inline and nothing would fail.
    const parsed = BackportReviewSchema.parse({
      commentId: 1,
      sourcePrId: 52117,
      sourceReviewStatus: 'not-reviewed',
      sourceRecommendation: null,
      mergePreviewStale: false,
      checkoutOk: true,
      diffFaithful: 'faithful',
      symbolsResolve: 'all',
      coverageIntact: 'intact',
      recommendation: 'approve',
      findingsCount: 1,
      findings: { critical: 0, major: 1, minor: 0, nitpick: 0 },
      findingsList: [
        { severity: 'major', title: 'Dropped guard', file: 'Cloud/Al/Src/X.al', line: 42, location: 'PostDocument', body: 'text' },
      ],
      reviewBody: '## Backport review',
    });
    expect(parsed.findingsList[0]).toMatchObject({
      severity: 'major',
      title: 'Dropped guard',
      file: 'Cloud/Al/Src/X.al',
      line: 42,
      location: 'PostDocument',
    });
  });

  test('findingsList defaults to empty — a clean port returns no findings', () => {
    const parsed = BackportReviewSchema.parse({
      commentId: 1,
      sourcePrId: 52117,
      sourceReviewStatus: 'reviewed',
      sourceRecommendation: 'approve',
      mergePreviewStale: false,
      checkoutOk: true,
      diffFaithful: 'faithful',
      symbolsResolve: 'all',
      coverageIntact: 'intact',
      recommendation: 'approve',
      findingsCount: 0,
      findings: { critical: 0, major: 0, minor: 0, nitpick: 0 },
      reviewBody: '## Backport review',
    });
    expect(parsed.findingsList).toEqual([]);
  });
});

describe('postedThroughMcp', () => {
  test('a run that called neither comment tool did not post', () => {
    // The failure this guards: the model posts with Bash + curl, the shell mangles
    // the markdown body, and the pipeline records a successful review anyway.
    expect(postedThroughMcp({})).toBe(false);
    expect(postedThroughMcp({ Bash: 12, Read: 4, LSP: 9 })).toBe(false);
  });

  test('either comment tool counts as posted', () => {
    expect(postedThroughMcp({ 'mcp__azureDevOps__add_pull_request_comment': 1 })).toBe(true);
    expect(postedThroughMcp({ 'mcp__azureDevOps__update_pull_request_comment': 1 })).toBe(true);
  });

  test('a zero call count is not a post', () => {
    expect(postedThroughMcp({ 'mcp__azureDevOps__add_pull_request_comment': 0 })).toBe(false);
  });
});
