import { useState } from 'preact/hooks';
import { configReport, buildPanelHref, navigateToPanel } from '../stats-store.ts';
import type { FetchState } from '../stats-store.ts';
import type {
  ConfigReport, BuilderResolution, EffortResolution, PerAgentReport, LeverStatus,
  CredentialResolution, SubAgentGroupReport, InlineSubAgentReport, RuleLearnerReport, OverlayReport,
} from '../../config-report.ts';
import { assessLevers } from '../assessors.ts';
import type { PanelSectionStatuses } from '../assessors.ts';
import { getRouteParams } from '../url-route.ts';
import { countOf } from '../../count-phrase.ts';

// ---------------------------------------------------------------------------
// Config panel (Task 7) — "what settings are actually in effect right now."
// Replaces the stats-slot-config placeholder (Task 4), keeping the same
// outer `stats-slot stats-slot--{status}` wrapper and header so the
// loading/error border-colour CSS carries over unchanged, matching Task 6's
// precedent in stats-integrity.tsx.
//
// Unlike every other Stats & Config panel, `/api/config` is NOT windowed
// (see task-4-report.md) — there is no `window` prop here, and the body
// shows `generatedAt` instead of a window badge so the reader sees this is a
// live snapshot rather than a scoped statistic (design-constraints.md: never
// give unwindowed data a window badge implying otherwise).
//
// Collapsed by default. The one-line collapsed summary (`ConfigHeadline`) is
// the most-read text on this panel — a reader may never expand it — so it
// must not let an UNCONFIGURED fallback read as a deliberate choice. The two
// config builders (`loadConfig`/`buildConfigFromRepo`) are resolved
// independently server-side and compared via `orchestratorModel.agree`; a
// disagreement is a real, previously-seen bug class (one path silently
// carrying a stale/hardcoded value while the other reads the env), so it is
// surfaced in the collapsed summary itself, not buried in the expanded body.
//
// Every section below is `--neutral` (this is a report of what's DECLARED
// and RESOLVED, not a pass/fail measurement) except the two that genuinely
// have a right/wrong answer: the builder comparison (`--attention` only on
// disagreement) and eval levers (`--attention` when any lever that should be
// off in production is active). `--color-accent` is spent nowhere else.
//
// Mono is reserved for identifiers — model ids, env var names, file names,
// tool names — never for prose words ("none declared", "→", "fallback").
// Where a value can differ from its declared/base value (per-agent model,
// max turns), both the declared value and the effective one render, each in
// their own <code>, and are shown side by side ONLY when they differ
// (`DvE`/`compareDeclaredVsEffective`) — showing "X → X" when nothing
// changed would just be noise.
// ---------------------------------------------------------------------------

export type ConfigSectionStatus = 'ok' | 'attention' | 'neutral';

// ---------------------------------------------------------------------------
// Pure logic — unit-tested with fixture data, no rendering, no network.
// ---------------------------------------------------------------------------

export type ModelConfigState = 'unset' | 'empty' | 'configured';

/** `DEFAULT_MODEL || 'claude-opus-5'` has THREE distinct input states, not
 *  two: fully unset, explicitly set to an empty string (both fall through to
 *  the hardcoded literal, but are different facts about the deployment), and
 *  a real configured value. Collapsing unset/empty into one "not configured"
 *  bucket would still be honest; keeping them separate lets the two read
 *  differently in prose ("unset" vs "set to an empty string"). */
export function classifyModelConfigState(raw: string | undefined): ModelConfigState {
  if (raw === undefined) return 'unset';
  if (raw === '') return 'empty';
  return 'configured';
}

export interface ModelResolutionDescription {
  state: ModelConfigState;
  /** The identifier to render in --font-mono. */
  model: string;
  /** Prose annotation — empty string when the value is a genuine configured
   *  choice and needs no qualifier (matches the house convention elsewhere
   *  in this tab: a tag/qualifier only appears for the exceptional case). */
  qualifier: string;
}

