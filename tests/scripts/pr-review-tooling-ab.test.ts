import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  argFrom,
  hasFrom,
  parsePrIds,
  resolvePrIds,
  validateOauthToken,
  ARMS,
  NO_CQA,
  selectArms,
  expectedModelFor,
  leverFlagsFor,
  buildComplianceVerdict,
  buildArmEnv,
  matchesArmRow,
  buildResultLine,
  resolveAllRepos,
  type Arm,
  type ResolvedRepo,
  type RepoResolver,
} from '../../scripts/pr-review-tooling-ab.ts';

// Importing this module must NEVER open a DB connection, spawn a container,
// make an LLM call, or spend a cent — every side-effecting statement in the
// script lives behind `if (import.meta.main)`, which is false when a test
// file imports it. If that guard were ever removed or narrowed incorrectly,
// this entire suite would hang or fail trying to reach the live production
// database.

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

describe('argFrom / hasFrom', () => {
  test('argFrom reads the value following a flag', () => {
    expect(argFrom(['--runs', '3'], 'runs')).toBe('3');
  });

  test('argFrom returns the default when the flag is absent', () => {
    expect(argFrom(['--go'], 'runs', '1')).toBe('1');
  });

  test('hasFrom detects a bare flag', () => {
    expect(hasFrom(['--go', '--oauth'], 'oauth')).toBe(true);
    expect(hasFrom(['--go'], 'oauth')).toBe(false);
  });
});

describe('parsePrIds', () => {
  test('parses a comma-separated list, dropping blanks and non-numeric entries', () => {
    expect(parsePrIds('49388,45792, 43408,, foo')).toEqual([49388, 45792, 43408]);
  });

  test('an all-invalid string parses to an empty list rather than throwing', () => {
    expect(parsePrIds('foo,bar')).toEqual([]);
  });
});

describe('resolvePrIds', () => {
  test('--prs is the matrix form', () => {
    expect(resolvePrIds(['--prs', '1,2,3'])).toEqual([1, 2, 3]);
  });

  test('--pr (singular) is accepted when --prs is absent', () => {
    expect(resolvePrIds(['--pr', '99'])).toEqual([99]);
  });

  test('--prs wins when both are given (single-line fragility: swapping the `||` operands breaks this)', () => {
    expect(resolvePrIds(['--prs', '1,2', '--pr', '99'])).toEqual([1, 2]);
  });

  test('neither flag present resolves to an empty list', () => {
    expect(resolvePrIds(['--go'])).toEqual([]);
  });
});

