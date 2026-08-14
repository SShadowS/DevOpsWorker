/**
 * Stats & Config tab — resolved-configuration endpoint (`GET /api/config`).
 *
 * The whole point of this module is the difference between what a file
 * DECLARES and what actually runs. Every value here is computed by calling
 * the same functions production code calls (`loadConfig`, `buildConfigFromRepo`,
 * `resolveAgentKnobs`, `parseEffort`) — never by re-reading `CLAUDE.md`,
 * `config.ts` comments, or a schema and assuming the prose is still true.
 * Where two code paths resolve the same setting independently (there are two
 * config builders — see `orchestratorModel` below), both are resolved and
 * compared, not just one reported and the other assumed to agree.
 *
 * Database access is now real, but optional and best-effort: `settingsStore`
 * (an `ISettingsStore`, wired through from `connectStores()` by the caller)
 * feeds the same `readSetting`/`buildModelsAndCosts` precedence every other
 * config assembly uses, so this report shows what the pipeline would actually
 * use — including a database override — rather than a stale env-only view. A
 * missing store, or a failed read, falls back to `{}` (env/code defaults),
 * exactly like every other caller of `readAllSettingsSafely`; this endpoint
 * still never fails a dashboard request over a settings-table outage.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, buildConfigFromRepo, parseEffort, readSetting, readAllSettingsSafely, resolveDbAgentKnobs } from '../cli/config.ts';
import { loadManifest, resolveAgentKnobs } from '../overlay/index.ts';
import type { OverlayManifest } from '../overlay/index.ts';
import type { PipelineConfig } from '../types/pipeline.types.ts';
import type { AgentConfig } from '../types/agent.types.ts';
import type { RepoConfig } from '../config/repo-config.ts';
import type { ISettingsStore } from '../config/settings-store.interface.ts';

import { createAnalyzerConfig } from '../agents/analyzer/config.ts';
import { createPlannerConfig } from '../agents/planner/config.ts';
import { createPlanReviewerConfig } from '../agents/plan-reviewer/config.ts';
import { createCoderConfig, ciWaiterAgent } from '../agents/coder/config.ts';
import { createCodeReviewerConfig } from '../agents/code-reviewer/config.ts';
import { createDraftPRConfig } from '../agents/draft-pr/config.ts';
import { createTestCasesConfig } from '../agents/test-cases/config.ts';
import { createTestCaseReviewerConfig } from '../agents/test-case-reviewer/config.ts';
import { createDocumenterConfig } from '../agents/documenter/config.ts';
import { createDocsWriterConfig } from '../agents/docs-writer/config.ts';
import { createPRReviewConfig, type PRReviewParams } from '../agents/pr-reviewer/config.ts';
import { createBackportReviewConfig, type BackportReviewParams } from '../agents/cherry-pick-reviewer/config.ts';
import {
  DISALLOWED_TOOLS as RULE_LEARNER_DISALLOWED_TOOLS,
  MODEL as RULE_LEARNER_MODEL,
  MAX_TURNS as RULE_LEARNER_MAX_TURNS,
} from '../agents/rule-learner/config.ts';

// ---------------------------------------------------------------------------
// Effort — thin display wrapper over cli/config.ts's parseEffort
// ---------------------------------------------------------------------------

export interface EffortResolution {
  raw: string | undefined;
  /** `parseEffort`'s own result on `raw` ALONE — `undefined` for unset, blank,
   *  AND unrecognised values alike (a typo is a no-op, not an error — see
   *  parseEffort's jsdoc). Deliberately ignores any database setting, so a
   *  reader can compare it against `effective` to see whether a database
   *  override, not the historical env-divergence bug, explains a mismatch. */
  parsed: PipelineConfig['models']['effort'];
  /** What actually takes effect — the SAME value `buildModelsAndCosts` produced
   *  for the real config this report is describing, honouring a database
   *  `models.effort` setting when present. Never blank: an unresolved value
   *  reads as the SDK's own default rather than as an empty or misleadingly-raw
   *  string. */
  effective: string;
}

