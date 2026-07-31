import type { CherryPickInfo } from '../../agents/pr-reviewer/config.ts';

/**
 * One changed file from a PR's diff, as returned by `fetchPRDiff`.
 *
 * Declared here rather than in `pull-requests.ts` because it is the shape a
 * cherry-pick's file set is compared against — Task 5 appends that comparison
 * logic to this file. `fetchPRDiff` only needs the shape, so it imports it
 * rather than duplicating it.
 */
export interface FileDiff {
  path: string;
  patch: string;
}

export interface RouteInput {
  cherryPick: CherryPickInfo;
  /** Full ref, e.g. `refs/heads/bug/x`. Empty when the caller did not supply one. */
  sourceBranch: string;
  sourcePrExists: boolean;
  sourceDiffFetchable: boolean;
  /**
   * Why the source diff was unavailable, when it was. Folded into the reason so
   * `review_path` says what actually went wrong instead of only that something did
   * — a bare "could not be fetched" is unfalsifiable from a database read, and that
   * is how a dead endpoint stayed invisible for this feature's whole lifetime.
   */
  sourceDiffError?: string;
  forceFull: boolean;
}

export type ReviewPath =
  | { path: 'full'; reason: string }
  | { path: 'sanity'; sourcePrId: number };

/**
 * Decide which reviewer runs, before anything is spent.
 *
 * Ordered so the cheapest determination comes first, and every `full` result
 * carries a reason — a cheap review and a failed detection are otherwise
 * indistinguishable in `pr_reviews`, which is the mistake this pipeline keeps
 * repeating. `full` is the default for every uncertainty: an unidentifiable
 * backport then costs exactly what it costs today, so a detection miss is never
 * a regression.
 */
export function chooseReviewPath(input: RouteInput): ReviewPath {
  if (input.forceFull) return { path: 'full', reason: 'forced by caller (--full or /review-full)' };
  if (!input.cherryPick.isCherryPick) return { path: 'full', reason: 'not a cherry-pick' };
  if (!input.cherryPick.originalPrId) {
    return { path: 'full', reason: 'cherry-pick detected but no source PR id in the trailer' };
  }
  // Reachable ONLY when Azure DevOps answered 404 for the PR itself. Any other
  // failure — a git error, an unreachable commit, a 500, a network blip — belongs to
  // the check below, which says so. Conflating them is what made this string a lie.
  if (!input.sourcePrExists) {
    return { path: 'full', reason: `source PR !${input.cherryPick.originalPrId} not found in this repository` };
  }
  if (!input.sourceDiffFetchable) {
    // Capped: a git error can run long and this lands in a TEXT column a human reads.
    const detail = input.sourceDiffError ? `: ${input.sourceDiffError.slice(0, 200)}` : '';
    return { path: 'full', reason: `source PR !${input.cherryPick.originalPrId} diff could not be computed${detail}` };
  }
  // Checks 2 and 3 read the working tree, which must first be checked out to the
  // PR's own branch. Without a branch name there is nothing to check out, and
  // answering from the default branch would be confidently wrong.
  if (!input.sourceBranch) {
    return { path: 'full', reason: 'PR source branch unknown — cannot check out the merge preview' };
  }
  return { path: 'sanity', sourcePrId: input.cherryPick.originalPrId };
}

export interface DiffComparison {
  missingFromPort: string[];
  extraInPort: string[];
  changedFiles: { path: string; identical: boolean }[];
}

/**
 * Repo-relative and separator-normalised, so ADO's `/Cloud/x.al`, a caller's
 * `Cloud/x.al`, and a backslash- or trailing-slash variant of the same path
 * are one file. Deliberately NOT case-folded: Azure Repos is backed by a
 * case-sensitive filesystem, so `Cloud/A.al` and `cloud/a.al` are genuinely
 * different blobs, not a formatting quirk — folding case here would risk
 * silently merging two distinct files.
 */
