/**
 * Manually enqueue a PR review for the watcher to pick up.
 *
 * Usage:
 *   bun scripts/trigger-pr-review.ts --pr-id <id>
 *
 * Resolves the PR's repository, branches, title, and description from Azure
 * DevOps (org-level pull-request endpoint), maps the repository to a configured
 * repo key, and writes a `review-pr` action — the same payload the webhook server
 * produces. The watcher claims it on its next poll and spawns a review container.
 */
import { connectStores } from '../src/db/connect-stores.ts';
import { loadConfig } from '../src/cli/config.ts';
import { findRepoByRepositoryId } from '../src/config/repos.ts';

function parsePrId(argv: string[]): number {
  const idx = argv.indexOf('--pr-id');
  const raw = idx >= 0 ? argv[idx + 1] : undefined;
  const prId = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isInteger(prId) || prId <= 0) {
    console.error('Usage: bun scripts/trigger-pr-review.ts --pr-id <id>');
    process.exit(1);
  }
  return prId;
}

interface GlobalPrResponse {
  pullRequestId: number;
  title?: string;
  description?: string;
  sourceRefName: string;
  targetRefName: string;
  url?: string;
  repository: { id: string; name: string; project?: { id: string; name: string } };
}

const prId = parsePrId(process.argv.slice(2));
const config = loadConfig('.');
const { orgUrl, pat } = config.azureDevOps;

// Org-level PR lookup — resolves the PR regardless of which repo it lives in.
const auth = Buffer.from(':' + pat).toString('base64');
const res = await fetch(`${orgUrl}/_apis/git/pullrequests/${prId}?api-version=7.0`, {
  headers: { Authorization: `Basic ${auth}` },
});
if (!res.ok) {
  console.error(`Failed to fetch PR #${prId}: ${res.status} ${res.statusText}\n${await res.text().catch(() => '')}`);
  process.exit(1);
}
const pr = (await res.json()) as GlobalPrResponse;

const repo = findRepoByRepositoryId(pr.repository.id);
if (!repo) {
  console.error(`PR #${prId} is in repository ${pr.repository.name} (${pr.repository.id}), which is not a configured repo.`);
  process.exit(1);
}

const { actionStore } = await connectStores();
const actionId = await actionStore.write({
  workItemId: 0,
  type: 'review-pr',
  feedback: JSON.stringify({
    prId: pr.pullRequestId,
    repoKey: repo.key,
    repositoryId: pr.repository.id,
    project: pr.repository.project?.name ?? config.azureDevOps.project,
    sourceBranch: pr.sourceRefName,
    targetBranch: pr.targetRefName,
    prUrl: pr.url ?? '',
    prTitle: pr.title ?? `PR #${prId}`,
    prDescription: pr.description ?? '',
  }),
  createdAt: new Date().toISOString(),
});

console.log(`Queued review-pr action id=${actionId} for PR #${prId} (${repo.key}, ${pr.sourceRefName} → ${pr.targetRefName})`);
process.exit(0);
