// scripts/pr-review-tooling-ab.ts
/**
 * 2×2 A/B over the two levers behind PR-review cost:
 *
 *   model      opus (baseline, pinned in sub-agent frontmatter) vs sonnet-5
 *   tool rule  absent (baseline) vs a routing block steering Read/Grep/LSP
 *
 * Measured on PR 52081 (2-file diff, $16.53): the 7 sub-agents made 207 Bash
 * calls of which 168 were sed/cat/head/tail file reads, 23 Read calls, and ZERO
 * LSP calls — 10.0M cache-read tokens. Both levers target that directly, and
 * they may interact: memory says Sonnet follows tool steering far better than
 * Opus, so "sonnet + rule" could beat the sum of its parts.
 *
 * Spawns review containers DIRECTLY rather than enqueuing watcher actions. The
 * watcher reads PR_REVIEW_NO_POST from its own compose env, so steering it
 * through the queue would mean either restarting the watcher with posting
 * disabled (silently breaking any real review that lands during the window) or
 * posting every arm to the PR. Spawning here keeps production untouched and
 * lets each arm carry its own env.
 *
 * Usage:
 *   bun scripts/pr-review-tooling-ab.ts --pr 52081                     # dry-run plan
 *   bun scripts/pr-review-tooling-ab.ts --pr 52081 --go                # execute (1 run/arm)
 *   bun scripts/pr-review-tooling-ab.ts --pr 52081 --collect --since <iso>
 *
 * Posting is OFF unless --post is passed. Nothing reaches the PR by default.
 */
import { connectStores } from '../src/db/connect-stores.ts';
import { loadManifest, applyOverlayRegistries } from '../src/overlay/index.ts';
import { findRepoByRepositoryId, repos, getRepoConfig } from '../src/config/repos.ts';
import { buildConfigFromRepo } from '../src/cli/config.ts';
import { buildDockerArgs, createVolume, removeContainer, spawnContainer, containerDatabaseUrl } from '../src/sdk/docker.ts';
import { getPrReviewContainerEnv } from '../src/cli/watch/container-dispatcher.ts';
import { summarizeSubAgents, isAtOrAfter, type SubAgentRunUsage } from '../src/cli/pr-review-metrics.ts';

function arg(name: string, def = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? def) : def;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const prId = parseInt(arg('pr', '0'), 10);
const runs = parseInt(arg('runs', '1'), 10);
const post = has('post');
const imageName = arg('image', 'devopsworker:latest');
const stateVolume = arg('state-volume', 'do-pipeline-state');

if (!prId) { console.error('Need --pr <id>'); process.exit(1); }

interface Arm { label: string; model: string; toolRule: boolean; }
const ARMS: Arm[] = [
  { label: 'baseline',       model: '',                toolRule: false },
  { label: 'sonnet',         model: 'claude-sonnet-5', toolRule: false },
  { label: 'rule',           model: '',                toolRule: true  },
  { label: 'sonnet+rule',    model: 'claude-sonnet-5', toolRule: true  },
];

// --arms lets a canary run ONE arm, confirm it recorded, then continue with the
// rest. The post-run gate would catch a failure anyway, but on a first outing
// after a recording bug, proving it by hand costs one run and settles it.
const onlyArms = arg('arms').split(',').map(a => a.trim()).filter(Boolean);
const SELECTED = onlyArms.length > 0 ? ARMS.filter(a => onlyArms.includes(a.label)) : ARMS;
if (SELECTED.length === 0) {
  console.error(`No arm matched --arms "${onlyArms.join(',')}". Known: ${ARMS.map(a => a.label).join(', ')}`);
  process.exit(1);
}

applyOverlayRegistries(await loadManifest());
const { prReviewStore } = await connectStores();

