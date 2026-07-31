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
