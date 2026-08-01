import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Regression guard for the exact failure class this task caught: Task 1 wrote
// `isTest` at the store layer (PRReviewRow / pg-pr-review-store.ts) and it was
// read by nobody — `DashboardPRReview` never declared the field, and neither
// `readPRReviews` nor `readPRReviewDetail` set it on the objects they return.
// Every row reaching `/api/pr-reviews` had `isTest === undefined` forever, so
// `badgeForReview` would have rendered on zero real rows despite passing all
// of its own unit tests (pr-review-badge.test.ts exercises the pure function
// directly and never touches the data that actually reaches it).
//
// This pins the source text of the three sites that all have to agree for
// the field to survive the trip from Postgres to the browser — same
// source-text-pin approach Tasks 1-3 used for their own multi-site traps
// (INSERT/SELECT column parity in pg-pr-review-store.ts, the population
// param threaded through every stats query). No test here may open a
// database connection, matching the rest of tests/dashboard/.

const typesSrc = readFileSync(fileURLToPath(new URL('../../src/dashboard/types.ts', import.meta.url)), 'utf-8');
const stateReaderSrc = readFileSync(fileURLToPath(new URL('../../src/dashboard/state-reader.ts', import.meta.url)), 'utf-8');

describe('DashboardPRReview DTO carries isTest to the client', () => {
  test('DashboardPRReview declares isTest', () => {
    const iface = typesSrc.match(/export interface DashboardPRReview \{[\s\S]*?\n\}/);
    expect(iface).not.toBeNull();
    expect(iface![0]).toContain('isTest: boolean');
  });

  test('readPRReviews sets isTest on completed rows', () => {
    const fn = stateReaderSrc.match(/export async function readPRReviews[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain('isTest: r.isTest');
  });

  test('readPRReviews sets isTest on pending/in-progress rows', () => {
    const fn = stateReaderSrc.match(/export async function readPRReviews[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain('isTest: false');
  });

  test('readPRReviewDetail sets isTest', () => {
    const fn = stateReaderSrc.match(/export async function readPRReviewDetail[\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain('isTest: r.isTest');
  });
});
