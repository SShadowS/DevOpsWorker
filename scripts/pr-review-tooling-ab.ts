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
 *   bun scripts/pr-review-tooling-ab.ts --pr 52081 --runs 2            # dry-run plan
 *   bun scripts/pr-review-tooling-ab.ts --pr 52081 --runs 2 --go       # execute
 *   bun scripts/pr-review-tooling-ab.ts --pr 52081 --collect --since <iso>
 *
 * Posting is OFF unless --post is passed. Nothing reaches the PR by default.
 */
import { connectStores } from '../src/db/connect-stores.ts';
import { loadManifest, applyOverlayRegistries } from '../src/overlay/index.ts';
import { findRepoByRepositoryId, repos, getRepoConfig } from '../src/config/repos.ts';
import { buildConfigFromRepo } from '../src/cli/config.ts';
import { buildDockerArgs, createVolume, removeContainer, spawnContainer } from '../src/sdk/docker.ts';
import { getPrReviewContainerEnv } from '../src/cli/watch/container-dispatcher.ts';
import { summarizeSubAgents, type SubAgentRunUsage } from '../src/cli/pr-review-metrics.ts';

function arg(name: string, def = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? def) : def;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const prId = parseInt(arg('pr', '0'), 10);
const runs = parseInt(arg('runs', '2'), 10);
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

applyOverlayRegistries(await loadManifest());
const { sql, prReviewStore } = await connectStores();

// ---------------------------------------------------------------------------
// collect
// ---------------------------------------------------------------------------
if (has('collect')) {
  const since = arg('since');
  if (!since) { console.error('--collect requires --since <iso>'); process.exit(1); }

  const rows = await prReviewStore.listRecent(200);
  const mine = rows.filter(r => r.prId === prId && r.createdAt >= since);
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

const total = ARMS.length * runs;
console.log(`[ab] ${ARMS.length} arms × ${runs} runs = ${total} reviews`);
console.log(`[ab] posting to the PR: ${post ? 'YES' : 'no (PR_REVIEW_NO_POST=1)'}`);
for (const a of ARMS) {
  console.log(`       ${a.label.padEnd(14)} model=${a.model || '(pinned opus)'} toolRule=${a.toolRule}`);
}

if (!has('go')) {
  console.log('\n[ab] dry run — re-run with --go to execute.');
  process.exit(0);
}

const cutoff = new Date().toISOString();
console.log(`[ab] cutoff=${cutoff}\n`);

let n = 0;
for (let r = 0; r < runs; r++) {
  for (const armCfg of ARMS) {
    n++;
    const container = `pr-ab-${prId}-${armCfg.label.replace(/\W+/g, '')}-${r}`;
    const volume = `pr-ab-${prId}-${r}-${armCfg.label.replace(/\W+/g, '')}`;
    console.log(`[ab] (${n}/${total}) ${armCfg.label} run ${r + 1}`);

    await createVolume(volume).catch(() => {});
    await removeContainer(container);

    const env = {
      ...getPrReviewContainerEnv(),
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

    const code = await spawnContainer(args);
    console.log(`[ab]     exit=${code}`);
  }
}

console.log(`\n[ab] done. Collect with:`);
console.log(`  bun scripts/pr-review-tooling-ab.ts --pr ${prId} --collect --since ${cutoff}`);
await sql.end();
