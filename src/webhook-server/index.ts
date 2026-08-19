import { connectStores } from '../db/connect-stores.ts';
import { findRepoByRepositoryId } from '../config/repos.ts';
import { refreshRegistryIfStale } from '../config/hydrate.ts';
import { validateSignature } from './validate.ts';
import { parseWebhookPayload, type PRWebhookEvent } from './parse.ts';
import type { IStateStore } from '../pipeline/state-store.interface.ts';
import type { IWebhookEventStore } from '../pipeline/webhook-event-store.interface.ts';

/** How stale the repo/companion registry may be before a request refreshes
 *  it from the database. PR events are rare, so a per-request TTL check
 *  (near-free once warm) keeps the webhook server current without a query
 *  on every request. */
const REGISTRY_TTL_MS = 30_000;

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

/**
 * Build the `review-pr` action's JSON feedback payload from a parsed webhook event.
 *
 * Pulled out of the request handler so this hop of the webhook → action →
 * action-processor → argv bridge is unit-testable without a database connection —
 * this is exactly the kind of seam that let `prTitle` go missing before: it was
 * threaded into this payload correctly but never read back out on the other end.
 * A field dropped HERE (never added to the object below) is the failure mode this
 * function's own tests exist to catch.
 */
export function buildReviewPrActionFeedback(event: PRWebhookEvent, repoKey: string): string {
  return JSON.stringify({
    prId: event.pr.id,
    repoKey,
    repositoryId: event.pr.repositoryId,
    project: event.pr.project,
    sourceBranch: event.pr.sourceBranch,
    targetBranch: event.pr.targetBranch,
    prUrl: event.pr.url,
    prTitle: event.pr.title,
    prDescription: event.pr.description,
    ...(event.commentKey ? { commentKey: event.commentKey } : {}),
    ...(event.forceFull ? { forceFull: true } : {}),
  });
}

/**
 * Which existing actions block this event from queueing another review.
 *
 * Three triggers, three answers:
 *
 * - **A `/review` comment** dedups on the comment itself, across all actions. A human
 *   asking for a second look must always get one, so the PR's review history is not
 *   allowed to block it — only the same comment being delivered twice.
 * - **A creation** dedups on the PR, but only against a review still pending. A PR is
 *   created once, so there is nothing else to protect against.
 * - **A published draft** dedups on the PR against ALL actions, pending or finished.
 *   Unlike creation, publishing can happen repeatedly — draft → published → draft →
 *   published — and with the creation rule every publish after a finished review would
 *   buy a second full review of code already read. First publish reviews; after that a
 *   human asks with `/review`.
 */
export function dedupScopeFor(
  event: PRWebhookEvent,
): { key: 'commentKey' | 'prId'; value: string; pendingOnly: boolean } {
  if (event.commentKey) return { key: 'commentKey', value: event.commentKey, pendingOnly: false };
  if (event.publishedFromDraft) return { key: 'prId', value: String(event.pr.id), pendingOnly: false };
  return { key: 'prId', value: String(event.pr.id), pendingOnly: true };
}

export async function startWebhookServer(options: WebhookServerOptions): Promise<void> {
  const { port, webhookSecret } = options;

  const { stateStore, actionStore, runnerStatus, webhookEventStore, registryStore } = await connectStores();

  // Cleanup old events on startup and every hour
  webhookEventStore.cleanupOldEvents().catch?.(() => {});
  setInterval(() => { (webhookEventStore.cleanupOldEvents() as Promise<number>).catch(() => {}); }, 60 * 60 * 1000);

  // Write heartbeat on startup and every 30 seconds
  runnerStatus.writeHeartbeat('webhook-server').catch?.(() => {});
  setInterval(() => { runnerStatus.writeHeartbeat('webhook-server').catch?.(() => {}); }, 30_000);

  const server = Bun.serve({
    port,
    async fetch(req) {
      // Keep the repo registry current so a repo registered, edited, or
      // removed through the admin API takes effect without restarting this
      // process. A database blip must not fail the request — fall back to
      // the last-known registry and log.
      try {
        await refreshRegistryIfStale(registryStore, REGISTRY_TTL_MS);
      } catch (err) {
        log(`Warning: failed to refresh repo/companion registry from database: ${err instanceof Error ? err.message : err}`);
      }

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

        // Dedup — see `dedupScopeFor` for why the three triggers differ.
        const scope = dedupScopeFor(event);
        const dupe = await webhookEventStore.hasMatchingAction(0, 'review-pr', scope.key, scope.value, scope.pendingOnly);
        if (dupe) {
          const why = scope.key === 'commentKey'
            ? `comment ${scope.value} on PR #${event.pr.id} already triggered a review`
            : scope.pendingOnly
              ? `PR #${event.pr.id} already has a pending review`
              : `PR #${event.pr.id} was already reviewed — comment /review to ask for another`;
          log(`Webhook ignored: ${why}`);
          return Response.json(
            { ok: true, ignored: true, reason: scope.key === 'commentKey' ? 'duplicate comment' : 'duplicate' },
            { status: 200 },
          );
        }

        // Queue the review action
        const trigger = event.commentKey
          ? `/review comment ${event.commentKey}`
          : event.publishedFromDraft ? 'draft published' : 'PR creation';
        log(`Queuing review for PR #${event.pr.id} in ${event.pr.repositoryName} (trigger: ${trigger})`);
        await actionStore.write({
          workItemId: 0,
          type: 'review-pr',
          feedback: buildReviewPrActionFeedback(event, repo.key),
          createdAt: new Date().toISOString(),
        });

        return Response.json({ ok: true, queued: true, prId: event.pr.id }, { status: 202 });
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  log(`Webhook server listening on port ${server.port}`);
}