export function describeModelResolution(b: BuilderResolution): ModelResolutionDescription {
  const state = classifyModelConfigState(b.raw);
  const qualifier =
    state === 'unset' ? 'fallback — DEFAULT_MODEL unset' :
    state === 'empty' ? 'fallback — DEFAULT_MODEL set to an empty string' :
    '';
  return { state, model: b.model, qualifier };
}

export type EffortConfigState = 'unset' | 'empty' | 'invalid' | 'configured';

/** `parseEffort` returns `undefined` for unset, blank, AND unrecognised
 *  values alike (see its jsdoc in cli/config.ts) — all three fall back to
 *  the SDK's own default. This function keeps those three apart in prose,
 *  the same way `classifyModelConfigState` keeps unset apart from empty:
 *  "DEFAULT_EFFORT not set" and `DEFAULT_EFFORT="bogus" not recognised` are
 *  different facts even though both leave the SDK default in effect. */
export function classifyEffortConfigState(e: EffortResolution): EffortConfigState {
  if (e.raw === undefined) return 'unset';
  if (e.raw === '') return 'empty';
  if (e.parsed === undefined) return 'invalid';
  return 'configured';
}

export interface EffortResolutionDescription {
  state: EffortConfigState;
  effective: string;
  qualifier: string;
}

export function describeEffortResolution(e: EffortResolution): EffortResolutionDescription {
  const state = classifyEffortConfigState(e);
  const qualifier =
    state === 'unset' ? 'SDK default — DEFAULT_EFFORT unset' :
    state === 'empty' ? 'SDK default — DEFAULT_EFFORT set to an empty string' :
    state === 'invalid' ? `SDK default — DEFAULT_EFFORT="${e.raw}" not recognised` :
    '';
  return { state, effective: e.effective, qualifier };
}

export interface ConfigHeadlineSegment {
  /** Identifier to render in --font-mono. */
  mono: string;
  /** Empty when the value needs no qualifier (a genuine configured choice). */
  qualifier: string;
}

export interface ConfigHeadlineSummary {
  attention: boolean;
  /** Set only when `attention` is true — the two builders disagree. Carries
   *  both resolved models so the collapsed summary can name the split
   *  without a reader having to expand the panel first. */
  disagreement: { loadModel: string; repoModel: string } | null;
  model: ConfigHeadlineSegment;
  effort: ConfigHeadlineSegment;
}

/**
 * The single most-read text in this feature (see task-7-brief.md). Always
 * describes `loadConfig`'s resolution (the builder PR review and the
 * watcher actually run through) for the model/effort segments — but when
 * the two builders disagree, that fact is promoted into `disagreement` and
 * rendered FIRST, ahead of the model/effort segments, so it cannot be
 * missed by a reader who never expands the panel. Pure — exported for unit
 * testing.
 */
export function buildConfigHeadlineSummary(report: ConfigReport): ConfigHeadlineSummary {
  const { orchestratorModel } = report;
  const modelDesc = describeModelResolution(orchestratorModel.loadConfig);
  const effortDesc = describeEffortResolution(orchestratorModel.loadConfig.effort);
  return {
    attention: !orchestratorModel.agree,
    disagreement: orchestratorModel.agree
      ? null
      : { loadModel: orchestratorModel.loadConfig.model, repoModel: orchestratorModel.buildConfigFromRepo.model },
    model: { mono: modelDesc.model, qualifier: modelDesc.qualifier },
    effort: { mono: effortDesc.effective, qualifier: effortDesc.qualifier },
  };
}

export interface DeclaredVsEffective {
  declared: string | number | null;
  effective: string | number;
  /** True when the declared and effective values differ (or nothing was
   *  declared at all) — the caller renders BOTH values only in that case,
   *  per the brief ("declared vs effective side by side when they differ"). */
  differs: boolean;
}

export function compareDeclaredVsEffective(declared: string | number | null, effective: string | number): DeclaredVsEffective {
  const differs = declared == null || String(declared) !== String(effective);
  return { declared, effective, differs };
}

export interface OverlayOverrideSummary {
  model: string | null;
  maxTurns: number | null;
  toolsOverridden: boolean;
}

export function buildOverlayOverrideSummary(a: PerAgentReport): OverlayOverrideSummary {
  return { model: a.overlayOverrideModel, maxTurns: a.overlayOverrideMaxTurns, toolsOverridden: a.overlayAllowedToolsOverridden };
}

