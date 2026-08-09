import type { FetchState } from './stats-store.ts';
import type { SubAgentModelAttributionEntry } from '../stats.ts';
import type { ConfigReport } from '../config-report.ts';

// ---------------------------------------------------------------------------
// Model contamination — declared frontmatter pin vs observed model. Shared
// between stats-ribbon.tsx (the glance-level "Model integrity" card, fix
// round 2) and stats-integrity.tsx (the detailed panel section, fix round 1)
// so the two never compute two different answers to "is anything
// contaminated right now" from the same underlying data. Neither component
// file imports this logic FROM the other — both import it from here. A
// direct cross-import (ribbon -> panel or panel -> ribbon) would have closed
// a cycle once the ribbon needed the same cross-reference the panel already
// had; this module is the acyclic fix.
//
// The join stats.ts deliberately does not do (see stats.ts's
// subAgentModelAttribution doc comment): built here from
// IntegrityStats.subAgentModelAttribution (observed, windowed) and
// ConfigReport.subAgents (declared, unwindowed) — both already fetched by
// the client for other reasons.
// ---------------------------------------------------------------------------

/**
 * Flattens every DECLARED sub-agent model pin this repo knows about — both
 * `.claude/agents/*.md` frontmatter (`subAgents.groups`: pr-reviewer's 7,
 * plan-reviewer's 4, code-reviewer's 8) and the one inline `SdkAgentDefinition`
 * (`ci-waiter`) — into a single agent-name -> declared-model lookup.
 *
 * A frontmatter file with no `model:` line, AND an agent name that appears in
 * NO group or inline entry at all (e.g. the built-in `general-purpose`
 * subagent_type, which has no frontmatter file of its own) both end up
 * mapped to `null` here, on purpose: neither is "contamination", both are
 * "nothing was declared to compare this observation against".
 */
export function collectDeclaredPins(config: ConfigReport): Map<string, string | null> {
  const pins = new Map<string, string | null>();
  for (const group of config.subAgents.groups) {
    for (const file of group.files) {
      pins.set(file.file.replace(/\.md$/, ''), file.declaredModel);
    }
  }
  for (const inline of config.subAgents.inline) {
    pins.set(inline.subagentType, inline.declaredModel);
  }
  return pins;
}

export type ContaminationRowStatus = 'ok' | 'attention' | 'unpinned' | 'not-observed';

export interface AgentModelRow {
  agent: string;
  /** A pin is DECLARED, never guaranteed — frontmatter pins are known to be
   *  silently ignored, which is the whole reason this row exists. `null`
   *  means no declared pin was found for this agent at all (see
   *  `collectDeclaredPins`), not that the pin failed. */
  declaredModel: string | null;
  observed: Array<{ model: string | null; count: number }>;
  totalRuns: number;
  /** Runs observed on a model other than `declaredModel`. Always 0 for an
   *  `'unpinned'` row — there is nothing to be off of. */
  offPinRuns: number;
  status: ContaminationRowStatus;
}

/**
 * Cross-references observed per-agent model attribution against declared
 * pins. An agent with NO declared pin is `'unpinned'`, never folded into a
 * contamination count — an unpinned agent (e.g. `general-purpose`) running
 * on any model is expected behaviour, not drift. An agent WITH a declared
 * pin that shows even one run on a different model is `'attention'` — this
 * is not a documented, expected instrument fault the way the dispatch
 * mismatch is.
 *
 * A declared pin that produced NO observed runs at all this window is
 * `'not-observed'` (I-4) — distinct from both of the above. Before this fix,
 * this function only ever walked OBSERVED entries (`entries`/`byAgent`), so
 * a caller building an "all-clear" summary from its output could only ever
 * cover whichever pins happened to dispatch, never the declared roster: on
 * a live 30d window, 12 of 19 declared frontmatter pins — every
 * plan-reviewer/code-reviewer sub-agent — produced zero observed runs, and
 * "all 7 pinned sub-agents ran only on their declared model" read as an
 * all-clear over those 7 alone, silently dropping the other 12. A
 * `'not-observed'` row is explicitly NOT contamination (nothing ran, so
 * nothing can be off-pin) and must stay out of any contamination count the
 * same way `'unpinned'` already does — but unlike `'unpinned'`, it IS a
 * declared pin, so a caller must disclose the count rather than silently
 * drop it (see `buildContaminationSectionView` in stats-integrity.tsx and
 * `assessModelIntegrity` in stats-ribbon.tsx, both updated alongside this).
 * A pin with no declared model at all (`collectDeclaredPins` maps a
 * frontmatter file with no `model:` line to `null`) is excluded from this
 * second pass — there is no pin to have gone unobserved, same reasoning as
 * the `'unpinned'` branch below.
 */
