import type { PipelineState } from '../types/pipeline.types.ts';
import {
  formatReadinessComment,
  formatPlanComment,
  formatConvergenceEscalation,
} from './devops-comment.ts';

// ---------------------------------------------------------------------------
// Stage comments — the one table of what each stage posts, and in which format
//
// `postWorkItemComment` takes the format as a query parameter and defaults to
// `html`. Azure DevOps does not sniff the content: a Markdown comment posted as
// html renders `##` and table pipes as literal characters and collapses every
// newline, which turns a dev plan into one unreadable paragraph. Only the
// `<details>` blocks survive, because those are real HTML either way.
//
// `run.ts` and `continue.ts` each carried their own copy of this table, and the
// copy in `continue.ts` had dropped the format — so a plan comment rendered on a
// first run and was mangled on every RESUMED run. Work item 81098 hit it because
// resuming is exactly what a rerun does. One table, imported by both, so the two
// cannot drift apart again.
// ---------------------------------------------------------------------------

export interface StageComment {
  /** Returns the comment body, or null when this stage has nothing to say. */
  fn: (workItemId: number, state: PipelineState) => string | null;
  /** Must match what `fn` actually emits. Pinned by tests/formatters/stage-comments.test.ts. */
  format: 'html' | 'markdown';
}

export const STAGE_COMMENTS: Record<string, StageComment> = {
  analyzer: {
    fn: (wid, s) => (s.readiness ? formatReadinessComment(wid, s.readiness) : null),
    format: 'html',
  },
  planning: {
    fn: (wid, s) => (s.devPlan ? formatPlanComment(wid, s.devPlan) : null),
    format: 'markdown',
  },
  // Fires only when the loop escalated — the formatter returns null otherwise,
  // so a normal `coding` completion posts nothing.
  coding: {
    fn: formatConvergenceEscalation,
    format: 'markdown',
  },
};