// ---------------------------------------------------------------------------
// collect
// ---------------------------------------------------------------------------
if (has('collect')) {
  const since = arg('since');
  if (!since) { console.error('--collect requires --since <iso>'); process.exit(1); }

  const rows = await prReviewStore.listRecent(200);
  const mine = rows.filter(r => r.prId === prId && isAtOrAfter(r.createdAt, since));
  if (mine.length === 0) { console.log('No rows yet.'); process.exit(0); }

  // Arm identity is not stored on the row, so recover it from what the arm
  // actually did: model_usage names the model the sub-agents ran on.
  const armOf = (r: typeof mine[number]): string => {
    const models = Object.keys(r.modelUsage ?? {});
    return models.some(m => m.includes('sonnet')) ? 'sonnet*' : 'opus*';
  };

  console.log(`\nPR #${prId} — ${mine.length} runs since ${since}\n`);
  console.log('  arm       cost    turns   bash   read    lsp   findings  rec');
  console.log('  ' + '-'.repeat(72));
  for (const r of mine) {
    const t = r.toolCalls ?? {};
    const lsp = Object.entries(t).filter(([k]) => k === 'LSP').reduce((a, [, v]) => a + v, 0);
    console.log(
      '  ' + armOf(r).padEnd(10) +
      `$${(r.costUsd ?? 0).toFixed(2)}`.padStart(6) +
      String(r.turns ?? 0).padStart(8) +
      String(t['Bash'] ?? 0).padStart(7) +
      String(t['Read'] ?? 0).padStart(7) +
      String(lsp).padStart(7) +
      String(r.findingsCount ?? 0).padStart(10) +
      '  ' + (r.recommendation ?? '').slice(0, 20),
    );
  }

  const withSub = mine.filter(r => r.subAgents).map(r => r.subAgents as Record<string, SubAgentRunUsage>);
  if (withSub.length > 0) {
    console.log('\n  per sub-agent (all runs pooled):');
    for (const s of summarizeSubAgents(withSub)) {
      console.log(`    ${s.name.padEnd(30)} runs=${String(s.runs).padStart(2)}  $${s.totalCostUsd.toFixed(2).padStart(6)}  medTurns=${s.medianTurns}`);
    }
  }
  process.exit(0);
}

/**
 * Wait for the row a finished container should have written.
 *
 * Polls rather than reading once: the container's own DB write races the
 * `docker run` exit by a moment. Returns the row, or null once the window
 * closes — which the caller treats as fatal, not as something to retry past.
 */
async function waitForRow(pr: number, since: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await prReviewStore.listRecent(20);
    const hit = rows.find(r => r.prId === pr && isAtOrAfter(r.createdAt, since));
    if (hit) return hit;
    await new Promise(res => setTimeout(res, 2000));
  }
  return null;
}

/**
 * Prove the containers' write path works BEFORE spending a review on it.
 *
 * Runs a throwaway container on the same network with the same DATABASE_URL and
 * has it count rows. Costs seconds and no tokens; catches the exact failure that
 * wasted ~$60.
 */
