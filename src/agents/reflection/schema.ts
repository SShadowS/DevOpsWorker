import { z } from 'zod';

/** Mirrors the reflection_proposals JSONB shapes; the reflect CLI converts 1:1.
 *  The ≤3 cap lives HERE as well as in the prompt: a cap only in prose is a cap
 *  the model can talk itself out of, and schema validation retries on failure. */
export const ReflectionOutputSchema = z.object({
  coverage: z.object({ total: z.number(), withSaid: z.number(), pct: z.number() }),
  adjudications: z.array(z.object({
    prId: z.number(),
    findingKey: z.string(),
    severity: z.string(),
    title: z.string(),
    verdictLabel: z.enum(['reviewer-wrong', 'human-wrong', 'both-defensible', 'unclear']),
    evidenceType: z.enum(['docs', 'code', 'branch', 'needs-measurement', 'none']),
    evidence: z.string().nullable(),
    humanQuote: z.string().nullable(),
  })),
  clusters: z.array(z.object({
    key: z.string(),
    name: z.string(),
    occurrences: z.array(z.object({ prId: z.number(), findingKey: z.string() })),
    barStatus: z.enum(['clears', 'watch']),
    barReason: z.string(),
  })),
  proposedChanges: z.array(z.object({
    target: z.enum(['core', 'overlay']),
    file: z.string(),
    unifiedDiff: z.string(),
    rationale: z.string(),
    clusterKey: z.string(),
  })).max(3),
  watchLedger: z.array(z.unknown()),
  classifierNotes: z.array(z.unknown()),
  expectedEffects: z.array(z.object({ metric: z.string(), from: z.number(), to: z.number() })),
  logEntryDraft: z.string(),
  summary: z.string(),
});
export type ReflectionOutput = z.infer<typeof ReflectionOutputSchema>;