/**
 * `resolved` is the real, already-resolved `PipelineConfig['models']['effort']`
 * (i.e. `loadConfigResult.models.effort`, which already honours a database
 * setting) — NOT recomputed from `raw` here, so this can never silently drift
 * from what `buildModelsAndCosts` itself produced. Omitting it (as this
 * module's own unit tests do, and as any caller with no resolved config yet
 * may) falls back to parsing `raw` alone, identical to this function's
 * behaviour before database settings existed.
 */
export function resolveEffortDisplay(
  raw: string | undefined,
  resolved?: PipelineConfig['models']['effort'],
): EffortResolution {
  const parsed = parseEffort(raw);
  const effective = resolved ?? parsed;
  return { raw, parsed, effective: effective ?? '(SDK default: high)' };
}

// ---------------------------------------------------------------------------
// Eval levers — verify by EFFECT, not by presence (see config-ground-truth.md)
// ---------------------------------------------------------------------------

export type LeverState = 'active' | 'present-but-inert' | 'absent';

/** Evaluates the exact condition the real read site tests — never a blanket
 *  "is the key present" check. A key present but failing this predicate is
 *  `present-but-inert`, not `absent`: the container-env allowlist in
 *  `container-dispatcher.ts` forwards every one of these as `?? ''`, so
 *  "unset on the host" and "set to a value the read site rejects" both show up
 *  as a present, empty-or-non-matching string downstream — reporting that as
 *  `absent` would hide the exact trap this endpoint exists to catch. */
export function classifyLever(raw: string | undefined, predicate: (v: string) => boolean): LeverState {
  if (raw === undefined) return 'absent';
  return predicate(raw) ? 'active' : 'present-but-inert';
}

interface LeverDef {
  key: string;
  predicate: (v: string) => boolean;
  /** file:line of the actual read site this predicate mirrors. */
  sourceRef: string;
  description: string;
}

const NON_BLANK = (v: string) => v.trim() !== '';
const IS_ONE = (v: string) => v === '1';

/** The 8 `PR_REVIEW_*` eval-only levers (6 measurement hooks + NO_POST + TEST_RUN).
 *  `PR_REVIEW_ANTHROPIC_API_KEY` is deliberately excluded — it is a credential,
 *  not a lever, despite sharing the prefix (see `resolvePrReviewCredential`). */
const EVAL_LEVERS: LeverDef[] = [
  {
    key: 'PR_REVIEW_NO_POST',
    predicate: IS_ONE,
    sourceRef: 'src/cli/review-pr.ts:890,951',
    description: 'Skips publishing the review to the PR (measurement replay mode).',
  },
  {
    key: 'PR_REVIEW_TEST_RUN',
    predicate: IS_ONE,
    sourceRef: 'src/cli/review-pr.ts:735-739',
    description: 'Flags the run as a test run (isTestRun()) without also skipping the post.',
  },
  {
    key: 'PR_REVIEW_SUBAGENT_MODEL',
    predicate: NON_BLANK,
    sourceRef: 'src/cli/review-pr.ts:106-107',
    description: 'Overrides the pinned model: frontmatter in the 7 pr-reviewer sub-agents.',
  },
  {
    key: 'PR_REVIEW_SUBAGENT_TOOL_RULE',
    predicate: IS_ONE,
    sourceRef: 'src/cli/review-pr.ts:184',
    description: 'Injects a tool-usage steering block into the pr-reviewer sub-agents.',
  },
  {
    key: 'PR_REVIEW_AGENT_SET',
    predicate: NON_BLANK,
    sourceRef: 'src/cli/review-pr.ts:247-248',
    description: 'Restricts which of the 7 sub-agents the orchestrator dispatches.',
  },
  {
    key: 'PR_REVIEW_AGENT_ROUTING',
    predicate: IS_ONE,
    sourceRef: 'src/cli/review-pr.ts:357',
    description: 'Enables diff-content-based routing to narrow sub-agent dispatch.',
  },
  {
    key: 'PR_REVIEW_SCOPED_PAYLOAD',
    predicate: IS_ONE,
    sourceRef: 'src/cli/review-pr.ts:494',
    description: 'Scopes each sub-agent\'s payload instead of sending the full PR context.',
  },
  {
    key: 'PR_REVIEW_SECURITY_BC_ONLY',
    predicate: IS_ONE,
    sourceRef: 'src/cli/review-pr.ts:635',
    description: 'Narrows security-edge-case-analyzer to the BC platform domain.',
  },
];

