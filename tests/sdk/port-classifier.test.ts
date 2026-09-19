import { describe, test, expect, afterEach } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { acceptedSourcePr, typeSafePortClassifier, PORT_CONFIDENCE_FLOOR, type PortVerdict } from '../../src/sdk/port-classifier.ts';

// ---------------------------------------------------------------------------
// The gate in front of the cheap review path.
//
// Measured on the last 100 reviewed PRs: the title regex missed 9 ports
// ($29.30 of full reviews) because a port raised against a second branch
// carries its original's title verbatim. The classifier caught them, and at
// 0.95 produced one wrong match. These pin the bar it has to clear.
// ---------------------------------------------------------------------------

const OWN = 56206;
const verdict = (v: Partial<PortVerdict>): PortVerdict => ({ isPort: true, confidence: 1, ...v });

describe('acceptedSourcePr', () => {
  test('a confident port with a named source routes against it', () => {
    expect(acceptedSourcePr(verdict({ confidence: 0.97, sourcePrId: 56156 }), OWN)).toBe(56156);
  });

  test('below the floor, the regex keeps the decision', () => {
    expect(acceptedSourcePr(verdict({ confidence: 0.94, sourcePrId: 56156 }), OWN)).toBeNull();
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

  test('a classified route is distinguishable in review_path', () => {
    // Without this the next cost read cannot tell which ports the classifier
    // found, and the change cannot be attributed.
    expect(REVIEW_PR).toContain('(classified ${classifiedPort.confidence.toFixed(2)})');
  });
});
