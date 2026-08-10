import { describe, test, expect } from 'bun:test';
import { detectCherryPick } from '../../../src/agents/pr-reviewer/config.ts';

// Abridged from the real PR 52307 description. The `/pullrequest/50231` URL is
// load-bearing: it cites an unrelated SIBLING fix (#79506) and appears BEFORE the
// cherry-pick trailer. The old implementation preferred it and returned 50231.
const PR_52307_DESCRIPTION = `Fixes [#80692](https://dev.azure.com/o/p/_workitems/edit/80692).

## Change

Skip registration when Document Output is not part of the license.

Same remedy already applied to the sibling subscriber in [#79506](https://dev.azure.com/o/p/_workitems/edit/79506) ([PR 50231](https://dev.azure.com/o/p/_git/Repo/pullrequest/50231)), which covered only that path.

Cherry picked from !52117

Cherry-picked from commit \`aa4ec8c1\`.`;

// Abridged from the real PR 52309 description — a port of a port. Two trailers
// accumulated; the LAST names the immediate parent (52121), the first is the
// grandparent (51720).
const PR_52309_DESCRIPTION = `## Bug #80408

Embedding attachments into an e-document collided on Insert.

Cherry picked from !51720

Cherry-picked from commit \`c9f261f3\`.

Cherry picked from !52121

Cherry-picked from commit \`fbb6d7d5\`.`;

describe('detectCherryPick', () => {
  test('detects a backport from the description trailer, not the title', () => {
    const r = detectCherryPick({ title: 'Bug #80692: Skip DO app registration', description: PR_52307_DESCRIPTION });
    expect(r.isCherryPick).toBe(true);
  });

  test('ignores an unrelated PR URL in the prose and takes the trailer', () => {
    // The whole point: 50231 is cited earlier and is same-repo and fetchable, so
    // no downstream guard would catch it.
    const r = detectCherryPick({ title: 'Bug #80692', description: PR_52307_DESCRIPTION });
    expect(r.originalPrId).toBe(52117);
    expect(r.originalPrId).not.toBe(50231);
  });

  test('takes the LAST trailer on a port of a port — the immediate parent', () => {
    const r = detectCherryPick({ title: 'Bug #80408', description: PR_52309_DESCRIPTION });
    expect(r.originalPrId).toBe(52121);
    expect(r.originalPrId).not.toBe(51720);
  });

  test('still detects the Azure DevOps UI title form', () => {
    const r = detectCherryPick({ title: 'Cherry-pick Fix posting date', description: undefined });
    expect(r.isCherryPick).toBe(true);
    expect(r.originalPrId).toBeUndefined();
  });

  test('is not a cherry-pick without a trailer or title prefix', () => {
    const r = detectCherryPick({ title: 'Bug #80692: Skip DO app registration', description: 'Fixes [#80692](url). See [PR 50231](https://dev.azure.com/o/p/_git/Repo/pullrequest/50231).' });
    expect(r.isCherryPick).toBe(false);
    expect(r.originalPrId).toBeUndefined();
  });

  test('detected but unresolvable when the trailer carries no id', () => {
    const r = detectCherryPick({ title: 'x', description: 'Cherry-picked from commit `deadbeef`.' });
    expect(r.isCherryPick).toBe(true);
    expect(r.originalPrId).toBeUndefined();
  });
});