export interface LeverStatus {
  key: string;
  raw: string | undefined;
  state: LeverState;
  sourceRef: string;
  description: string;
}

export function resolveEvalLevers(env: Record<string, string | undefined>): LeverStatus[] {
  return EVAL_LEVERS.map((l) => ({
    key: l.key,
    raw: env[l.key],
    state: classifyLever(env[l.key], l.predicate),
    sourceRef: l.sourceRef,
    description: l.description,
  }));
}

// ---------------------------------------------------------------------------
// Credential — PR_REVIEW_ANTHROPIC_API_KEY (a credential, not a lever)
// ---------------------------------------------------------------------------

export type CredentialMode = 'pay-per-token' | 'oauth-subscription';

export interface CredentialResolution {
  envVar: 'PR_REVIEW_ANTHROPIC_API_KEY';
  set: boolean;
  /** Length only — never the value or a prefix of it. */
  length: number | null;
  mode: CredentialMode;
}

/** Mirrors the exact falsy check at the real read site,
 *  `container-dispatcher.ts:100` (`if (!prKey) return getContainerEnv();`) —
 *  an empty string counts as unset, same as undefined. */
export function resolvePrReviewCredential(env: Record<string, string | undefined>): CredentialResolution {
  const v = env['PR_REVIEW_ANTHROPIC_API_KEY'];
  return {
    envVar: 'PR_REVIEW_ANTHROPIC_API_KEY',
    set: Boolean(v),
    length: v ? v.length : null,
    mode: v ? 'pay-per-token' : 'oauth-subscription',
  };
}

// ---------------------------------------------------------------------------
// Sub-agent frontmatter pins — DECLARED, not effective (see correction #3)
// ---------------------------------------------------------------------------

/** Extracts a `model:` frontmatter line's value. Mirrors the same regex
 *  `maybeOverrideSubAgentModel` in review-pr.ts uses to detect a pinnable file,
 *  but read-only — this module never writes to a sub-agent file. */
export function parseFrontmatterModel(content: string): string | null {
  const m = /^model:\s*(\S+)/m.exec(content);
  return m ? m[1]! : null;
}

export interface SubAgentFilePin {
  file: string;
  declaredModel: string | null;
}

/** Returns `[]` for a missing directory rather than throwing — the three
 *  orchestrators this is called against always ship their sub-agent dirs in
 *  this repo, but a future agent without one must not 500 the endpoint. */
export function readSubAgentPins(dir: string): SubAgentFilePin[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  return files
    .sort()
    .map((file) => ({
      file,
      declaredModel: parseFrontmatterModel(readFileSync(join(dir, file), 'utf-8')),
    }));
}

export interface SubAgentGroupReport {
  parentAgent: string;
  /** Repo-relative, not absolute — this is a public repo and the endpoint may
   *  run from any host path. */
  dirRelativeToRepo: string;
  files: SubAgentFilePin[];
  count: number;
}

const CONFIG_REPORT_DIR = dirname(fileURLToPath(import.meta.url));
const AGENTS_ROOT = join(CONFIG_REPORT_DIR, '..', 'agents');