export interface PerAgentRowView {
  name: string;
  configBuilder: PerAgentReport['configBuilder'];
  model: DeclaredVsEffective;
  maxTurns: DeclaredVsEffective;
  disallowedTools: string[];
  overlay: OverlayOverrideSummary;
}

export function buildPerAgentRow(a: PerAgentReport): PerAgentRowView {
  return {
    name: a.name,
    configBuilder: a.configBuilder,
    model: compareDeclaredVsEffective(a.declaredModel, a.effectiveModel),
    maxTurns: compareDeclaredVsEffective(a.maxTurnsDeclared, a.effectiveMaxTurns),
    disallowedTools: a.disallowedTools,
    overlay: buildOverlayOverrideSummary(a),
  };
}

/** Mirrors the exact falsy check `resolvePrReviewCredential` already applied
 *  server-side — this is prose on top of an already-computed value, never a
 *  second judgment of set/unset. Never renders the credential itself or a
 *  prefix of it, only its length, per the brief's "a length is the maximum
 *  detail" instruction. The billing consequence is said in words, not as the
 *  server's `mode` enum value — `mode: oauth-subscription` was exactly the
 *  `said = 'rejected-wrong'` shape the house writing rule forbids. */
export function describeCredential(c: CredentialResolution): string {
  if (!c.set) return 'Not set — reviews run on the Claude subscription login instead of a per-token API key.';
  return `Set (${c.length} character${c.length === 1 ? '' : 's'}) — reviews bill per token through this key.`;
}

/**
 * The one sentence on this panel that must not be "simplified" into a lie
 * (readability review §5): `allowedTools` is an AUTO-APPROVE list, not an
 * availability restriction. Agents run with the permission layer bypassed
 * (`runAgent` passes `permissionMode: 'bypassPermissions'`), so a tool left
 * off the list stays fully callable — telemetry has recorded an agent calling
 * a tool it never listed. Only `disallowedTools` removes a tool. A shorter
 * "tools overridden" would claim the override changes what the agent can use;
 * it does not. Rendered wherever the override phrase appears (the per-agent
 * table and the overlay table), from this one constant so the two cannot
 * drift apart.
 */
export const AUTO_APPROVE_OVERRIDE_NOTE =
  'An auto-approve override changes which tool calls are approved to run without asking first — it '
  + 'does not change which tools the agent can use. A tool left off the list stays callable; only a '
  + 'tool in the disallowed list is removed.';

export interface LeverRowView {
  stateText: string;
  rowClass: string;
}

/** Word + row tint for each of the three `LeverState` values — colour is
 *  never the only signal here, `stateText` always says the same thing in
 *  words the row tint (or lack of one) conveys. */
export function describeLeverRow(l: LeverStatus): LeverRowView {
  switch (l.state) {
    case 'active':
      return { stateText: 'active', rowClass: 'config-table__row--active' };
    case 'present-but-inert':
      return { stateText: 'present, but inert', rowClass: 'config-table__row--inert' };
    case 'absent':
      return { stateText: 'not set', rowClass: '' };
  }
}

// ---------------------------------------------------------------------------
// Panel-level view — one FetchState in, one thing to render out. Mirrors
// `buildIntegrityPanelView`'s shape (stats-integrity.tsx) and
// `buildDriftCard`'s exhaustive-switch precedent (stats-ribbon.tsx) for the
// unreachable 'empty' branch: `loadConfigReport()` (stats-store.ts) never
// produces `'empty'` for `/api/config` — there is no sampleSize/window
// concept for a config snapshot to be empty of — but the branch is kept so
// an added `FetchState` variant fails to typecheck here instead of silently
// falling through to a blank panel.
// ---------------------------------------------------------------------------

export interface ConfigPanelView {
  status: 'loading' | 'error' | 'empty' | 'ready';
  message: string | null;
  report: ConfigReport | null;
}