describe('validateOauthToken (C4: fail fast when --oauth has no token)', () => {
  test('oauth requested with no token is rejected', () => {
    const v = validateOauthToken(true, '');
    expect(v.ok).toBe(false);
  });

  test('oauth requested with a token present is accepted', () => {
    const v = validateOauthToken(true, 'oauth-tok-123');
    expect(v.ok).toBe(true);
  });

  test('no oauth requested never requires a token', () => {
    const v = validateOauthToken(false, '');
    expect(v.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Arm table
// ---------------------------------------------------------------------------

describe('ARMS', () => {
  test('the matrix has exactly 8 arms', () => {
    expect(ARMS).toHaveLength(8);
  });

  test('NO_CQA excludes code-quality-assessor and keeps the other 6', () => {
    expect(NO_CQA).not.toContain('code-quality-assessor');
    expect(NO_CQA).toHaveLength(6);
  });

  test('lean enables all four levers', () => {
    const lean = ARMS.find((a) => a.name === 'lean')!;
    expect(lean.agentSet).toEqual(NO_CQA);
    expect(lean.routing).toBe(true);
    expect(lean.scoped).toBe(true);
    expect(lean.bcSecurity).toBe(true);
  });

  test('baseline enables none of the four levers', () => {
    const baseline = ARMS.find((a) => a.name === 'baseline')!;
    expect(baseline.agentSet).toBeNull();
    expect(baseline.routing).toBe(false);
    expect(baseline.scoped).toBe(false);
    expect(baseline.bcSecurity).toBe(false);
  });
});

describe('selectArms (C6: filters on Arm.name, not the old Arm.label)', () => {
  test('--arms lean selects exactly the lean arm', () => {
    const selected = selectArms('lean', ARMS);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.name).toBe('lean');
  });

  test('an empty filter selects every arm', () => {
    expect(selectArms('', ARMS)).toHaveLength(8);
  });

  test('a comma-separated filter selects multiple named arms', () => {
    const selected = selectArms('baseline, lean', ARMS);
    expect(selected.map((a) => a.name).sort()).toEqual(['baseline', 'lean']);
  });

  test('an unknown name matches nothing (caller is responsible for erroring on empty)', () => {
    expect(selectArms('not-a-real-arm', ARMS)).toHaveLength(0);
  });

  test('matching is exact — a case mismatch does not select the arm (reproduces by renaming an arm)', () => {
    const renamed: Arm[] = ARMS.map((a) => (a.name === 'lean' ? { ...a, name: 'Lean' } : a));
    expect(selectArms('lean', renamed)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Compliance wiring (C1, C2)
// ---------------------------------------------------------------------------

describe('expectedModelFor (C1: must never resolve to null for any of the 8 arms)', () => {
  test('every arm in the matrix resolves to a concrete, non-null model', () => {
    for (const arm of ARMS) {
      const model = expectedModelFor(arm);
      expect(model).not.toBeNull();
      expect(typeof model).toBe('string');
      expect(model.length).toBeGreaterThan(0);
    }
  });

  test('an arm with no model override resolves to the frontmatter-pinned sonnet-5', () => {
    expect(expectedModelFor(ARMS.find((a) => a.name === 'baseline')!)).toBe('claude-sonnet-5');
  });

  test('an arm with an explicit model override is honoured over the default', () => {
    const custom: Arm = { name: 'x', agentSet: null, routing: false, scoped: false, bcSecurity: false, model: 'claude-opus-5' };
    expect(expectedModelFor(custom)).toBe('claude-opus-5');
  });

  test('an empty-string model still falls through to the default (|| not ??)', () => {
    const blank: Arm = { name: 'x', agentSet: null, routing: false, scoped: false, bcSecurity: false, model: '' };
    expect(expectedModelFor(blank)).toBe('claude-sonnet-5');
  });
});

describe('leverFlagsFor (C2: translate arm.scoped/arm.bcSecurity to scopedPayload/securityBcOnly)', () => {
  test('lean maps every arm-side flag to its LeverFlags counterpart', () => {
    const lean = ARMS.find((a) => a.name === 'lean')!;
    expect(leverFlagsFor(lean)).toEqual({ agentSet: true, routing: true, scopedPayload: true, securityBcOnly: true });
  });

  test('baseline maps to all-false (agentSet is null, so its flag is false too)', () => {
    const baseline = ARMS.find((a) => a.name === 'baseline')!;
    expect(leverFlagsFor(baseline)).toEqual({ agentSet: false, routing: false, scopedPayload: false, securityBcOnly: false });
  });

  test('scoped and bc-security map to DISTINCT, non-transposed flags', () => {
    const scoped = ARMS.find((a) => a.name === 'scoped')!;
    const bcSecurity = ARMS.find((a) => a.name === 'bc-security')!;
    expect(leverFlagsFor(scoped)).toEqual({ agentSet: false, routing: false, scopedPayload: true, securityBcOnly: false });
    expect(leverFlagsFor(bcSecurity)).toEqual({ agentSet: false, routing: false, scopedPayload: false, securityBcOnly: true });
  });
});

describe('buildComplianceVerdict (the real call site, end to end)', () => {
  const sevenAgents = (model: string) => Object.fromEntries(
    ['code-review-validator', 'code-quality-assessor', 'security-edge-case-analyzer',
      'al-performance-analyzer', 'al-architecture-analyzer', 'al-error-pattern-analyzer',
      'al-integration-analyzer'].map((n) => [n, { model }]),
  );

  test('baseline arm whose sub-agents all ran on the pinned sonnet-5 is compliant', () => {
    const v = buildComplianceVerdict(ARMS.find((a) => a.name === 'baseline')!, sevenAgents('claude-sonnet-5'), null);
    expect(v.compliant).toBe(true);
  });

  test(
    'C1: an arm whose model field is unset still VOIDs a run that reports the wrong model — ' +
    'proving expectedModel reaching checkArmCompliance is a concrete value, not null',
    () => {
      const baseline = ARMS.find((a) => a.name === 'baseline')!;
      expect(baseline.model).toBeUndefined();
      const v = buildComplianceVerdict(baseline, sevenAgents('claude-opus-5'), null);
      expect(v.compliant).toBe(false);
      expect(v.reason).toContain('wrong model');
    },
  );

  test('C2: the scoped arm VOIDs when its scopedPayload lever recorded no application', () => {
    const scoped = ARMS.find((a) => a.name === 'scoped')!;
    const v = buildComplianceVerdict(scoped, sevenAgents('claude-sonnet-5'), null);
    expect(v.compliant).toBe(false);
    expect(v.reason).toContain('scopedPayload');
  });

  test('C2: the scoped arm is compliant once scopedPayload recorded exactly 1 application', () => {
    const scoped = ARMS.find((a) => a.name === 'scoped')!;
    const v = buildComplianceVerdict(scoped, sevenAgents('claude-sonnet-5'), { scopedPayload: 1 });
    expect(v.compliant).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Env assembly (C3, C4)
// ---------------------------------------------------------------------------

describe('buildArmEnv', () => {
  const lean = ARMS.find((a) => a.name === 'lean')!;

  test('every lever env var is wired per Step 2 for the lean arm', () => {
    const env = buildArmEnv({}, lean, { post: false, containerDbUrl: 'postgres://db/x', oauth: false, oauthToken: '' });
    expect(env['PR_REVIEW_AGENT_SET']).toBe(NO_CQA.join(','));
    expect(env['PR_REVIEW_AGENT_ROUTING']).toBe('1');
    expect(env['PR_REVIEW_SCOPED_PAYLOAD']).toBe('1');
    expect(env['PR_REVIEW_SECURITY_BC_ONLY']).toBe('1');
    expect(env['PR_REVIEW_NO_POST']).toBe('1');
    expect(env['DATABASE_URL']).toBe('postgres://db/x');
  });

  test('post=true clears PR_REVIEW_NO_POST', () => {
    const env = buildArmEnv({}, lean, { post: true, containerDbUrl: 'x', oauth: false, oauthToken: '' });
    expect(env['PR_REVIEW_NO_POST']).toBe('');
  });

  test(
    'C3: the base env spread is LIVE — a key present in the base (e.g. AZURE_DEVOPS_PAT) survives untouched',
    () => {
      const base = { ['AZURE_DEVOPS_PAT']: 'pat-123', SOME_OTHER_VAR: 'v' };
      const env = buildArmEnv(base, lean, { post: false, containerDbUrl: 'x', oauth: false, oauthToken: '' });
      expect(env['AZURE_DEVOPS_PAT']).toBe('pat-123');
      expect(env['SOME_OTHER_VAR']).toBe('v');
    },
  );

  test(
    'C4: --oauth blanks ANTHROPIC_API_KEY and supplies the OAuth token, overriding whatever the base carried',
    () => {
      const base = { ['ANTHROPIC_API_KEY']: 'sk-prod-pay-per-token', ['CLAUDE_CODE_OAUTH_TOKEN']: '' };
      const env = buildArmEnv(base, lean, { post: false, containerDbUrl: 'x', oauth: true, oauthToken: 'oauth-tok-123' });
      expect(env['ANTHROPIC_API_KEY']).toBe('');
      expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('oauth-tok-123');
    },
  );

  test('without --oauth, the base credential fields pass through untouched', () => {
    const base = { ['ANTHROPIC_API_KEY']: 'sk-prod-pay-per-token', ['CLAUDE_CODE_OAUTH_TOKEN']: '' };
    const env = buildArmEnv(base, lean, { post: false, containerDbUrl: 'x', oauth: false, oauthToken: 'oauth-tok-123' });
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-prod-pay-per-token');
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Row attribution (C10)
// ---------------------------------------------------------------------------

describe('matchesArmRow', () => {
  const since = '2026-07-29T10:00:00.000Z';

  test('a NO-POST row for the right PR after the cutoff matches', () => {
    expect(matchesArmRow({ prId: 100, commentId: null, createdAt: '2026-07-29T10:00:05.000Z' }, 100, since)).toBe(true);
  });

  test(
    'C10: a row with a non-null commentId is excluded even though PR id and timing match — ' +
    'a concurrent production/watcher review must never be misattributed to an arm',
    () => {
      expect(matchesArmRow({ prId: 100, commentId: 42, createdAt: '2026-07-29T10:00:05.000Z' }, 100, since)).toBe(false);
    },
  );

  test('a row for a different PR does not match', () => {
    expect(matchesArmRow({ prId: 200, commentId: null, createdAt: '2026-07-29T10:00:05.000Z' }, 100, since)).toBe(false);
  });

  test('a row before the cutoff does not match', () => {
    expect(matchesArmRow({ prId: 100, commentId: null, createdAt: '2026-07-29T09:59:00.000Z' }, 100, since)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// JSONL result-line assembly (C9)
// ---------------------------------------------------------------------------

describe('buildResultLine', () => {
  const arm = ARMS.find((a) => a.name === 'scoped')!;

  test('a compliant run records verdict, note and appliedLevers alongside the identity fields', () => {
    const line = buildResultLine(
      arm, 555,
      { id: 9001, createdAt: '2026-07-29T10:00:00.000Z', appliedLevers: { scopedPayload: 1 } },
      { arm: 'scoped', compliant: true, actual: 6 },
    );
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      arm: 'scoped', prId: 555, rowId: 9001, createdAt: '2026-07-29T10:00:00.000Z',
      verdict: 'compliant', reason: null, note: null, appliedLevers: { scopedPayload: 1 },
    });
  });

  test('a void run records verdict:"void" and its reason, so a soft failure cannot scroll past unnoticed', () => {
    const line = buildResultLine(
      arm, 555,
      { id: 9002, createdAt: '2026-07-29T10:05:00.000Z', appliedLevers: null },
      { arm: 'scoped', compliant: false, actual: 7, reason: 'lever scopedPayload was enabled but no application was recorded' },
    );
    const parsed = JSON.parse(line);
    expect(parsed.verdict).toBe('void');
    expect(parsed.reason).toBe('lever scopedPayload was enabled but no application was recorded');
    expect(parsed.appliedLevers).toBeNull();
  });

  test('each call produces exactly one newline-terminated JSON line', () => {
    const line = buildResultLine(
      arm, 1, { id: 1, createdAt: 'x', appliedLevers: null }, { arm: 'scoped', compliant: true, actual: 6 },
    );
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trim().split('\n')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// PR -> repo resolution (fix round 1: resolve every id up front, before --go)
// ---------------------------------------------------------------------------

describe('resolveAllRepos', () => {
  const repoA: ResolvedRepo = { key: 'repoA', config: {} as ResolvedRepo['config'], repositoryId: 'guid-a' };
  const repoB: ResolvedRepo = { key: 'repoB', config: {} as ResolvedRepo['config'], repositoryId: 'guid-b' };

  /** A fake resolver — no network, no ADO, no real I/O — mapping known PR ids to canned repos. */
  const fakeResolver = (known: Record<number, ResolvedRepo>): RepoResolver => async (prId) => known[prId] ?? null;

  test('every id resolves: returns ok with all of them mapped', async () => {
    const result = await resolveAllRepos([100, 200], fakeResolver({ 100: repoA, 200: repoB }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.repos.get(100)).toEqual(repoA);
      expect(result.repos.get(200)).toEqual(repoB);
    }
  });

  test(
    'C5 follow-up: an unresolvable id in the middle of --prs is rejected, naming it, before any spend path is reachable',
    async () => {
      const result = await resolveAllRepos([100, 999, 200], fakeResolver({ 100: repoA, 200: repoB }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.unresolved).toEqual([999]);
        expect(result.message).toContain('999');
      }
    },
  );

  test('every unresolved id is named, not just the first (avoids a fix-one-rerun-find-the-next loop)', async () => {
    const result = await resolveAllRepos([1, 2, 3], fakeResolver({ 2: repoA }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unresolved).toEqual([1, 3]);
      expect(result.message).toContain('1');
      expect(result.message).toContain('3');
    }
  });

  test('a single bad id still fails the WHOLE batch — no partial success returned to spend against', async () => {
    const result = await resolveAllRepos([100, 999], fakeResolver({ 100: repoA }));
    expect(result.ok).toBe(false);
  });

  test('the resolver is called for every id even after an earlier one fails (so all failures are reported together)', async () => {
    const seen: number[] = [];
    const resolver: RepoResolver = async (prId) => {
      seen.push(prId);
      return prId === 999 ? null : repoA;
    };
    await resolveAllRepos([100, 999, 200], resolver);
    expect(seen).toEqual([100, 999, 200]);
  });
});

describe('source order: repo resolution runs before the --go gate (regression guard for the C5 ordering bug)', () => {
  // `resolveAllRepos`'s own logic is proven safe-without-spending above (it
  // only ever calls the injected resolver — never docker, never the DB). What
  // that cannot prove is that the SCRIPT actually calls it before checking
  // --go, which is the exact regression this fix round exists to close: C5
  // moved the PR loop (and, with it, repo resolution) entirely after the
  // --go check, so a bad PR id was only discovered after earlier ids in the
  // same --prs list had already billed a full 8-arm pool. This is a
  // structural property of the main block, which only runs under
  // `import.meta.main` (never on import), so it is asserted against the
  // script's own source text rather than by executing it.
  const source = readFileSync(new URL('../../scripts/pr-review-tooling-ab.ts', import.meta.url), 'utf-8');

  test('resolveAllRepos is called before the --go dry-run gate', () => {
    const resolveCallIdx = source.indexOf('await resolveAllRepos(');
    const goGateIdx = source.indexOf("if (!has('go'))");
    expect(resolveCallIdx).toBeGreaterThan(-1);
    expect(goGateIdx).toBeGreaterThan(-1);
    expect(resolveCallIdx).toBeLessThan(goGateIdx);
  });

  test('a failed resolution exits before preflightDb (the DB write-path probe) ever runs', () => {
    const repoResultCheckIdx = source.indexOf('if (!repoResult.ok)');
    const preflightCallIdx = source.indexOf('await preflightDb(containerDbUrl)');
    expect(repoResultCheckIdx).toBeGreaterThan(-1);
    expect(preflightCallIdx).toBeGreaterThan(-1);
    expect(repoResultCheckIdx).toBeLessThan(preflightCallIdx);
  });
});
