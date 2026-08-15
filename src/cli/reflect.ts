import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { connectStores } from '../db/connect-stores.ts';
import { loadConfig, readAllSettingsSafely } from './config.ts';
import { createReflectionConfig } from '../agents/reflection/config.ts';
import type { ReflectionProposal } from '../db/reflection-proposal-mapper.ts';
import { runAgent } from '../sdk/run-agent.ts';
import { createInitialState } from '../pipeline/initial-state.ts';
import { notifyDiscord, notifyPipelineError } from '../sdk/discord-notify.ts';
import { findingKey } from '../sdk/ado/finding-key.ts';
import type { PipelineContext } from '../types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// pipeline reflect — monthly reflection on human responses to the PR
// reviewer's findings. Queries the labelled learning set from
// `finding_outcomes` + `pr_reviews.findings_list`, runs the reflection agent,
// and persists its proposal to `reflection_proposals`.
// ---------------------------------------------------------------------------

/** The floor below which a cycle has too little labelled data to adjudicate. */
export const MIN_DISPUTED_ROWS = 5;

export interface ReflectArgs {
  windowDays: number;
  dryRun: boolean;
  noNotify: boolean;
  /** YYYY-MM-DD. Undefined means "default to today, container clock" — resolved in `runReflect`. */
  cycleDate: string | undefined;
}

/** Pure — parses `reflect`'s argv into typed flags. See the task brief for the flag list. */
export function parseReflectArgs(argv: string[]): ReflectArgs {
  let windowDays = 35;
  let dryRun = false;
  let noNotify = false;
  let cycleDate: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--window-days' && argv[i + 1]) windowDays = parseInt(argv[++i]!, 10);
    else if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--no-notify') noNotify = true;
    else if (argv[i] === '--cycle-date' && argv[i + 1]) cycleDate = argv[++i];
  }

  return { windowDays, dryRun, noNotify, cycleDate };
}

/** One disputed finding, with everything the learning set needs to render it. */
export interface LearningSetRow {
  prId: number;
  findingKey: string;
  severity: string;
  title: string;
  file: string | null;
  said: string;
  saidQuote: string | null;
  saidEvidence: string | null;
}

/**
 * Pure — render the disputed-findings learning set the reflection agent adjudicates.
 * `bodies` maps a finding's `findingKey` (see `src/sdk/ado/finding-key.ts`) to the full
 * body the reviewer originally posted, recovered from `pr_reviews.findings_list`. A
 * missing body is said so plainly — the agent's adjudication of that row is then based
 * on the quote alone, and a reader of its output should know that.
 */
export function buildLearningSetBlock(rows: LearningSetRow[], bodies: Map<string, string>): string {
  if (rows.length === 0) {
    return ['## Learning set', '', 'No disputed findings fell inside this window.'].join('\n');
  }

  const entries = rows.map((row, i) => {
    const body = bodies.get(row.findingKey)
      ?? '(finding body not recovered — no pr_reviews.findings_list entry matched this finding key)';
    const quote = row.saidQuote ? `"${row.saidQuote}"` : '(no quote recorded)';
    return [
      `### ${i + 1}. PR ${row.prId} — ${row.title}`,
      `- File: \`${row.file ?? '(none)'}\``,
      `- Severity: ${row.severity}`,
      `- Said: ${row.said}${row.saidEvidence ? ` (evidence: ${row.saidEvidence})` : ''}`,
      `- Quote: ${quote}`,
      `- Finding body as posted:`,
      ``,
      body,
    ].join('\n');
  });

  return [
    `## Learning set — ${rows.length} disputed finding(s) in this window`,
    ``,
    entries.join('\n\n---\n\n'),
  ].join('\n');
}

/**
 * Pure — tell the agent where the reviewer's current prompts live and whether a
 * private overlay is mounted for this run. Checked against the module's own location
 * (not `process.cwd()`), so it resolves correctly both locally and in a container,
 * where this file always sits at `<root>/src/cli/reflect.ts`.
 */
