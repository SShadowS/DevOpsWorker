import { describe, test, expect, afterEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { acceptedSourcePr, typeSafePortClassifier, readVerdict, PORT_CONFIDENCE_FLOOR, type PortVerdict } from '../../src/sdk/port-classifier.ts';

// ---------------------------------------------------------------------------
// The gate in front of the cheap review path.
//
// Measured on 200 reviewed PRs with production-style candidates: the title
// regex missed 14 ports because a port raised against a second branch carries
// its original's title. At 0.85, with twins pooled and only older PRs offered,
// the classifier caught 10 of them and routed no original change. These pin
// the bar it has to clear.
// ---------------------------------------------------------------------------

const OWN = 56206;
const verdict = (v: Partial<PortVerdict>): PortVerdict => ({ isPort: true, confidence: 1, ...v });

describe('acceptedSourcePr', () => {
  test('a confident port with a named source routes against it', () => {
    expect(acceptedSourcePr(verdict({ confidence: 0.97, sourcePrId: 56156 }), OWN)).toBe(56156);
  });

  test('below the floor, the regex keeps the decision', () => {
    expect(acceptedSourcePr(verdict({ confidence: 0.84, sourcePrId: 56156 }), OWN)).toBeNull();
    // Exactly at the floor counts — the floor is the measured operating point.
    expect(acceptedSourcePr(verdict({ confidence: PORT_CONFIDENCE_FLOOR, sourcePrId: 56156 }), OWN)).toBe(56156);
  });

  test('a port with no named source is not actionable at any confidence', () => {
    // The cheap path compares against ONE pull request; "a port of something"
    // gives it nothing to compare against.
    expect(acceptedSourcePr(verdict({ confidence: 1 }), OWN)).toBeNull();
  });

  test('"original" is never routed, however confident', () => {
    expect(acceptedSourcePr(verdict({ isPort: false, confidence: 1, sourcePrId: 56156 }), OWN)).toBeNull();
  });

  test('a PR is never a port of itself', () => {
    // Routing on this would diff the PR against its own change and call it clean.
    expect(acceptedSourcePr(verdict({ confidence: 1, sourcePrId: OWN }), OWN)).toBeNull();
  });

  test('no verdict at all leaves behaviour exactly as it is today', () => {
    expect(acceptedSourcePr(null, OWN)).toBeNull();
  });
});

describe('readVerdict — pooling twins', () => {
  // PR 56336, as the classifier actually answered it: one fix on master
  // (!56232) ported to development/29.x (!56335) and release/29.x (!56336) in
  // the same minute. The titles are the REAL ones: each port carries its own
  // version suffix, so they are not identical strings. An earlier version of
  // this test used identical titles, passed, and missed exactly that.
  const TITLE = '#82981 Add product name to unbranded EM page captions; drop 6086525 from Tell Me';
  const twins = [
    { id: 56232, title: TITLE },
    { id: 56335, title: `${TITLE} [29.1]` },
    { id: 55904, title: 'Something unrelated' },
  ];

  test('a vote split between copies of one change is pooled, and passes', () => {
    const v = readVerdict(1.0, { pr_56335: 0.59, pr_56232: 0.39, none: 0.02, pr_55904: 0 }, twins);
    expect(v.confidence).toBeCloseTo(0.98, 2);
    expect(acceptedSourcePr(v, 56336)).not.toBeNull();
  });

  test('the route compares against the original — the oldest copy — not a sibling port', () => {
    const v = readVerdict(1.0, { pr_56335: 0.59, pr_56232: 0.39, none: 0.02 }, twins);
    expect(v.sourcePrId).toBe(56232);
  });

  test('a split between two DIFFERENT changes stays split and fails the bar', () => {
    const v = readVerdict(1.0, { pr_1: 0.5, pr_2: 0.48, none: 0.02 }, [
      { id: 1, title: 'Fix rounding on invoice totals' },
      { id: 2, title: 'Add telemetry to the export job' },
    ]);
    expect(v.confidence).toBeCloseTo(0.5, 2);
    expect(acceptedSourcePr(v, 3)).toBeNull();
  });

  test('"none" winning means no source, however sure it is that this is a port', () => {
    const v = readVerdict(0.99, { none: 0.9, pr_1: 0.1 }, [{ id: 1, title: 'x' }]);
    expect(acceptedSourcePr(v, 2)).toBeNull();
  });

  test('an unsure "is it a port" holds the verdict down even with a clear source', () => {
    const v = readVerdict(0.6, { pr_1: 1.0 }, [{ id: 1, title: 'x' }]);
    expect(v.confidence).toBeCloseTo(0.6, 2);
    expect(acceptedSourcePr(v, 2)).toBeNull();
  });
});

describe('typeSafePortClassifier', () => {
  const KEY = 'TYPESAFE_API_KEY';
  const original = process.env[KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[KEY]; else process.env[KEY] = original;
  });

  test('without a key there is no classifier, so no network call can happen', () => {
    delete process.env[KEY];
    expect(typeSafePortClassifier()).toBeNull();
  });

  test('with a key configured, a classifier is returned', () => {
    process.env[KEY] = 'test-key';
    expect(typeSafePortClassifier()).toBeTypeOf('function');
  });
});

describe('the review path records how a port was found', () => {
  const REVIEW_PR = readFileSync(join(import.meta.dir, '../../src/cli/review-pr.ts'), 'utf-8');

  test('the classifier is consulted only when the regex said no', () => {
    expect(REVIEW_PR).toContain('if (!cherryPick.isCherryPick) {');
    const idx = REVIEW_PR.indexOf('typeSafePortClassifier()');
    expect(idx).toBeGreaterThan(REVIEW_PR.indexOf('if (!cherryPick.isCherryPick) {'));
  });

  test('only OLDER pull requests are offered as sources', () => {
    // A port is always raised after what it copies. Offering newer PRs let an
    // original be matched to its own later port (!56041, !56052).
    expect(REVIEW_PR).toContain('.filter((c) => c.id < prId)');
  });

  test('a classified route is distinguishable in review_path', () => {
    // Without this the next cost read cannot tell which ports the classifier
    // found, and the change cannot be attributed.
    expect(REVIEW_PR).toContain('(classified ${classifiedPort.confidence.toFixed(2)})');
  });
});