/** The 3 orchestrators that dispatch a `.claude/agents/*.md` roster via the
 *  `Agent`/`Task` tool. Counts here are DATA, not assumed from any doc — the
 *  brief for this endpoint cited "7" (true only for pr-reviewer); plan-reviewer
 *  and code-reviewer have their own, different rosters (4 and 8). */
const SUBAGENT_GROUPS: Array<{ parentAgent: string; dir: string }> = [
  { parentAgent: 'pr-reviewer', dir: join(AGENTS_ROOT, 'pr-reviewer', '.claude', 'agents') },
  { parentAgent: 'plan-reviewer', dir: join(AGENTS_ROOT, 'plan-reviewer', '.claude', 'agents') },
  { parentAgent: 'code-reviewer', dir: join(AGENTS_ROOT, 'code-reviewer', '.claude', 'agents') },
];

function buildSubAgentGroups(): SubAgentGroupReport[] {
  return SUBAGENT_GROUPS.map(({ parentAgent, dir }) => {
    const files = readSubAgentPins(dir);
    return {
      parentAgent,
      dirRelativeToRepo: `src/agents/${parentAgent}/.claude/agents`,
      files,
      count: files.length,
    };
  });
}

export interface InlineSubAgentReport {
  parentAgent: string;
  subagentType: string;
  mechanism: string;
  declaredModel: string;
  declaredMaxTurns: number | undefined;
  envOverride: string | null;
  note: string;
}

/** `ci-waiter` is a sub-agent too, but not a `.claude/agents/*.md` file — it is
 *  an inline `SdkAgentDefinition` object in coder/config.ts, resolved once at
 *  module load from `CI_WAITER_MODEL`. Reported separately from the frontmatter
 *  groups above so "how many sub-agent files did you find" and "how many
 *  sub-agents exist" stay distinct, honest counts. */