function buildPromptFilesBlock(): string {
  const cliDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(cliDir, '..', '..');
  const overlayMounted = existsSync(resolve(repoRoot, 'private', 'agents', 'pr-reviewer'));

  const lines = [
    `## Reviewer prompt files`,
    ``,
    `Both are readable with your Read/Glob tools, under \`/app/\` in a container run:`,
    ``,
    `- Core orchestrator prompt: \`src/agents/pr-reviewer/CLAUDE.md\``,
    `- Core sub-agent prompts: \`src/agents/pr-reviewer/.claude/agents/*.md\``,
  ];
  lines.push(
    overlayMounted
      ? `- Overlay append (deployment-specific facts): \`private/agents/pr-reviewer/CLAUDE.append.md\` (a proposed diff may create it if it does not exist yet)`
      : `- No private overlay is mounted for this run — route only generic process rules to the core file above.`,
  );
  return lines.join('\n');
}

/**
 * Pure — render prior cycles' proposed changes and their status (decision (d) in the
 * spec: a change a human already rejected must not be re-proposed unchanged). Returns
 * `undefined` for an empty history so the prompt omits the section entirely rather than
 * heading a block with nothing under it — `createReflectionConfig`'s `buildPrompt`
 * relies on that.
 */
function buildPriorProposalsBlock(proposals: ReflectionProposal[]): string | undefined {
  if (proposals.length === 0) return undefined;

  const entries = proposals.map((p) => {
    const changes = p.proposedChanges.length === 0
      ? `  (no changes proposed this cycle)`
      : p.proposedChanges.map((c) => `  - [${c.target}] \`${c.file}\` — ${c.rationale}`).join('\n');
    return `- Cycle ${p.cycleDate} (status: ${p.status ?? 'unknown'}):\n${changes}`;
  });

  return entries.join('\n\n');
}

async function maybeNotify(dryRun: boolean, noNotify: boolean, opts: Parameters<typeof notifyDiscord>[0]): Promise<void> {
  if (dryRun || noNotify) return;
  await notifyDiscord(opts);
}