async function preflightDb(dbUrl: string): Promise<boolean> {
  const proc = Bun.spawn([
    'docker', 'run', '--rm', '--network', 'pipeline-net',
    '-e', `DATABASE_URL=${dbUrl}`,
    '--entrypoint', 'bun', imageName,
    '-e', `const postgres=(await import('postgres')).default;
           const sql=postgres(process.env.DATABASE_URL);
           const r=await sql\`SELECT count(*)::int AS n FROM pr_reviews\`;
           console.log('PREFLIGHT_OK rows=' + r[0].n); await sql.end();`,
  ], { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  if (out.includes('PREFLIGHT_OK')) {
    console.log(`[ab] preflight: ${out.trim().split(String.fromCharCode(10)).pop()}`);
    return true;
  }
  console.error(`[ab] preflight FAILED — containers cannot reach the database.`);
  const NL = String.fromCharCode(10);
  console.error((err || out).trim().split(NL).slice(-6).join(NL));
  return false;
}

// ---------------------------------------------------------------------------
// plan / execute
// ---------------------------------------------------------------------------
const repoKeys = Object.keys(repos);
let repo: { key: string; config: ReturnType<typeof getRepoConfig> } | undefined;
let repositoryId = '';
for (const k of repoKeys) {
  const rc = getRepoConfig(k);
  const cfg = buildConfigFromRepo(rc, process.env as Record<string, string>);
  try {
    const r: any = await (await import('../src/sdk/ado/http.ts')).adoFetch(
      cfg.azureDevOps,
      `git/repositories/${cfg.azureDevOps.repositoryId}/pullrequests/${prId}?api-version=7.0`,
    );
    if (r?.pullRequestId === prId) {
      repo = { key: k, config: rc };
      repositoryId = cfg.azureDevOps.repositoryId;
      console.log(`[ab] PR #${prId} → repo "${k}" (${r.title})`);
      break;
    }
  } catch { /* not this repo */ }
}
if (!repo) { console.error(`Could not locate PR #${prId} in any registered repo`); process.exit(1); }

const total = SELECTED.length * runs;
console.log(`[ab] ${SELECTED.length} arm(s) × ${runs} run(s) = ${total} reviews`);
console.log(`[ab] posting to the PR: ${post ? 'YES' : 'no (PR_REVIEW_NO_POST=1)'}`);
for (const a of SELECTED) {
  console.log(`       ${a.label.padEnd(14)} model=${a.model || '(pinned opus)'} toolRule=${a.toolRule}`);
}

if (!has('go')) {
  console.log('\n[ab] dry run — re-run with --go to execute.');
  process.exit(0);
}

// Prove the containers' write path BEFORE spending a review on it. Costs
// seconds and no tokens.
const containerDbUrl = containerDatabaseUrl(process.env['DATABASE_URL'] ?? '');
if (!await preflightDb(containerDbUrl)) {
  console.error('[ab] refusing to spend a review until the write path is proven.');
  process.exit(1);
}

const cutoff = new Date().toISOString();
console.log(`[ab] cutoff=${cutoff}\n`);

let n = 0;
for (let r = 0; r < runs; r++) {
  for (const armCfg of SELECTED) {
    n++;
    const container = `pr-ab-${prId}-${armCfg.label.replace(/\W+/g, '')}-${r}`;
    const volume = `pr-ab-${prId}-${r}-${armCfg.label.replace(/\W+/g, '')}`;
    console.log(`[ab] (${n}/${total}) ${armCfg.label} run ${r + 1}`);

    await createVolume(volume).catch(() => {});
    await removeContainer(container);

    const env = {
      ...getPrReviewContainerEnv(),
      // Must be the compose-internal host: see containerDatabaseUrl.
      DATABASE_URL: containerDbUrl,
      PR_REVIEW_NO_POST: post ? '' : '1',
      PR_REVIEW_SUBAGENT_MODEL: armCfg.model,
      PR_REVIEW_SUBAGENT_TOOL_RULE: armCfg.toolRule ? '1' : '',
    };

    const args = buildDockerArgs({
      workItemId: 0,
      repoKey: repo.key,
      repo: repo.config,
      command: 'review-pr',
      env,
      stateVolume,
      workspaceVolume: volume,
      imageName,
      extraArgs: ['--pr-id', String(prId), '--repo-id', repositoryId],
    });
    const nameIdx = args.indexOf('--name');
    if (nameIdx !== -1 && args[nameIdx + 1]) args[nameIdx + 1] = container;

    const startedAt = new Date().toISOString();
    const code = await spawnContainer(args);

    // HARD GATE. A review that finishes but records nothing is worse than one
    // that fails: it costs the same and yields nothing, and the store swallows
    // connection errors so it looks like success. Eight arms once ran to
    // completion against an unreachable DB — ~$60, zero rows. Never spend a
    // second run without proof the first was recorded.
    const recorded = await waitForRow(prId, startedAt);
    if (!recorded) {
      console.error(
        `\n[ab] ABORTING after run ${n}/${total} (${armCfg.label}, exit=${code}).\n` +
        `[ab] The container finished but no pr_reviews row appeared for PR ${prId}.\n` +
        `[ab] Fix the recording path before spending another run — check DATABASE_URL\n` +
        `[ab] inside the container resolves to the compose service, not localhost.`,
      );
      process.exit(1);
    }
    console.log(
      `[ab]     exit=${code}  recorded id=${recorded.id}  $${(recorded.costUsd ?? 0).toFixed(2)}  ` +
      `turns=${recorded.turns}  bash=${recorded.toolCalls?.['Bash'] ?? 0}  ` +
      `read=${recorded.toolCalls?.['Read'] ?? 0}  lsp=${recorded.toolCalls?.['LSP'] ?? 0}`,
    );
  }
}

console.log(`\n[ab] done. Collect with:`);
console.log(`  bun scripts/pr-review-tooling-ab.ts --pr ${prId} --collect --since ${cutoff}`);
process.exit(0);
