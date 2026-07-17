// ---------------------------------------------------------------------------
// Rerun-command scanners — grouped here as one concept for callers (checkpoint
// polling treats "did a human ask for a rerun" as a single question), but each
// scanner is tightly coupled to its own resource's comment-fetching shape:
// `findRerunCommandInComments` shares `WorkItemCommentsResponse` with
// `fetchWorkItemCommentsSince` (work-items.ts), and `findRerunCommandInPRComments`
// shares `PRThreadsResponse` with `fetchPRReviewComments` (pull-requests.ts).
// So the implementations live with their resource; this module just re-exports
// both together for discoverability.
// ---------------------------------------------------------------------------

export { findRerunCommandInComments } from './work-items.ts';
export { findRerunCommandInPRComments } from './pull-requests.ts';