export function buildConfigPanelView(state: FetchState<ConfigReport>): ConfigPanelView {
  switch (state.status) {
    case 'loading':
      return { status: 'loading', message: 'Loading…', report: null };
    case 'error':
      return { status: 'error', message: `Failed to load: ${state.message}`, report: null };
    case 'empty':
      return { status: 'empty', message: 'No data recorded in this window.', report: null };
    case 'ready':
      return { status: 'ready', message: null, report: state.data };
  }
}

/** The builder-comparison section's status — the "config may be inert" bug
 *  class this tab was built after. One function, two consumers
 *  (`BuilderComparisonSection`'s JSX and `configSectionStatuses`), so the
 *  Config badge counts exactly what the section draws. */
export function builderComparisonSectionStatus(agree: boolean): ConfigSectionStatus {
  return agree ? 'ok' : 'attention';
}

/** The eval-levers section's status — wraps the shared `assessLevers`
 *  verdict the section's own summary line renders. Same two-consumer
 *  contract as `builderComparisonSectionStatus`. */
export function evalLeversSectionStatus(levers: LeverStatus[]): ConfigSectionStatus {
  return assessLevers(levers).severity === 'attention' ? 'attention' : 'ok';
}

/**
 * This panel's contribution to the Config section badge (see
 * `attentionBySection` in stats-view.tsx): the statuses of the seven
 * sections `ConfigPanelBody` renders, IN RENDER ORDER, the two scored ones
 * computed by the same functions their sections render with — so a builder
 * disagreement or an active eval lever is visible on the Config button while
 * an operator sits on another section. The `'neutral'` entries mirror the
 * literal `status="neutral"` the corresponding sections hard-code; keep this
 * list in lockstep with `ConfigPanelBody`. `null` while the fetch is in
 * flight; a settled non-ready panel renders no sections and contributes an
 * empty list (see `PanelSectionStatuses`, assessors.ts).
 */
