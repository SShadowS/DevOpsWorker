import { describe, test, expect, spyOn } from 'bun:test';
import { rowToFindingOutcome, SAID_LABELS, DID_LABELS } from '../../src/db/finding-outcome-mapper.ts';

const baseRow = {
  pr_id: 52290, finding_key: 'abc123def4567890', repo_key: 'repo-a',
  severity: 'critical', title: 'Reminder e-documents fail', file: 'App/Foo.al',
  first_raised_at: '2026-07-30T08:05:00Z', pr_settled_at: '2026-07-31T14:03:00Z',
  lead_time_mins: 1918, said: 'fixed', said_quote: 'Aligned both paths',
  said_evidence: 'pr-discussion', said_confidence: 'unanimous',
  said_votes: ['fixed', 'fixed', 'fixed'], said_batch_id: 'msgbatch_01said',
  said_model_verified: true, did: 'ADDRESSED', did_confidence: 'unanimous',
  did_votes: ['ADDRESSED', 'ADDRESSED', 'ADDRESSED'], files_read: ['app/foo.al'],
  model_verified: true, batch_id: 'msgbatch_01abc',
};

describe('rowToFindingOutcome', () => {
  test('maps snake_case columns to camelCase fields', () => {
    const o = rowToFindingOutcome(baseRow);
    expect(o.prId).toBe(52290);
    expect(o.findingKey).toBe('abc123def4567890');
    expect(o.repoKey).toBe('repo-a');
    expect(o.leadTimeMins).toBe(1918);
    expect(o.saidEvidence).toBe('pr-discussion');
    expect(o.saidQuote).toBe('Aligned both paths');
    expect(o.saidConfidence).toBe('unanimous');
    expect(o.saidVotes).toEqual(['fixed', 'fixed', 'fixed']);
    expect(o.didConfidence).toBe('unanimous');
    expect(o.modelVerified).toBe(true);
    expect(o.batchId).toBe('msgbatch_01abc');
  });

  /**
   * The two verdicts are reached by different batches on different nights, so their provenance
   * cannot share a column. A shared one does not lose the answer, it MISattributes it: the said
   * verdict reads as having come from the did batch, which asked no said question.
   */
  test('each verdict carries its own batch and its own model attestation', () => {
    const o = rowToFindingOutcome(baseRow);
    expect(o.batchId).toBe('msgbatch_01abc');
    expect(o.saidBatchId).toBe('msgbatch_01said');
    expect(o.batchId).not.toBe(o.saidBatchId);
    expect(o.modelVerified).toBe(true);
    expect(o.saidModelVerified).toBe(true);
  });

  /** A failed model check on ONE side must not be readable as a pass on the other. */
  test('a failed said model check reads false while the did attestation stands', () => {
    const o = rowToFindingOutcome({ ...baseRow, said_model_verified: false, model_verified: true });
    expect(o.saidModelVerified).toBe(false);
    expect(o.modelVerified).toBe(true);
  });

  test('preserves every ballot so a 2-1 split stays visible', () => {
    const o = rowToFindingOutcome({ ...baseRow, did: 'ADDRESSED', did_confidence: 'majority', did_votes: ['ADDRESSED', 'not', 'ADDRESSED'] });
    expect(o.didVotes).toEqual(['ADDRESSED', 'not', 'ADDRESSED']);
    expect(o.didConfidence).toBe('majority');
  });

  /**
   * `said_votes` holds each ballot AS GRADED, so the grounding gate's `ungrounded` sentinel must
   * survive the round trip. The tally cannot carry it — it has to return a `SaidLabel`, so it folds
   * `ungrounded` into `unclear` — and a row that stored the folded form would make a caught
   * fabrication indistinguishable from a model that honestly answered "unclear". That difference is
   * the whole reason the gate exists (it downgraded 8.2% of live ballots on the `did` side), so the
   * mapper must not quietly normalise the sentinel away.
   */
  test('keeps the ungrounded sentinel in said_votes rather than normalising it', () => {
    const o = rowToFindingOutcome({
      ...baseRow, said: 'unclear', said_quote: null, said_confidence: 'majority',
      said_votes: ['ungrounded', 'unclear', 'ungrounded'],
    });
    expect(o.saidVotes).toEqual(['ungrounded', 'unclear', 'ungrounded']);
    expect(o.said).toBe('unclear');
    // The winning label needed no quote, so nothing was stored — never an invented sentence.
    expect(o.saidQuote).toBeNull();
  });

  /**
   * A tie stores `said = NULL` because `SaidLabel` has no SPLIT member. Only `saidConfidence`
   * separates that from "nobody said anything", so a reader must be able to see both fields.
   */
  test('a split said verdict is a null label with a confidence that explains it', () => {
    const o = rowToFindingOutcome({
      ...baseRow, said: null, said_quote: null, said_confidence: 'split',
      said_votes: ['fixed', 'deferred', 'ignored'],
    });
    expect(o.said).toBeNull();
    expect(o.saidConfidence).toBe('split');
    expect(o.saidVotes).toEqual(['fixed', 'deferred', 'ignored']);
  });

  test('nullable columns map to null, not undefined', () => {
    const o = rowToFindingOutcome({
      ...baseRow, file: null, pr_settled_at: null, lead_time_mins: null,
      said: null, said_quote: null, said_evidence: null, said_confidence: null,
      said_votes: null, said_batch_id: null, said_model_verified: null, did: null,
      did_confidence: null, did_votes: null, files_read: null,
      model_verified: null, batch_id: null,
    });
    expect(o.file).toBeNull();
    expect(o.prSettledAt).toBeNull();
    expect(o.did).toBeNull();
    expect(o.didVotes).toBeNull();
    expect(o.saidConfidence).toBeNull();
    expect(o.saidVotes).toBeNull();
    expect(o.saidBatchId).toBeNull();
    expect(o.saidModelVerified).toBeNull();
    expect(o.modelVerified).toBeNull();
  });

  test('accepts a Date for timestamp columns (what postgres.js returns)', () => {
    const o = rowToFindingOutcome({ ...baseRow, first_raised_at: new Date('2026-07-30T08:05:00Z') });
    expect(o.firstRaisedAt).toBe('2026-07-30T08:05:00.000Z');
  });

  /**
   * `said`/`did` come off the wire as bare strings -- an unexpected value would
   * otherwise type as a legitimate label and flow silently into the dashboard's
   * denominators. Every real label must survive the validation unchanged,
   * including `SPLIT` on the `did` side: the tally genuinely stores it whenever
   * ballots don't reach a majority, so a validator that treated it as unknown
   * would null out live rows, not just malformed ones.
   */
  describe('label validation', () => {
    test('every legitimate said label round-trips', () => {
      for (const label of SAID_LABELS) {
        const o = rowToFindingOutcome({ ...baseRow, said: label });
        expect(o.said).toBe(label);
      }
    });

    test('every legitimate did label round-trips, including SPLIT', () => {
      expect(DID_LABELS).toContain('SPLIT');
      for (const label of DID_LABELS) {
        const o = rowToFindingOutcome({ ...baseRow, did: label });
        expect(o.did).toBe(label);
      }
    });

    test('an unrecognised said value maps to null instead of flowing through', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const o = rowToFindingOutcome({ ...baseRow, said: 'bogus-said-value' });
        expect(o.said).toBeNull();
        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    test('an unrecognised did value maps to null instead of flowing through', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const o = rowToFindingOutcome({ ...baseRow, did: 'bogus-did-value' });
        expect(o.did).toBeNull();
        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    /** Silently nulling a real label would be a worse, quieter failure than the
     *  one this guards against -- the unrecognised value must stay visible. */
    test('an unrecognised value warns exactly once for that distinct value, then stays silent', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        rowToFindingOutcome({ ...baseRow, said: 'repeated-bogus-value' });
        rowToFindingOutcome({ ...baseRow, said: 'repeated-bogus-value' });
        rowToFindingOutcome({ ...baseRow, said: 'repeated-bogus-value' });
        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
      }
    });

    /** A second, DIFFERENT unrecognised value is a second fact worth surfacing --
     *  the dedupe must be keyed by value, not a single "already warned" flag. */
    test('a different unrecognised value warns again', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        rowToFindingOutcome({ ...baseRow, said: 'first-distinct-bogus-value' });
        rowToFindingOutcome({ ...baseRow, said: 'second-distinct-bogus-value' });
        expect(warnSpy).toHaveBeenCalledTimes(2);
      } finally {
        warnSpy.mockRestore();
      }
    });

    test('a bogus said value and a bogus did value on the same row both null out independently', () => {
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const o = rowToFindingOutcome({ ...baseRow, said: 'nonsense-said', did: 'nonsense-did' });
        expect(o.said).toBeNull();
        expect(o.did).toBeNull();
        expect(warnSpy).toHaveBeenCalledTimes(2);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
