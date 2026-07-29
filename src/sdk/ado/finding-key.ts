import { createHash } from 'crypto';

/**
 * Identity of a finding across re-reviews.
 *
 * Deliberately excludes the line number: Azure DevOps re-anchors threads across
 * PR iterations itself, so a pushed commit shifts the line while the finding is
 * unchanged. Keying on the line would open a duplicate thread on every push.
 *
 * The file path is normalised too: a leading slash is stripped and backslashes
 * become forward slashes, so `/App/x.al`, `App/x.al` and `App\x.al` all hash to
 * the same identity. Without this, ADO's slash-prefixed anchor spelling and the
 * model's repo-relative spelling are different findings — which is exactly the
 * ambiguity `fileSpellingMatchingKey` in review-pr.ts otherwise has to search
 * around every time it reads a marker thread back.
 *
 * The title is normalised so trivial rewording does not fork the key. A reviewer
 * that rephrases substantially WILL produce a new key and therefore a duplicate
 * thread — accepted, because the failure mode is noise rather than a wrong or
 * lost comment.
 */
export function findingKey(file: string, title: string): string {
  const normalisedFile = file.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  const normalisedTitle = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return createHash('sha1')
    .update(`${normalisedFile}::${normalisedTitle}`)
    .digest('hex')
    .slice(0, 16);
}

/** Matches only OUR marker — a foreign `<!-- tool:xyz -->` must not match. */
export const FINDING_MARKER_RE = /<!--\s*ai-finding:([0-9a-f]{16})\s*-->/;

export function markerFor(key: string): string {
  return `<!-- ai-finding:${key} -->`;
}

export function extractKey(content: string): string | null {
  return content.match(FINDING_MARKER_RE)?.[1] ?? null;
}