export function buildAgentModelRows(
  entries: SubAgentModelAttributionEntry[],
  declaredPins: Map<string, string | null>,
): AgentModelRow[] {
  const byAgent = new Map<string, Array<{ model: string | null; count: number }>>();
  for (const e of entries) {
    const list = byAgent.get(e.agent) ?? [];
    list.push({ model: e.model, count: e.count });
    byAgent.set(e.agent, list);
  }
  const rows: AgentModelRow[] = [];
  for (const [agent, observed] of byAgent) {
    const totalRuns = observed.reduce((s, o) => s + o.count, 0);
    const declaredModel = declaredPins.get(agent) ?? null;
    if (declaredModel == null) {
      rows.push({ agent, declaredModel: null, observed, totalRuns, offPinRuns: 0, status: 'unpinned' });
      continue;
    }
    const offPinRuns = observed.filter((o) => o.model !== declaredModel).reduce((s, o) => s + o.count, 0);
    rows.push({ agent, declaredModel, observed, totalRuns, offPinRuns, status: offPinRuns > 0 ? 'attention' : 'ok' });
  }
  for (const [agent, declaredModel] of declaredPins) {
    if (byAgent.has(agent) || declaredModel == null) continue;
    rows.push({ agent, declaredModel, observed: [], totalRuns: 0, offPinRuns: 0, status: 'not-observed' });
  }
  return rows.sort((a, b) => a.agent.localeCompare(b.agent));
}

export function formatObservedBreakdown(observed: Array<{ model: string | null; count: number }>): string {
  return observed.map((o) => `${o.model ?? '(unknown)'}: ${o.count}`).join(' · ');
}

/**
 * The declared-pin side's own availability, independent of whatever state
 * `IntegrityStats` (the observed side) is in — `ConfigReport` is a SEPARATE
 * fetch that can be loading or errored even while the observed data is
 * ready. Both consumers (ribbon card, panel section) build this once and
 * switch on it, rather than each re-deriving it from `FetchState<ConfigReport>`.
 */
export type ContaminationAvailability =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; rows: AgentModelRow[] };

/**
 * `ContaminationAvailability` minus `'loading'` — the shape a caller has
 * once it has decided NOT to render anything until the declared-pin fetch
 * settles one way or the other (fix round 3: `stats-ribbon.tsx`'s combined
 * "Model integrity" card holds at the ribbon's own `'loading'` status for
 * the whole card rather than computing a provisional verdict from a partial
 * signal — see that file's `assessModelIntegrity`). Narrowing the type this
 * way makes "assessed while still loading" a compile error, not a
 * discipline the caller has to remember.
 */
export type SettledContaminationAvailability = Exclude<ContaminationAvailability, { status: 'loading' }>;

export function buildContaminationAvailability(
  entries: SubAgentModelAttributionEntry[],
  configState: FetchState<ConfigReport>,
): ContaminationAvailability {
  switch (configState.status) {
    case 'loading':
      return { status: 'loading' };
    case 'error':
      return { status: 'error', message: configState.message };
    case 'empty':
      // /api/config is unwindowed and never reports 'empty' (loadConfigReport
      // only ever sets loading/error/ready) — kept for exhaustiveness against
      // the shared FetchState<T> union, same rationale as buildDriftCard's
      // 'empty' branch in stats-ribbon.tsx.
      return { status: 'error', message: 'declared configuration unexpectedly reported empty' };
    case 'ready':
      return { status: 'ready', rows: buildAgentModelRows(entries, collectDeclaredPins(configState.data)) };
  }
}