function normalisePath(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

/** The added/removed lines of one hunk, in their original sequence. Order within a
 *  hunk carries meaning (it's the shape of the edit), so it is preserved here — only
 *  the ordering ACROSS hunks is discarded, in `contentSignature` below. */
function hunkChangedLines(hunk: string): string {
  return hunk
    .split(/\r?\n/)
    .filter((l) => (l.startsWith('+') || l.startsWith('-')) && !l.startsWith('+++') && !l.startsWith('---'))
    .map((l) => l.trimEnd())
    // A trailing "\ No newline at end of file" marker is neither a + nor - line, so
    // it is already excluded by the filter above — deliberately invisible here, as
    // it reflects a file-ending quirk rather than a content change.
    .join('\n');
}

/**
 * Reduce a patch to the content that changed, discarding position.
 *
 * Hunk headers (`@@ -20,12 +20,20 @@`) and context lines shift on every port
 * because the target branch has different surrounding code — that is the normal
 * case, not a discrepancy. Comparing raw patches would mark every backport
 * divergent and make the check pure noise. Only added and removed lines carry
 * meaning here.
 *
 * Hunk ORDER within a file is discarded too: a port can fragment its hunks
 * differently from the source when the target's surrounding code has shifted
 * (the same false-positive as a line offset, arriving through a different door).
 * Per-hunk signatures are sorted before joining so reordering does not register as
 * a difference; sequence WITHIN a hunk is preserved (not sorted) since that
 * ordering is meaningful. Signatures are JSON-encoded so no join separator can
 * collide with real diff content.
 */
function contentSignature(patch: string): string {
  const hunks = patch.split(/(?=^@@ )/m).filter((h) => h.startsWith('@@'));
  const perHunk = hunks.map(hunkChangedLines).filter((s) => s.length > 0);
  return JSON.stringify(perHunk.sort());
}

/** Compare a port's diff against its source PR's diff. Pure. */
export function compareDiffs(source: FileDiff[], port: FileDiff[]): DiffComparison {
  // Map construction keeps the LAST entry on a duplicate path. Real ADO diff
  // responses are not expected to contain the same path twice; this is just the
  // natural behaviour of building the map, not a de-duplication decision.
  const src = new Map(source.map((d) => [normalisePath(d.path), d.patch]));
  const prt = new Map(port.map((d) => [normalisePath(d.path), d.patch]));

  const missingFromPort = [...src.keys()].filter((p) => !prt.has(p)).sort();
  const extraInPort = [...prt.keys()].filter((p) => !src.has(p)).sort();

  const changedFiles = [...src.keys()]
    .filter((p) => prt.has(p))
    .sort()
    .map((p) => ({
      path: p,
      identical: contentSignature(src.get(p)!) === contentSignature(prt.get(p)!),
    }));

  return { missingFromPort, extraInPort, changedFiles };
}

/** Render the comparison as prompt evidence. */
export function renderDiffComparison(c: DiffComparison): string {
  const lines = ['## Diff comparison against the source PR', ''];
  lines.push(
    c.missingFromPort.length
      ? `Files changed in the source but NOT in this port: ${c.missingFromPort.join(', ')}`
      : 'Files changed in the source but not in this port: none',
  );
  lines.push(
    c.extraInPort.length
      ? `Files changed in this port but NOT in the source: ${c.extraInPort.join(', ')}`
      : 'Files changed in this port but not in the source: none',
  );
  if (c.changedFiles.length) {
    lines.push('', '| File | Content vs source |', '|---|---|');
    for (const f of c.changedFiles) {
      lines.push(`| ${f.path} | ${f.identical ? 'identical' : 'differs'} |`);
    }
    // Only meaningful next to the table above — suppressed in the empty-changedFiles
    // branch below, where there is no table for it to refer to.
    lines.push(
      '',
      'Line numbers and context are excluded from this comparison — they shift on every',
      'port and carry no meaning. `differs` means the added or removed lines themselves',
      'are not the same, which is the case to judge.',
      '',
      'The source side is that PR\'s change AS MERGED. If completing it resolved a',
      'conflict, the resolution is what is compared here, not the change the author',
      'originally wrote — so a faithful port can still read as `differs`. That is the',
      'safe direction (it asks you to look), but check the source PR before treating a',
      '`differs` on an otherwise clean port as a defect.',
    );
  } else {
    lines.push('', 'No files present in both the source and this port to compare.');
  }
  return lines.join('\n');
}