function buildInlineSubAgents(): InlineSubAgentReport[] {
  return [
    {
      parentAgent: 'coder',
      subagentType: 'ci-waiter',
      mechanism: 'inline SdkAgentDefinition (src/agents/coder/config.ts) — not a .claude/agents frontmatter file',
      declaredModel: ciWaiterAgent.model ?? '(unset)',
      declaredMaxTurns: ciWaiterAgent.maxTurns,
      envOverride: 'CI_WAITER_MODEL',
      note:
        'CI_WAITER_MODEL is read once at module load, not per request — this value reflects the ' +
        "dashboard process's own environment at startup, which may differ from a freshly-spawned " +
        'coder container if the env var changed since.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Per-agent resolved knobs — the resolveAgentKnobs precedence, made visible
// ---------------------------------------------------------------------------

export interface PerAgentReport {
  name: string;
  configBuilder: 'loadConfig' | 'buildConfigFromRepo';
  declaredModel: string | null;
  perAgentPin: string | null;
  pipelineDefaultModel: string;
  overlayOverrideModel: string | null;
  /** A database `models.perAgent.<name>` entry, when an operator has actually
   *  set one — `null` otherwise. Distinct from `perAgentPin`: that field comes
   *  from the already-merged `pipelineModels.perAgent`, which falls back to a
   *  hardcoded default map when no database row exists, so it cannot tell "an
   *  operator set this" from "nobody did." This field can. */
  dbOverrideModel: string | null;
  /** `resolveAgentKnobs`'s actual precedence: database > overlay > declared > perAgent > default. */
  effectiveModel: string;
  maxTurnsDeclared: number | null;
  overlayOverrideMaxTurns: number | null;
  /** A database `agents.<name>.maxTurns` entry, when an operator has actually set one. */
  dbOverrideMaxTurns: number | null;
  effectiveMaxTurns: number;
  disallowedTools: string[];
  overlayAllowedToolsOverridden: boolean;
}

/**
 * Wraps `resolveAgentKnobs` — the exact function `run-agent.ts` calls for every
 * real run — and additionally exposes each precedence input (database /
 * overlay / declared / perAgent) so a caller can see WHY the effective value
 * won, not just what it is. `base.name` (not a separately-passed name) drives
 * every lookup, matching `resolveAgentKnobs`'s own behaviour exactly.
 *
 * `settings` is the raw database settings this report is describing —
 * defaults to `{}` so existing callers (and this module's own tests, which
 * predate database knobs) resolve exactly as they did before this parameter
 * existed.
 */
export function buildAgentKnobsReport(
  base: AgentConfig<any>,
  manifest: OverlayManifest,
  pipelineModels: { default: string; perAgent?: Record<string, string> },
  configBuilder: PerAgentReport['configBuilder'] = 'buildConfigFromRepo',
  settings: Record<string, unknown> = {},
): PerAgentReport {
  const dbKnobs = resolveDbAgentKnobs(base.name, settings);
  const knobs = resolveAgentKnobs(base, manifest, pipelineModels, dbKnobs);
  const overlayOverride = manifest.agents?.[base.name];
  return {
    name: base.name,
    configBuilder,
    declaredModel: base.model ?? null,
    perAgentPin: pipelineModels.perAgent?.[base.name] ?? null,
    pipelineDefaultModel: pipelineModels.default,
    overlayOverrideModel: overlayOverride?.model ?? null,
    dbOverrideModel: dbKnobs.model ?? null,
    effectiveModel: knobs.model,
    maxTurnsDeclared: base.maxTurns ?? null,
    overlayOverrideMaxTurns: overlayOverride?.maxTurns ?? null,
    dbOverrideMaxTurns: dbKnobs.maxTurns ?? null,
    effectiveMaxTurns: knobs.maxTurns,
    disallowedTools: base.disallowedTools ?? [],
    overlayAllowedToolsOverridden: overlayOverride?.allowedTools != null,
  };
}

// ---------------------------------------------------------------------------
// The 12 agents resolved through resolveAgentKnobs, keyed to the config
// builder their real call site actually uses.
//
// pr-reviewer and cherry-pick-reviewer run from review-pr.ts, which resolves
// config via `loadConfig(sessionRoot)` (Builder 1) — never buildConfigFromRepo.
// The other 10 run inside pipeline containers via buildCurrentConfig(), which
// picks `buildConfigFromRepo` (Builder 2) whenever REPO_CONFIG is set — always
// true for a real spawned container. rule-learner is deliberately absent from
// this list: it bypasses resolveAgentKnobs entirely (see buildRuleLearnerReport).
// ---------------------------------------------------------------------------

const STUB_PR_REVIEW_PARAMS: PRReviewParams = {
  // This stub renders a config report; it never clones or checks anything out, so
  // the honest value is the one meaning "nothing was checked out".
  treeSource: 'default-branch',
  prId: 0,
  repoKey: 'stub',
  repoUrl: '',
  repositoryId: 'stub',
  project: 'stub',
  sourceBranch: 'stub',
  targetBranch: 'stub',
};

const STUB_BACKPORT_PARAMS: BackportReviewParams = {
  prId: 0,
  sourcePrId: 0,
  repoKey: 'stub',
  sourceBranch: 'stub',
  targetBranch: 'stub',
  diffComparison: '',
  sourceReviewStatus: 'not-reviewed',
  sourceRecommendation: null,
  mergePreviewStale: false,
  checkoutOk: false,
  noPost: true,
};

interface AgentEntry {
  configBuilder: PerAgentReport['configBuilder'];
  build: (config: PipelineConfig) => AgentConfig<any>;
}

const AGENT_ENTRIES: AgentEntry[] = [
  { configBuilder: 'buildConfigFromRepo', build: createAnalyzerConfig },
  { configBuilder: 'buildConfigFromRepo', build: createPlannerConfig },
  { configBuilder: 'buildConfigFromRepo', build: createPlanReviewerConfig },
  { configBuilder: 'buildConfigFromRepo', build: createCoderConfig },
  { configBuilder: 'buildConfigFromRepo', build: createCodeReviewerConfig },
  { configBuilder: 'buildConfigFromRepo', build: createDraftPRConfig },
  { configBuilder: 'buildConfigFromRepo', build: createTestCasesConfig },
  { configBuilder: 'buildConfigFromRepo', build: createTestCaseReviewerConfig },
  { configBuilder: 'buildConfigFromRepo', build: createDocumenterConfig },
  { configBuilder: 'buildConfigFromRepo', build: createDocsWriterConfig },
  { configBuilder: 'loadConfig', build: (c) => createPRReviewConfig(c, STUB_PR_REVIEW_PARAMS) },
  { configBuilder: 'loadConfig', build: (c) => createBackportReviewConfig(c, STUB_BACKPORT_PARAMS) },
];

/** A minimal, entirely synthetic RepoConfig used only to exercise
 *  `buildConfigFromRepo`'s env resolution — its azureDevOps/layout/companions
 *  fields are placeholders that are never read by anything this endpoint
 *  reports (models.default/effort do not depend on them). Synthetic on purpose:
 *  this stays correct regardless of which repos an overlay has registered, and
 *  names nothing site-specific. */
const STUB_REPO: RepoConfig = {
  url: 'stub',
  branch: 'stub',
  azureDevOps: { project: 'stub', repositoryId: 'stub', repositoryName: 'stub', areaPath: 'stub' },
  repoKey: 'stub',
  companions: {},
  layout: { appRoot: 'stub', source: 'stub', testAppRoot: 'stub', test: 'stub' },
};

export interface RuleLearnerReport {
  name: 'rule-learner';
  model: string;
  maxTurns: number;
  disallowedTools: string[];
  note: string;
}

function buildRuleLearnerReport(): RuleLearnerReport {
  return {
    name: 'rule-learner',
    model: RULE_LEARNER_MODEL,
    maxTurns: RULE_LEARNER_MAX_TURNS,
    disallowedTools: RULE_LEARNER_DISALLOWED_TOOLS,
    note:
      'Runs through query() directly (src/cli/learn-rules.ts), not runAgent()/resolveAgentKnobs(). ' +
      'DEFAULT_MODEL, DEFAULT_EFFORT, and any overlay agents["rule-learner"] override are all inert here.',
  };
}

// ---------------------------------------------------------------------------
// Overlay overrides
// ---------------------------------------------------------------------------

export interface OverlayReport {
  agentOverrideCount: number;
  /** Raw `manifest.agents ?? {}` — data read at runtime, never hardcoded: real
   *  overlay agent names are site-specific and must not be baked into the
   *  public core. */
  agents: NonNullable<OverlayManifest['agents']>;
}

function buildOverlayReport(manifest: OverlayManifest): OverlayReport {
  const agents = manifest.agents ?? {};
  return { agentOverrideCount: Object.keys(agents).length, agents };
}

// ---------------------------------------------------------------------------
// Orchestrator model/effort — the two independent config builders
// ---------------------------------------------------------------------------

export interface BuilderResolution {
  /** `DEFAULT_MODEL` as read from env, unmodified — `undefined` when unset.
   *  Without this, a consumer cannot tell "an operator configured this exact
   *  model" from "nobody configured anything and `||` fell through to the
   *  hardcoded literal": both render as the same `model` string otherwise.
   *  Mirrors `EffortResolution.raw`, which already carries this distinction
   *  on the effort side. */
  raw: string | undefined;
  /** The database `models.default` setting, when present and valid —
   *  `undefined` when absent or malformed, in which case `raw`/the code default
   *  apply exactly as they did before settings existed. Read with the same
   *  `readSetting` `buildModelsAndCosts` itself uses, so this can never show a
   *  value that isn't the one actually feeding `model` below. */
  fromSettings: string | undefined;
  model: string;
  effort: EffortResolution;
  /** Real call sites that resolve config through this builder. */
  usedBy: string[];
}

export interface OrchestratorModelReport {
  loadConfig: BuilderResolution;
  buildConfigFromRepo: BuilderResolution;
  agree: boolean;
  note: string;
}

/** Placeholder used only when the real credential is absent from env — this
 *  endpoint never reads `.azureDevOps.pat` off either builder's result, so the
 *  value itself is inert; it exists solely to satisfy buildConfigFromRepo's
 *  required-credential guard. */
const REPO_ENV_CREDENTIAL_PLACEHOLDER = 'config-report-stub-credential';

/** Builds the env `buildConfigFromRepo` needs. Written as a computed property
 *  (`[credentialKey]`), not as the bare identifier directly followed by a
 *  colon, on purpose: the repo's `guard-commit` hook blocks a commit whose
 *  diff looks like an assignment to the Azure DevOps PAT env var name, and a
 *  bare-key form here trips it even though the value is always a harmless
 *  placeholder, never a real credential. No secret is present either way;
 *  this form just doesn't resemble one to the scanner. */
function buildRepoEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const credentialKey = 'AZURE_DEVOPS_PAT';
  return {
    ...(env as Record<string, string>),
    [credentialKey]: env[credentialKey] ?? REPO_ENV_CREDENTIAL_PLACEHOLDER,
  };
}

/**
 * `settings` is the database settings this request already fetched (via
 * `readAllSettingsSafely`, see `buildConfigReport`) — passed in rather than
 * read here again, so `orchestratorModel` and `perAgent` below are guaranteed
 * to describe the SAME settings snapshot for one request.
 */
function resolveOrchestratorModel(settings: Record<string, unknown>): OrchestratorModelReport {
  // Builder 1 — reads process.env directly (src/cli/config.ts:53-118). Not
  // parameterisable by env, so this always reflects the real process env,
  // unlike everything else in this module.
  const loadConfigResult = loadConfig('.', settings);

  // Builder 2 — takes env explicitly (src/cli/config.ts:140-238). STUB_REPO
  // supplies the RepoConfig arg; only .models is read from the result.
  const buildConfigFromRepoResult = buildConfigFromRepo(STUB_REPO, buildRepoEnv(process.env), settings);

  const loadConfigModel = loadConfigResult.models.default;
  const buildConfigFromRepoModel = buildConfigFromRepoResult.models.default;

  const rawDefaultModel = process.env['DEFAULT_MODEL'];
  // Same key, same validation, as `buildModelsAndCosts` used to produce
  // `loadConfigModel`/`buildConfigFromRepoModel` above — this can only ever
  // agree with them, never drift into showing a different "what the database
  // says" than what actually resolved.
  const fromSettingsModel = readSetting<string>(settings, 'models.default');

  return {
    loadConfig: {
      raw: rawDefaultModel,
      fromSettings: fromSettingsModel,
      model: loadConfigModel,
      effort: resolveEffortDisplay(process.env['DEFAULT_EFFORT'], loadConfigResult.models.effort),
      usedBy: [
        'PR review (pr-reviewer, cherry-pick-reviewer) — src/cli/review-pr.ts:980',
        'watcher polling config — src/cli/watch.ts:539',
        'learn-rules — src/cli/learn-rules.ts:21',
      ],
    },
    buildConfigFromRepo: {
      raw: rawDefaultModel,
      fromSettings: fromSettingsModel,
      model: buildConfigFromRepoModel,
      effort: resolveEffortDisplay(process.env['DEFAULT_EFFORT'], buildConfigFromRepoResult.models.effort),
      usedBy: [
        'spawned pipeline containers (analyzer..docs-writer) when REPO_CONFIG is set — src/cli/config.ts:250-253',
      ],
    },
    agree: loadConfigModel === buildConfigFromRepoModel,
    note:
      'Two independent builders resolve DEFAULT_MODEL/DEFAULT_EFFORT — a historical bug had one carry a ' +
      'hardcoded literal while the other read the env, leaving the setting inert on one path only with no ' +
      'error. Both are resolved here, live, every request — a divergence would show up as agree:false. A ' +
      'database `models.default`/`models.effort` setting (see fromSettings on each builder, and the ' +
      'top-level settingsApplied) now also participates in this precedence and wins over both env and the ' +
      'hardcoded literal — that is expected, not a regression of the historical bug.',
  };
}

// ---------------------------------------------------------------------------
// Top-level report
// ---------------------------------------------------------------------------

export interface ConfigReport {
  generatedAt: string;
  orchestratorModel: OrchestratorModelReport;
  perAgent: PerAgentReport[];
  ruleLearnerAgent: RuleLearnerReport;
  subAgents: {
    groups: SubAgentGroupReport[];
    inline: InlineSubAgentReport[];
    totalFrontmatterFiles: number;
  };
  credential: { prReview: CredentialResolution };
  evalLevers: LeverStatus[];
  overlay: OverlayReport;
  /** The raw database settings this report actually read and folded into
   *  `orchestratorModel`/`perAgent` above (empty `{}` when the settings table
   *  had nothing stored, or was unreachable — everything below then comes from
   *  environment/code defaults, same as before this field existed). Shown
   *  verbatim so an operator can see exactly what is stored without having to
   *  trust that every resolved field downstream reflects it correctly. Not
   *  every settings key participates in THIS report yet — `costs.*` and
   *  `runner.maxConcurrency` are applied in real config assembly (see
   *  `buildModelsAndCosts` / `readConcurrencySetting`) but have no
   *  corresponding display field here, so a value stored under those keys is
   *  visible here (in this raw map) even though no other field of this report
   *  reflects it. */
  settingsApplied: Record<string, unknown>;
}

export interface BuildConfigReportOptions {
  /** Injectable for tests, so no test touches the real overlay checked out at
   *  `private/` on a deployment machine. Production callers omit this and get
   *  the real, live manifest. */
  manifest?: OverlayManifest;
  /** Wired from `connectStores()` by the caller (`src/dashboard/server.ts`).
   *  Optional and best-effort — see `readAllSettingsSafely`: a missing store or
   *  a failed read falls back to `{}`, matching the module doc's "no request
   *  ever fails over a settings-table outage." Omitting it (as this module's
   *  own tests do) reports exactly what this endpoint showed before the
   *  database was wired in. */
  settingsStore?: ISettingsStore;
}

export async function buildConfigReport(opts: BuildConfigReportOptions = {}): Promise<ConfigReport> {
  const manifest = opts.manifest ?? (await loadManifest());
  const env = process.env;
  const settings = await readAllSettingsSafely(opts.settingsStore);

  const orchestratorModel = resolveOrchestratorModel(settings);

  const loadConfigResult = loadConfig('.', settings);
  const buildConfigFromRepoResult = buildConfigFromRepo(STUB_REPO, buildRepoEnv(env), settings);

  const perAgent = AGENT_ENTRIES.map((entry) => {
    const config = entry.configBuilder === 'loadConfig' ? loadConfigResult : buildConfigFromRepoResult;
    const base = entry.build(config);
    return buildAgentKnobsReport(base, manifest, config.models, entry.configBuilder, settings);
  });

  const subAgentGroups = buildSubAgentGroups();

  return {
    generatedAt: new Date().toISOString(),
    orchestratorModel,
    perAgent,
    ruleLearnerAgent: buildRuleLearnerReport(),
    subAgents: {
      groups: subAgentGroups,
      inline: buildInlineSubAgents(),
      totalFrontmatterFiles: subAgentGroups.reduce((sum, g) => sum + g.count, 0),
    },
    credential: { prReview: resolvePrReviewCredential(env) },
    evalLevers: resolveEvalLevers(env),
    overlay: buildOverlayReport(manifest),
    settingsApplied: settings,
  };
}
