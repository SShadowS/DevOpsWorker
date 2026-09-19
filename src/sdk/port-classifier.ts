/**
 * Second opinion on "is this pull request a port?", for the PRs the title
 * regex cannot see.
 *
 * `detectCherryPick` reads words — "cherry-pick", "backport", a bracketed
 * marker. That works when the porting tool writes one, and fails completely on
 * the shape where it copies the original PR's title verbatim onto a second
 * branch: the port and its original are then the SAME string, so no amount of
 * pattern work separates them. Measured over the last 100 reviewed pull
 * requests, that cost 9 missed ports and $29.30 of full reviews that the cheap
 * path does for about $0.47.
 *
 * What separates them is the candidate list — the other recent pull requests in
 * the repository. A port is the one whose twin already exists.
 *
 * Off unless `TYPESAFE_API_KEY` is set, and consulted ONLY when the regex
 * already said no, so the worst case is exactly today's behaviour. Everything
 * downstream still applies: the source PR must exist, its diff must be
 * fetchable, and it must share files with this one, or `chooseReviewPath` sends
 * the review down the full path anyway. A wrong match therefore costs a full
 * review, which is what a missed port costs today.
 */

export interface PortCandidate {
  id: number;
  title: string;
}

export interface PortQuestion {
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  /** Other recent pull requests in this repository; a port's original is among them. */
  candidates: PortCandidate[];
}

export interface PortVerdict {
  isPort: boolean;
  /** 0..1, as reported by the classifier. */
  confidence: number;
  /** The pull request this one appears to copy. Absent when none was identified. */
  sourcePrId?: number;
}

export type PortClassifier = (q: PortQuestion) => Promise<PortVerdict | null>;

/**
 * Measured on the eval corpus: at 0.95 the classifier caught every port and
 * produced one wrong match in 100 pull requests. Lower floors add wrong matches
 * without catching anything more, because every true port it found scored 0.93
 * or above.
 */
export const PORT_CONFIDENCE_FLOOR = 0.95;

/**
 * The source pull request worth routing against, or null to leave the regex's
 * answer alone.
 *
 * A verdict with no source PR is not actionable however confident it is: the
 * cheap path compares against one named PR, so "this is a port of something"
 * buys nothing.
 */
export function acceptedSourcePr(
  verdict: PortVerdict | null,
  ownPrId: number,
  floor: number = PORT_CONFIDENCE_FLOOR,
): number | null {
  if (!verdict || !verdict.isPort) return null;
  if (verdict.sourcePrId === undefined) return null;
  // A PR is never a port of itself; a classifier that says so is confused, and
  // routing on it would compare the PR against its own diff and call it clean.
  if (verdict.sourcePrId === ownPrId) return null;
  return verdict.confidence >= floor ? verdict.sourcePrId : null;
}

/**
 * The TypeSafe-backed classifier, or null when no key is configured.
 *
 * The SDK is imported dynamically so an image built without the package
 * degrades to "no classifier" instead of failing to start.
 */
export function typeSafePortClassifier(): PortClassifier | null {
  if (!process.env['TYPESAFE_API_KEY']) return null;

  return async (q: PortQuestion): Promise<PortVerdict | null> => {
    const sdk = await import('@typesafe-ai/sdk').catch(() => null);
    if (!sdk) return null;

    const options: Record<string, null> = { none: null };
    for (const c of q.candidates) options[`pr_${c.id}`] = null;

    const { answers } = await new sdk.TypeSafeClient().systemOne({
      state: {
        title: q.title,
        description: q.description.slice(0, 4000),
        source_branch: q.sourceBranch,
        target_branch: q.targetBranch,
        recent_pull_requests_in_this_repository: q.candidates.map((c) => `!${c.id}: ${c.title}`).join('\n'),
      },
      questions: {
        is_port: sdk.choice(
          'Does this pull request re-apply a change that was already made on another branch — a cherry-pick, a backport, or the same change raised again against a second branch — rather than being original work?',
          { port: null, original: null },
        ),
        ported_from: sdk.choice(
          'Which of the recent pull requests in this repository is this pull request a copy of? Answer none when it is original work, or when no listed pull request is the same change.',
          options,
        ),
      },
    });

    const source = answers.ported_from.choice;
    const sourcePrId = source.startsWith('pr_') ? Number(source.slice(3)) : undefined;
    return {
      isPort: answers.is_port.choice === 'port',
      // The pair has to agree: the routing decision needs a named source, so the
      // confidence that matters is the weaker of "is it a port" and "which one".
      confidence: Math.min(answers.is_port.confidence, answers.ported_from.confidence),
      ...(sourcePrId !== undefined && Number.isFinite(sourcePrId) ? { sourcePrId } : {}),
    };
  };
}
