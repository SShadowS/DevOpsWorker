import { connectStores } from '../db/connect-stores.ts';
import { findRepoByRepositoryId } from '../config/repos.ts';
import { validateSignature } from './validate.ts';
import { parseWebhookPayload } from './parse.ts';
import type { IStateStore } from '../pipeline/state-store.interface.ts';
import type { IWebhookEventStore } from '../pipeline/webhook-event-store.interface.ts';

export interface WebhookServerOptions {
  port: number;
  webhookSecret?: string;
}

function log(message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${message}`);
}

/** Best-effort repo name from a raw Azure DevOps webhook payload, regardless of event type. */
function extractRepoName(payload: unknown): string | undefined {
  const p = payload as any;
  return p?.resource?.repository?.name
    ?? p?.resource?.pullRequest?.repository?.name
    ?? undefined;
}

async function isPipelinePR(stateStore: IStateStore, prId: number): Promise<boolean> {
  for (const id of await stateStore.listAll()) {
    const state = await stateStore.load(id);
    if (state?.draftPR?.id === prId) return true;
  }
  return false;
}

export async function startWebhookServer(options: WebhookServerOptions): Promise<void> {
  const { port, webhookSecret } = options;

  const { stateStore, actionStore, runnerStatus, webhookEventStore } = await connectStores();

  // Cleanup old events on startup and every hour
  webhookEventStore.cleanupOldEvents().catch?.(() => {});
  setInterval(() => { (webhookEventStore.cleanupOldEvents() as Promise<number>).catch(() => {}); }, 60 * 60 * 1000);

  // Write heartbeat on startup and every 30 seconds
  runnerStatus.writeHeartbeat('webhook-server').catch?.(() => {});
  setInterval(() => { runnerStatus.writeHeartbeat('webhook-server').catch?.(() => {}); }, 30_000);

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // Health check
      if (url.pathname === '/health' && req.method === 'GET') {
        return Response.json({ ok: true, uptime: process.uptime() });
      }

      // Webhook endpoint
      if (url.pathname === '/webhook' && req.method === 'POST') {
        const body = await req.text();

        // Validate signature
        const signature = req.headers.get('Authorization');
        if (!validateSignature(body, signature, webhookSecret)) {
          log('Webhook rejected: invalid signature');
          return new Response('Unauthorized', { status: 401 });
        }

        let payload: unknown;
        try {
          payload = JSON.parse(body);
        } catch {
          log('Webhook rejected: invalid JSON');
          return new Response('Bad Request', { status: 400 });
        }

        // Parse the event
        let event;
        try {
          event = parseWebhookPayload(payload);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`Webhook rejected: ${msg}`);
          await webhookEventStore.persistEvent('unknown', body, msg);
          return new Response('Bad Request', { status: 400 });
        }

        if (!event) {
          const repoName = extractRepoName(payload);
          const eventType = (payload as any)?.eventType ?? 'unknown';
          log(`Webhook ignored: ${repoName ? `${repoName} [Ignored]` : `unsupported event type (${eventType})`}`);
          await webhookEventStore.persistEvent(eventType, body, 'unsupported event type');
          return Response.json({ ok: true, ignored: true }, { status: 200 });
        }

        // Persist the raw event
        await webhookEventStore.persistEvent(event.eventType, body);

        // Check if repo is known
        const repo = findRepoByRepositoryId(event.pr.repositoryId);
        if (!repo) {
          log(`Webhook ignored: ${event.pr.repositoryName} [Ignored] (unknown repo ${event.pr.repositoryId})`);
          return Response.json({ ok: true, ignored: true, reason: 'unknown repo' }, { status: 200 });
        }

        // Passive repo: registered for reviews but no auto-review on PR creation.
        // /review comments (commentKey present) and the CLI still trigger reviews.
        if (!event.commentKey && repo.config.autoReview === false) {
          log(`Webhook ignored: PR #${event.pr.id} in ${event.pr.repositoryName} — auto-review disabled for ${repo.key} (use /review or CLI)`);
          return Response.json({ ok: true, ignored: true, reason: 'auto-review disabled' }, { status: 200 });
        }

        // Skip auto-review for draft PRs unless the repo opts in via reviewDrafts.
        // Explicit /review comments (commentKey present) review drafts regardless.
        if (!event.commentKey && event.pr.isDraft && repo.config.reviewDrafts !== true) {
          log(`Webhook ignored: PR #${event.pr.id} in ${event.pr.repositoryName} — draft PR (reviewDrafts not enabled for ${repo.key})`);
          return Response.json({ ok: true, ignored: true, reason: 'draft PR' }, { status: 200 });
        }

        // Skip auto-review for pipeline-created PRs (they get reviewed through the pipeline).
        // But allow explicit /review commands — if someone asks, they should get a review.
        if (!event.commentKey && await isPipelinePR(stateStore, event.pr.id)) {
          log(`Webhook ignored: PR #${event.pr.id} belongs to a pipeline work item (auto-review skipped)`);
          return Response.json({ ok: true, ignored: true, reason: 'pipeline PR' }, { status: 200 });
        }

        // Dedup: comment-triggered reviews dedup by comment ID; PR-created reviews dedup by PR ID
        if (event.commentKey) {
          // Comment-triggered review: dedup by comment ID (check all actions, consumed or not)
          const commentDupe = await webhookEventStore.hasMatchingAction(0, 'review-pr', 'commentKey', event.commentKey, false);
          if (commentDupe) {
            log(`Webhook ignored: comment ${event.commentKey} on PR #${event.pr.id} already triggered a review`);
            return Response.json({ ok: true, ignored: true, reason: 'duplicate comment' }, { status: 200 });
          }
        } else {
          // PR-created review: dedup by pending action for same PR
          const pendingDupe = await webhookEventStore.hasMatchingAction(0, 'review-pr', 'prId', String(event.pr.id), true);
          if (pendingDupe) {
            log(`Webhook ignored: PR #${event.pr.id} already has a pending review`);
            return Response.json({ ok: true, ignored: true, reason: 'duplicate' }, { status: 200 });
          }
        }

        // Queue the review action
        const trigger = event.commentKey ? `/review comment ${event.commentKey}` : 'PR creation';
        log(`Queuing review for PR #${event.pr.id} in ${event.pr.repositoryName} (trigger: ${trigger})`);
        await actionStore.write({
          workItemId: 0,
          type: 'review-pr',
          feedback: JSON.stringify({
            prId: event.pr.id,
            repoKey: repo.key,
            repositoryId: event.pr.repositoryId,
            project: event.pr.project,
            sourceBranch: event.pr.sourceBranch,
            targetBranch: event.pr.targetBranch,
            prUrl: event.pr.url,
            prTitle: event.pr.title,
            prDescription: event.pr.description,
            ...(event.commentKey ? { commentKey: event.commentKey } : {}),
          }),
          createdAt: new Date().toISOString(),
        });

        return Response.json({ ok: true, queued: true, prId: event.pr.id }, { status: 202 });
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  log(`Webhook server listening on port ${server.port}`);
}