// The backport tooling writes a second title shape that the first implementation could
// not see: the marker sits mid-title in brackets, and the description never says "picked
// FROM" anything. Nine real reviews took the full path on these titles and cost $63.71
// between them, against about $0.42 a review on the cheap path. Every title below is
// copied from one of those nine.
describe('detectCherryPick — the bracketed backport titles', () => {
  test('reads the marker mid-title, not only as a prefix', () => {
    const r = detectCherryPick({ title: 'Merged PR 52677: [Cherry-pick 25] Implement renaming of part...' });
    expect(r.isCherryPick).toBe(true);
  });

  test('takes the parent PR from the Merged PR prefix', () => {
    const r = detectCherryPick({ title: 'Merged PR 52677: [Cherry-pick 25] Implement renaming of part...' });
    expect(r.originalPrId).toBe(52677);
  });

  test('the bracketed number is a Business Central version, never a PR id', () => {
    // "[Cherry-pick 25]" means the 25.x branch. Reading it as PR 25 would send the
    // sanity check off to compare against an unrelated four-year-old change.
    const r = detectCherryPick({ title: 'Merged PR 52677: [Cherry-pick 25] Implement renaming of part...' });
    expect(r.originalPrId).not.toBe(25);
  });

  test('a port of a port takes the FIRST Merged PR — the nearest ancestor', () => {
    // PR 52847: 52705 is the port it was taken from, 52680 the one before that.
    // Same rule as the trailers above, where the newest wins; here the nearest
    // ancestor is the outermost prefix.
    const r = detectCherryPick({ title: 'Merged PR 52705: Merged PR 52680: [Cherry-pick 26] Remove DK prefix from 0184...' });
    expect(r.originalPrId).toBe(52705);
    expect(r.originalPrId).not.toBe(52680);
  });

  test('the marker is case-insensitive', () => {
    // PR 52820 capitalises it differently from the other eight.
    const r = detectCherryPick({ title: 'Merged PR 52658: [Cherry-Pick 25] Allow sending eDocs to peppol DK:DIGST' });
    expect(r.isCherryPick).toBe(true);
    expect(r.originalPrId).toBe(52658);
  });

  test('a plain merge title is NOT a cherry-pick', () => {
    // This is the guard that keeps the rule narrow. Every squash-merged PR in this
    // organisation carries a "Merged PR <id>:" prefix, so the prefix alone must mean
    // nothing — the cherry-pick marker has to be present too.
    const r = detectCherryPick({ title: 'Merged PR 52700: Fix posting date on service invoices' });
    expect(r.isCherryPick).toBe(false);
    expect(r.originalPrId).toBeUndefined();
  });

  test('an explicit trailer still beats the title prefix', () => {
    // A description that says where it came from is stronger evidence than a merge
    // prefix, which only says which PR this branch was cut from.
    const r = detectCherryPick({
      title: 'Merged PR 52677: [Cherry-pick 25] Implement renaming of part...',
      description: 'Cherry picked from !52121',
    });
    expect(r.originalPrId).toBe(52121);
  });

  test('the description carries the bracketed marker too, and that alone is enough', () => {
    const r = detectCherryPick({
      title: 'Remove DK prefix from 0184 in participation management',
      description: 'Merged PR 52052: [Cherry-pick 28] Remove DK prefix from 0184\n\nRelated work items: #78364',
    });
    expect(r.isCherryPick).toBe(true);
    expect(r.originalPrId).toBe(52052);
  });
});

// Every case below is a way the widened detection could send a change that is NOT a port
// down the cheap path. That path compares against the source PR's existing review instead
// of reading the code, so a wrong answer here is a shallow review of a real change — and
// `chooseReviewPath`'s fallbacks only catch a parent that does not exist or whose diff
// will not compute. A wrong-but-real parent sails straight through.
describe('detectCherryPick — what must NOT route to the cheap path', () => {
  test('a revert of a port is not a port', () => {
    // Azure DevOps titles a revert by quoting the original, so the marker comes along
    // for the ride. Comparing a revert against the PR it undoes would call every file
    // diverged and describe the change as something it is the opposite of.
    const r = detectCherryPick({ title: 'Revert "Merged PR 52680: [Cherry-pick 26] Remove DK prefix from 0184"' });
    expect(r.isCherryPick).toBe(false);
    expect(r.originalPrId).toBeUndefined();
  });

  test('a prose mention of another merged PR is not a parent', () => {
    // No colon: `Merged PR 51000:` is a squash-merge prefix, "merged PR 51000 did" is a
    // person writing a sentence. 51000 is real and fetchable, so nothing downstream
    // would notice the sanity check reading the wrong PR.
    const r = detectCherryPick({
      title: '[Cherry-pick 25] Align posting date with what merged PR 51000 did',
    });
    expect(r.isCherryPick).toBe(true);
    expect(r.originalPrId).toBeUndefined();
  });

  test('on the bracketed shape the merge prefix beats a PR URL in the prose', () => {
    // The 52307 lesson on the newer shape: the prefix is written by the tooling, the URL
    // is typed by a person and usually cites a sibling fix, not the source.
    const r = detectCherryPick({
      title: 'Merged PR 52705: [Cherry-pick 26] Remove DK prefix from 0184',
      description: 'Same remedy as [PR 50231](https://dev.azure.com/o/p/_git/Repo/pullrequest/50231).',
    });
    expect(r.originalPrId).toBe(52705);
    expect(r.originalPrId).not.toBe(50231);
  });

  test('an explicit trailer still outranks the merge prefix', () => {
    const r = detectCherryPick({
      title: 'Merged PR 52705: [Cherry-pick 26] Remove DK prefix from 0184',
      description: 'Cherry picked from !52121',
    });
    expect(r.originalPrId).toBe(52121);
  });

  test('the Azure DevOps button shape is unaffected — URL still resolves it', () => {
    // No bracketed marker here, so the ordering above must not apply.
    const r = detectCherryPick({
      title: 'Cherry-pick Fix posting date',
      description: 'Ported from [PR 52117](https://dev.azure.com/o/p/_git/Repo/pullrequest/52117).',
    });
    expect(r.isCherryPick).toBe(true);
    expect(r.originalPrId).toBe(52117);
  });
});