export async function runReflect(argv: string[]): Promise<number> {
  const { windowDays, dryRun, noNotify, cycleDate: cycleDateArg } = parseReflectArgs(argv);
  const cycleDate = cycleDateArg ?? new Date().toISOString().slice(0, 10);

  console.log(`[reflect] cycle=${cycleDate} window=${windowDays}d dryRun=${dryRun} noNotify=${noNotify}`);

  let stores: Awaited<ReturnType<typeof connectStores>>;
  try {
    stores = await connectStores();
    console.log('[reflect] Connected to database');
  } catch (dbErr) {
    console.error(`[reflect] could not connect to database — cannot query the learning set or persist a proposal: ${dbErr}`);
    return 1;
  }
  const { sql, reflectionStore } = stores;

  // --- 1. Disputed rows + coverage, both anchored at cycleDate (the Step-1 SQL from
  // the review-feedback-reflection skill, parameterised on window and anchor). ---
  const disputedRowsRaw = await sql`
    SELECT pr_id, repo_key, finding_key, severity, title, file, said, said_quote, said_evidence
    FROM finding_outcomes
    WHERE first_raised_at >= (${cycleDate}::date - (${windowDays}::int * interval '1 day'))
      AND first_raised_at < (${cycleDate}::date + interval '1 day')
      AND said IN ('rejected-wrong', 'rejected-wontfix', 'deferred')
      AND said_model_verified IS NOT FALSE
    ORDER BY said, first_raised_at DESC
  `;

  const disputedRows = disputedRowsRaw.map((r: Record<string, unknown>) => ({
    prId: Number(r['pr_id']),
    repoKey: String(r['repo_key']),
    findingKey: String(r['finding_key']),
    severity: String(r['severity']),
    title: String(r['title']),
    file: r['file'] == null ? null : String(r['file']),
    said: String(r['said']),
    saidQuote: r['said_quote'] == null ? null : String(r['said_quote']),
    saidEvidence: r['said_evidence'] == null ? null : String(r['said_evidence']),
  }));

  const [coverageRow] = await sql`
    SELECT count(*)::text AS total, count(*) FILTER (WHERE said IS NOT NULL)::text AS with_said
    FROM finding_outcomes
    WHERE first_raised_at >= (${cycleDate}::date - (${windowDays}::int * interval '1 day'))
      AND first_raised_at < (${cycleDate}::date + interval '1 day')
  `;
  const total = Number((coverageRow as Record<string, unknown> | undefined)?.['total'] ?? 0);
  const withSaid = Number((coverageRow as Record<string, unknown> | undefined)?.['with_said'] ?? 0);
  const pct = total > 0 ? Math.round((withSaid / total) * 1000) / 10 : 0;
  const coverage = { total, withSaid, pct };

  console.log(`[reflect] coverage: ${withSaid}/${total} (${pct}%) labelled, ${disputedRows.length} disputed`);

  // --- 2. Coverage floor — too little labelled data to adjudicate. ---
  if (disputedRows.length < MIN_DISPUTED_ROWS) {
    const errorMsg = `insufficient data: ${disputedRows.length} disputed rows`;
    console.log(`[reflect] ${errorMsg} (floor is ${MIN_DISPUTED_ROWS}) — writing an insufficient-data row, no agent run`);

    const proposalRow = {
      cycleDate, windowDays, coverage,
      adjudications: [], clusters: [], proposedChanges: [],
      watchLedger: [], classifierNotes: [], expectedEffects: [],
      logEntryDraft: null, costUsd: null, sessionId: null, error: errorMsg,
    };

    if (dryRun) {
      console.log(JSON.stringify(proposalRow, null, 2));
    } else {
      try {
        const id = await reflectionStore.save(proposalRow);
        console.log(`[reflect] saved insufficient-data row id=${id}`);
      } catch (saveErr) {
        console.error(`[reflect] failed to persist insufficient-data row: ${saveErr}`);
      }
    }

    await maybeNotify(dryRun, noNotify, {
      title: `Reflection cycle ${cycleDate}: insufficient data`,
      description: `Only ${disputedRows.length} disputed finding(s) with a human label in the last ${windowDays} days — below the floor of ${MIN_DISPUTED_ROWS}. No proposal was produced this cycle.`,
      severity: 'warning',
      source: 'reflection-agent',
      fields: [
        { name: 'Cycle', value: cycleDate, inline: true },
        { name: 'Window', value: `${windowDays}d`, inline: true },
        { name: 'Disputed rows', value: String(disputedRows.length), inline: true },
      ],
    });

    return 0;
  }

  // --- 3. Recover full finding bodies from pr_reviews.findings_list, matched by
  // recomputed finding key. Scoped per repo_key: pr_id is not unique across repos. ---
  const bodies = new Map<string, string>();
  const repoKeys = [...new Set(disputedRows.map((r) => r.repoKey))];
  for (const repoKey of repoKeys) {
    const prIds = [...new Set(disputedRows.filter((r) => r.repoKey === repoKey).map((r) => r.prId))];
    if (prIds.length === 0) continue;
    const bodyRows = await sql`
      SELECT f->>'file' AS file, f->>'title' AS title, f->>'body' AS body
      FROM pr_reviews r, jsonb_array_elements(r.findings_list) f
      WHERE r.repo_key = ${repoKey}
        AND r.pr_id IN ${sql(prIds)}
        AND r.findings_list IS NOT NULL
        AND f->>'file' IS NOT NULL
    `;
    for (const br of bodyRows as Record<string, unknown>[]) {
      const file = br['file'];
      const title = br['title'];
      const body = br['body'];
      if (typeof file !== 'string' || typeof title !== 'string' || typeof body !== 'string') continue;
      bodies.set(findingKey(file, title), body);
    }
  }

  const learningSetBlock = buildLearningSetBlock(disputedRows, bodies);
  const promptFilesBlock = buildPromptFilesBlock();

  // --- 4. Prior proposals — a change a human already rejected must not be
  // re-proposed unchanged. Best-effort: a failed read costs the agent that context,
  // never the run. ---
  let priorProposalsBlock: string | undefined;
  try {
    const prior = await reflectionStore.listRecent(10);
    priorProposalsBlock = buildPriorProposalsBlock(prior);
  } catch (err) {
    console.log(`[reflect] could not load prior proposals, continuing without them: ${err}`);
  }

  // --- 5. Run the agent. ---
  const sessionRoot = process.env['SESSION_ROOT'] ?? process.cwd();
  const settings = await readAllSettingsSafely(stores.settingsStore);
  const config = loadConfig(sessionRoot, settings);

  const agentConfig = createReflectionConfig(config, {
    learningSetBlock, promptFilesBlock, windowDays, cycleDate,
    ...(priorProposalsBlock ? { priorProposalsBlock } : {}),
  });

  const context: PipelineContext = {
    workItemId: 0,
    workItem: {
      id: 0,
      title: `Reflection cycle ${cycleDate}`,
      type: 'Task',
      state: 'Active',
      areaPath: config.azureDevOps.areaPath,
      iterationPath: config.azureDevOps.iterationPath,
      fields: {},
    },
    workItemType: 'Bug',
    config,
  };
  const state = createInitialState('reflection');

  try {
    const result = await runAgent(agentConfig, state, context);
    const output = result.output;

    if (dryRun) {
      console.log(JSON.stringify(output, null, 2));
      return 0;
    }

    try {
      const id = await reflectionStore.save({
        cycleDate, windowDays,
        coverage: output.coverage,
        adjudications: output.adjudications,
        clusters: output.clusters,
        proposedChanges: output.proposedChanges,
        watchLedger: output.watchLedger,
        classifierNotes: output.classifierNotes,
        expectedEffects: output.expectedEffects,
        logEntryDraft: output.logEntryDraft,
        costUsd: result.costUsd,
        sessionId: result.sessionId,
        error: null,
      });
      console.log(`[reflect] saved proposal id=${id}`);
    } catch (saveErr) {
      console.error(`[reflect] failed to persist proposal: ${saveErr}`);
    }

    const changesCount = output.proposedChanges.length;
    const watchCount = output.watchLedger.length;
    const needsMeasurementCount = output.adjudications.filter((a) => a.evidenceType === 'needs-measurement').length;

    await maybeNotify(dryRun, noNotify, {
      title: `Reflection cycle ${cycleDate} complete`,
      description: `${changesCount} change(s) proposed, ${watchCount} watch item(s), ${needsMeasurementCount} need(s) measurement. Review it on the dashboard's Reflection card.`,
      severity: 'warning',
      source: 'reflection-agent',
      fields: [
        { name: 'Cycle', value: cycleDate, inline: true },
        { name: 'Proposed changes', value: String(changesCount), inline: true },
        { name: 'Watch items', value: String(watchCount), inline: true },
      ],
    });

    console.log(`[reflect] cycle ${cycleDate} complete`);
    return 0;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const errorType = (err as { type?: string })?.type ?? 'agent-error';
    const errorStage = (err as { stage?: string })?.stage ?? 'reflection';
    console.error(`[reflect] agent run failed: ${errorMsg}`);

    if (!dryRun) {
      try {
        await reflectionStore.save({
          cycleDate, windowDays, coverage,
          adjudications: [], clusters: [], proposedChanges: [],
          watchLedger: [], classifierNotes: [], expectedEffects: [],
          logEntryDraft: null, costUsd: null, sessionId: null, error: errorMsg,
        });
      } catch (saveErr) {
        console.error(`[reflect] failed to persist error row: ${saveErr}`);
      }
    }

    if (!dryRun && !noNotify) {
      await notifyPipelineError(
        { type: errorType, stage: errorStage, message: errorMsg },
        { source: 'reflection-agent' },
      );
    }

    return 1;
  }
}