export function configSectionStatuses(state: FetchState<ConfigReport>): PanelSectionStatuses {
  const view = buildConfigPanelView(state);
  if (view.status === 'loading') return null;
  if (view.status !== 'ready') return [];
  const r = view.report!;
  return [
    builderComparisonSectionStatus(r.orchestratorModel.agree), // Orchestrator model & effort — two independent readings
    'neutral',                                                 // Pull-request review credential
    'neutral',                                                 // rule-learner
    'neutral',                                                 // Per-agent settings, as actually resolved
    'neutral',                                                 // Sub-agent frontmatter pins
    evalLeversSectionStatus(r.evalLevers),                     // Eval levers
    'neutral',                                                 // Overlay agent overrides
  ];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function ConfigSection({ title, status, badge, children }: {
  title: string;
  status: ConfigSectionStatus;
  /** A short badge next to the title, e.g. "Bypasses config" — mirrors
   *  stats-integrity.tsx's "Inferred" badge convention: a distinct
   *  classification gets a badge in the header, not a colour change. */
  badge?: string;
  // Matches the existing `children: any` convention (stats-integrity.tsx,
  // agent-output-tabs.tsx) rather than introducing a stricter preact type
  // not used elsewhere.
  children: any;
}) {
  return (
    <div class={`config-section config-section--${status}`}>
      <div class="config-section__header">
        <h4 class="config-section__title">{title}</h4>
        {badge && <span class="config-section__badge">{badge}</span>}
      </div>
      <div class="config-section__body">{children}</div>
    </div>
  );
}

/** A value that IS declared/effective but currently has none declared (a
 *  per-agent config with no hardcoded model, an overlay with no override)
 *  renders as this italic word, never as a blank cell — constraint #3
 *  ("never render a non-value as a value"), applied to this panel's own
 *  non-value case. */
function NoneValue({ text = 'none' }: { text?: string }) {
  return <span class="config-table__none">{text}</span>;
}

function DvE({ cmp }: { cmp: DeclaredVsEffective }) {
  if (!cmp.differs) return <code class="config-mono">{cmp.effective}</code>;
  return (
    <>
      {cmp.declared == null ? <NoneValue text="none declared" /> : <code class="config-mono">{cmp.declared}</code>}
      {' → '}
      <code class="config-mono">{cmp.effective}</code>
    </>
  );
}

function ToolList({ tools }: { tools: string[] }) {
  if (tools.length === 0) return <NoneValue />;
  return (
    <>
      {tools.map((t, i) => (
        <span key={t}>
          <code class="config-mono">{t}</code>
          {i < tools.length - 1 ? ', ' : ''}
        </span>
      ))}
    </>
  );
}

function OverlayOverrideCell({ o }: { o: OverlayOverrideSummary }) {
  if (o.model == null && o.maxTurns == null && !o.toolsOverridden) {
    return <NoneValue text="no overlay override" />;
  }
  return (
    <>
      {o.model != null && (
        <>model: <code class="config-mono">{o.model}</code>{(o.maxTurns != null || o.toolsOverridden) ? ', ' : ''}</>
      )}
      {o.maxTurns != null && (
        <>maxTurns: {o.maxTurns}{o.toolsOverridden ? ', ' : ''}</>
      )}
      {/* NEVER shorten this to "tools overridden" — see AUTO_APPROVE_OVERRIDE_NOTE. */}
      {o.toolsOverridden && <>auto-approve list (<code class="config-mono">allowedTools</code>) overridden</>}
    </>
  );
}

function ModelResolutionValue({ b }: { b: BuilderResolution }) {
  const d = describeModelResolution(b);
  return (
    <>
      <code class="config-mono">{d.model}</code>
      {d.qualifier && <span class="config-panel__qualifier"> ({d.qualifier})</span>}
    </>
  );
}

function EffortResolutionValue({ e }: { e: EffortResolution }) {
  const d = describeEffortResolution(e);
  return (
    <>
      <code class="config-mono">{d.effective}</code>
      {d.qualifier && <span class="config-panel__qualifier"> ({d.qualifier})</span>}
    </>
  );
}

/** The one-line collapsed summary. `disagreement` (when set) renders FIRST
 *  and carries its own "Needs attention: " tag — see buildConfigHeadlineSummary.
 *  The two mono values carry the words "model" and "effort" in front of them
 *  (readability review §5, runner-up finding): without a noun, the most-read
 *  line on this panel was two unlabeled identifiers. The disagreement clause
 *  names the two resolution paths by role, not by function name — the model
 *  ids stay mono (they are billable artifacts), the internal function names
 *  do not reach the screen. */
function ConfigHeadline({ headline }: { headline: ConfigHeadlineSummary }) {
  return (
    <span class={`config-panel__summary ${headline.attention ? 'config-panel__summary--attention' : ''}`}>
      {headline.attention && headline.disagreement && (
        <>
          <strong class="config-tag config-tag--attention">Needs attention: </strong>
          {'two independent readings of the orchestrator model disagree — the path reviews actually run through resolved '}
          <code class="config-mono">{headline.disagreement.loadModel}</code>
          {', the repo-registry path resolved '}
          <code class="config-mono">{headline.disagreement.repoModel}</code>
          {'; one may be stale · '}
        </>
      )}
      {'model '}
      <code class="config-mono">{headline.model.mono}</code>
      {headline.model.qualifier && <span class="config-panel__qualifier"> ({headline.model.qualifier})</span>}
      {' · effort '}
      <code class="config-mono">{headline.effort.mono}</code>
      {headline.effort.qualifier && <span class="config-panel__qualifier"> ({headline.effort.qualifier})</span>}
    </span>
  );
}

// The two resolution paths are named by ROLE here, not by function name
// (readability review §3): `loadConfig` is the path reviews and the watcher
// actually run through, `buildConfigFromRepo` the path spawned pipeline
// containers reach through the repo registry. The function names live only in
// the TypeScript source, so they fail the artifact test — a reader of this
// card cannot act on them — while the roles say which side of a disagreement
// is whose.
function BuilderComparisonSection({ report }: { report: ConfigReport }) {
  const om = report.orchestratorModel;
  const status = builderComparisonSectionStatus(om.agree);
  return (
    <ConfigSection title="Orchestrator model &amp; effort — two independent readings" status={status}>
      <dl class="config-dl">
        <dt>Reviews' own path — model</dt>
        <dd><ModelResolutionValue b={om.loadConfig} /></dd>
        <dt>Reviews' own path — effort</dt>
        <dd><EffortResolutionValue e={om.loadConfig.effort} /></dd>
        <dt>Repo-registry path — model</dt>
        <dd><ModelResolutionValue b={om.buildConfigFromRepo} /></dd>
        <dt>Repo-registry path — effort</dt>
        <dd><EffortResolutionValue e={om.buildConfigFromRepo.effort} /></dd>
        <dt>Do the two readings agree?</dt>
        <dd>
          {om.agree ? 'yes' : (
            <>
              <strong class="config-tag config-tag--attention">Needs attention: </strong>
              no — these two paths resolved different config; one may be stale
            </>
          )}
        </dd>
      </dl>
      <p class="config-section__note">{om.note}</p>
    </ConfigSection>
  );
}

function CredentialSection({ credential }: { credential: ConfigReport['credential'] }) {
  const c = credential.prReview;
  return (
    <ConfigSection title="Pull-request review credential" status="neutral">
      <dl class="config-dl">
        <dt><code class="config-mono">{c.envVar}</code></dt>
        <dd>{describeCredential(c)}</dd>
      </dl>
    </ConfigSection>
  );
}

function RuleLearnerSection({ ruleLearner }: { ruleLearner: RuleLearnerReport }) {
  return (
    <ConfigSection title="rule-learner" status="neutral" badge="Bypasses config">
      <dl class="config-dl">
        <dt>Model</dt>
        <dd><code class="config-mono">{ruleLearner.model}</code></dd>
        <dt>Max turns</dt>
        <dd>{ruleLearner.maxTurns}</dd>
        <dt>Disallowed tools</dt>
        <dd><ToolList tools={ruleLearner.disallowedTools} /></dd>
      </dl>
      <p class="config-section__note">{ruleLearner.note}</p>
    </ConfigSection>
  );
}

function PerAgentSection({ perAgent }: { perAgent: PerAgentReport[] }) {
  const rows = perAgent.map(buildPerAgentRow);
  return (
    <ConfigSection title={`Per-agent settings, as actually resolved (${countOf(rows.length, 'agent')})`} status="neutral">
      <table class="config-table">
        <thead>
          <tr><th>Agent</th><th>Builder</th><th>Model</th><th>Max turns</th><th>Disallowed tools</th><th>Overlay override</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td class="config-table__mono">{r.name}</td>
              <td>{r.configBuilder}</td>
              <td><DvE cmp={r.model} /></td>
              <td><DvE cmp={r.maxTurns} /></td>
              <td><ToolList tools={r.disallowedTools} /></td>
              <td><OverlayOverrideCell o={r.overlay} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="config-section__note">
        Model / max turns show "declared → effective" only when they differ — a single value means
        the setting in effect is exactly what the agent's own config declares.
      </p>
      {/* Definitional, so rendered only while the phrase it defines is on
          screen — an always-on methodology note would be noise on the common
          no-override day. */}
      {rows.some((r) => r.overlay.toolsOverridden) && (
        <p class="config-section__note">{AUTO_APPROVE_OVERRIDE_NOTE}</p>
      )}
    </ConfigSection>
  );
}

function SubAgentGroupTable({ group }: { group: SubAgentGroupReport }) {
  return (
    <div class="config-subagent-group">
      <h5 class="config-subagent-group__title">
        <code class="config-mono">{group.parentAgent}</code> — {group.count} file{group.count === 1 ? '' : 's'}
      </h5>
      {group.files.length === 0 ? (
        <p class="config-section__empty">No sub-agent frontmatter files found.</p>
      ) : (
        <table class="config-table">
          <thead><tr><th>File</th><th>Declared model</th></tr></thead>
          <tbody>
            {group.files.map((f) => (
              <tr key={f.file}>
                <td class="config-table__mono">{f.file}</td>
                <td>{f.declaredModel == null ? <NoneValue text="no model: line" /> : <code class="config-mono">{f.declaredModel}</code>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function InlineSubAgentBlock({ inline }: { inline: InlineSubAgentReport }) {
  return (
    <div class="config-subagent-group">
      <h5 class="config-subagent-group__title">
        <code class="config-mono">{inline.parentAgent}</code> → <code class="config-mono">{inline.subagentType}</code>
        {' '}(inline definition, not a frontmatter file)
      </h5>
      <dl class="config-dl">
        <dt>Model</dt>
        <dd><code class="config-mono">{inline.declaredModel}</code></dd>
        <dt>Max turns</dt>
        <dd>{inline.declaredMaxTurns ?? <NoneValue text="n/a" />}</dd>
        <dt>Env override</dt>
        <dd>{inline.envOverride ? <code class="config-mono">{inline.envOverride}</code> : <NoneValue />}</dd>
      </dl>
      <p class="config-section__note">{inline.note}</p>
    </div>
  );
}

// Rank #2 fix, readability review: this link used to be a plain
// `<a href="#stats-slot-integrity">` — dead, because Integrity is not in the
// DOM while Config is the active section, so a reader clicking it while
// verifying a model-contamination claim got nothing. `buildPanelHref`/
// `navigateToPanel` (stats-store.ts) make it a real link: a genuine href for
// middle-click/copy, and an `onClick` that switches to Health and scrolls
// there directly for the common in-page case.
function SubAgentPinsSection({ subAgents }: { subAgents: ConfigReport['subAgents'] }) {
  return (
    <ConfigSection title="Sub-agent frontmatter pins" status="neutral">
      <p class="config-section__summary">
        {subAgents.totalFrontmatterFiles} frontmatter file{subAgents.totalFrontmatterFiles === 1 ? '' : 's'} across{' '}
        {subAgents.groups.length} orchestrator{subAgents.groups.length === 1 ? '' : 's'}, plus {subAgents.inline.length}{' '}
        inline sub-agent definition{subAgents.inline.length === 1 ? '' : 's'}.
      </p>
      {subAgents.groups.map((g) => <SubAgentGroupTable key={g.parentAgent} group={g} />)}
      {subAgents.inline.map((i) => <InlineSubAgentBlock key={`${i.parentAgent}-${i.subagentType}`} inline={i} />)}
      <p class="config-section__note">
        <strong class="config-tag config-tag--caveat">Declared, not guaranteed: </strong>
        a <code class="config-mono">model:</code> frontmatter line is what a sub-agent SHOULD run on, not proof of what it
        DID run on. Pins are known to be silently ignored in production — see the{' '}
        <a
          class="config-section__link"
          href={buildPanelHref(getRouteParams(), 'health', 'stats-slot-integrity')}
          onClick={(e: MouseEvent) => { e.preventDefault(); navigateToPanel('health', 'stats-slot-integrity'); }}
        >
          Integrity panel's "Model contamination" section
        </a>{' '}
        for the observed-vs-declared cross-check.
      </p>
    </ConfigSection>
  );
}

function EvalLeversTable({ levers }: { levers: LeverStatus[] }) {
  return (
    <table class="config-table">
      <thead><tr><th>Lever</th><th>Raw value</th><th>State</th><th>Effect</th></tr></thead>
      <tbody>
        {levers.map((l) => {
          const row = describeLeverRow(l);
          return (
            <tr key={l.key} class={row.rowClass}>
              <td class="config-table__mono">{l.key}</td>
              <td>{l.raw === undefined ? <NoneValue text="unset" /> : <code class="config-mono">{JSON.stringify(l.raw)}</code>}</td>
              <td>{row.stateText}</td>
              <td>{l.description}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function EvalLeversSection({ levers }: { levers: LeverStatus[] }) {
  const a = assessLevers(levers);
  const status = evalLeversSectionStatus(levers);
  return (
    <ConfigSection title="Eval levers" status={status}>
      <p class="config-section__summary">
        {a.severity === 'attention' && <strong class="config-tag config-tag--attention">Needs attention: </strong>}
        {a.text}
      </p>
      <EvalLeversTable levers={levers} />
    </ConfigSection>
  );
}

function OverlaySection({ overlay }: { overlay: OverlayReport }) {
  const entries = Object.entries(overlay.agents);
  return (
    <ConfigSection title="Overlay agent overrides" status="neutral">
      <dl class="config-dl">
        <dt>Agents overridden</dt>
        <dd>{overlay.agentOverrideCount}</dd>
      </dl>
      {entries.length === 0 ? (
        <p class="config-section__empty">No overlay agent overrides in effect.</p>
      ) : (
        <>
          <table class="config-table">
            <thead><tr><th>Agent</th><th>Model override</th><th>Max turns override</th><th>Auto-approve list overridden</th></tr></thead>
            <tbody>
              {entries.map(([name, o]) => (
                <tr key={name}>
                  <td class="config-table__mono">{name}</td>
                  <td>{o.model ? <code class="config-mono">{o.model}</code> : <NoneValue text="no" />}</td>
                  <td>{o.maxTurns ?? <NoneValue text="no" />}</td>
                  <td>{o.allowedTools ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Same conditional-definition rule as PerAgentSection: the note
              renders only when a "yes" exists in the column it explains. */}
          {entries.some(([, o]) => Boolean(o.allowedTools)) && (
            <p class="config-section__note">{AUTO_APPROVE_OVERRIDE_NOTE}</p>
          )}
        </>
      )}
    </ConfigSection>
  );
}

/** Expanded by default. The original collapsed-by-default constraint
 *  (task-7-brief.md) belonged to the stacked layout, where Config was one of
 *  seven panels on a single page and collapsing kept the page short. Under
 *  the section switcher, Config is the only panel in its section — arriving
 *  here IS the request for the details, and a mandatory "Show details" click
 *  on every visit was the friction that prompted the change. The toggle
 *  stays for anyone who wants just the one-line headline. The summary row
 *  IS the disclosure control — a real `<button>` with `aria-expanded` /
 *  `aria-controls`, not a decorative chevron with no ARIA behind it. */
function ConfigPanelBody({ report }: { report: ConfigReport }) {
  const [expanded, setExpanded] = useState(true);
  const headline = buildConfigHeadlineSummary(report);
  return (
    <div class="config-panel">
      <button
        type="button"
        class="config-panel__toggle"
        aria-expanded={expanded}
        aria-controls="config-panel-body"
        onClick={() => setExpanded((v) => !v)}
      >
        <span class="config-panel__chevron" aria-hidden="true">▸</span>
        <ConfigHeadline headline={headline} />
        <span class="config-panel__toggle-label">{expanded ? 'Hide details' : 'Show details'}</span>
      </button>
      <div id="config-panel-body" class="config-panel__body" hidden={!expanded}>
        <p class="config-section__note config-panel__generated-at">
          Live snapshot, not scoped to a time window — generated {new Date(report.generatedAt).toLocaleString()}.
        </p>
        <BuilderComparisonSection report={report} />
        <CredentialSection credential={report.credential} />
        <RuleLearnerSection ruleLearner={report.ruleLearnerAgent} />
        <PerAgentSection perAgent={report.perAgent} />
        <SubAgentPinsSection subAgents={report.subAgents} />
        <EvalLeversSection levers={report.evalLevers} />
        <OverlaySection overlay={report.overlay} />
      </div>
    </div>
  );
}

/**
 * The Config panel — replaces the `stats-slot-config` placeholder
 * `<StatsSlot>` (Task 4) with the real body, keeping the same outer
 * `stats-slot stats-slot--{status}` wrapper and header markup so the
 * loading/error border-colour CSS carries over unchanged, matching Task 6's
 * precedent in `stats-integrity.tsx`. No `window` badge — `/api/config` is
 * unwindowed (task-4-report.md), so the omission itself is the signal,
 * exactly like `StatsRibbon`'s "Active levers" card.
 */
export function ConfigPanel() {
  const view = buildConfigPanelView(configReport.value);
  return (
    <section id="stats-slot-config" class={`stats-slot stats-slot--${view.status}`} aria-label="Config">
      <div class="stats-slot__header">
        <h3 class="stats-slot__title">Config</h3>
      </div>
      {view.status !== 'ready' ? (
        <p class={`stats-slot__status-text ${view.status === 'error' ? 'stats-slot__status-text--error' : ''}`}>
          {view.message}
        </p>
      ) : (
        <ConfigPanelBody report={view.report!} />
      )}
    </section>
  );
}
