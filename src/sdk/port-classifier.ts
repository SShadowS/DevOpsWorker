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
 * Measured on 200 reviewed pull requests with production-style candidates
 * (every PR in the repository at review time, older ones only, twins pooled):
 * at 0.85 the classifier caught 10 of the 14 ports the title regex missed and
 * routed no original change. 0.95 caught 3. The only "wrong" routes at 0.85
 * were a port the reviewer agent itself mislabelled.
 *
 * An earlier eval put this at 0.95, but it never showed the classifier a
 * same-minute sibling port, which is the case that decides the floor.
 */
export const PORT_CONFIDENCE_FLOOR = 0.85;

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

/** The two questions, exported so an offline eval asks exactly what production asks. */
export const PORT_QUESTIONS = {
  isPort: 'Does this pull request re-apply a change that was already made on another branch — a cherry-pick, a backport, or the same change raised again against a second branch — rather than being original work?',
  portedFrom: 'Which of the recent pull requests in this repository is this pull request a copy of? Answer none when it is original work, or when no listed pull request is the same change.',
} as const;

/** The state the classifier reads, exported for the same reason. */
export function portState(q: PortQuestion): Record<string, string> {
  return {
    title: q.title,
    description: q.description.slice(0, 4000),
    source_branch: q.sourceBranch,
    target_branch: q.targetBranch,
    recent_pull_requests_in_this_repository: q.candidates.map((c) => `!${c.id}: ${c.title}`).join('\n'),
  };
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
      state: portState(q),
      questions: {
        is_port: sdk.choice(PORT_QUESTIONS.isPort, { port: null, original: null }),
        ported_from: sdk.choice(PORT_QUESTIONS.portedFrom, options),
      },
    });

    return readVerdict(
      answers.is_port.probabilities.port,
      answers.ported_from.probabilities as Record<string, number>,
      q.candidates,
    );
  };
}

/**
 * Turn the classifier's two probability distributions into one routing verdict.
 *
 * A fix is often ported to several branches in the same minute, and every copy
 * carries the same title. For the second port, the candidate list then holds
 * the original AND its sibling port, and "which one is this a copy of?" splits
 * between them — PR 56336 read 0.59 / 0.39 across two copies of one change,
 * with only 0.02 on "none", while "is it a port?" was 1.00. Taking the single
 * top option's confidence threw that answer away.
 *
 * So the probability of candidates that are the SAME change (same title) is
 * pooled, the pool must clear the bar, and the route compares against the
 * OLDEST PR in it — the original, not a sibling port. A split between two
 * DIFFERENT changes stays split and fails the bar, which is the case the bar is
 * there for.
 */
export function readVerdict(
  pPort: number,
  sourceProbabilities: Record<string, number>,
  candidates: PortCandidate[],
): PortVerdict {
  // Copies of one change are NOT identical strings: the porting tool appends the
  // branch or version — `… Tell Me`, `… Tell Me [29.1]`, `… Tell Me [29.0.1]`
  // on !56232/!56335/!56336. Bracketed segments are dropped before comparing.
  const sameTitle = (t: string) => t.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const groups = new Map<string, { mass: number; oldestId: number }>();
  for (const c of candidates) {
    const p = sourceProbabilities[`pr_${c.id}`] ?? 0;
    const g = groups.get(sameTitle(c.title)) ?? { mass: 0, oldestId: Number.POSITIVE_INFINITY };
    g.mass += p;
    g.oldestId = Math.min(g.oldestId, c.id);
    groups.set(sameTitle(c.title), g);
  }
  const best = [...groups.values()].sort((a, b) => b.mass - a.mass)[0];

  return {
    isPort: pPort >= 0.5,
    // Both halves must hold: it is a port, and it is a port of THIS change.
    confidence: Math.min(pPort, best?.mass ?? 0),
    ...(best && best.mass > 0 ? { sourcePrId: best.oldestId } : {}),
  };
}
