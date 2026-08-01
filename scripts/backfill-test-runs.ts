#!/usr/bin/env bun
// One-off history correction. No flag existed before 2026-08-01, so the boundary is
// inferred: a run that was never posted (comment_id = 0) or replayed a completed PR whose
// source branch ADO had already deleted (source_branch = ''). Approved 2026-08-01 — see
// the design doc in the private overlay for the row count and the reasoning behind the
// boundary. Deliberately NOT a migration — this is a judgement about one database's past.
import postgres from 'postgres';

export const BACKFILL_PREDICATE = "comment_id = 0 OR source_branch = ''";

export function parseArgs(argv: string[]): { apply: boolean } {
  return { apply: argv.includes('--apply') };
}

if (import.meta.main) {
  const { apply } = parseArgs(process.argv.slice(2));
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL unset');
  const sql = postgres(url, { max: 2 });
  try {
    const [row] = await sql.unsafe<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM pr_reviews WHERE (${BACKFILL_PREDICATE}) AND is_test = false`);
    const count = row?.count ?? 0;
    console.log(`${count} row(s) match and are not yet marked.`);
    if (!apply) { console.log('Dry run. Re-run with --apply to write.'); }
    else {
      const res = await sql.unsafe(
        `UPDATE pr_reviews SET is_test = true WHERE (${BACKFILL_PREDICATE}) AND is_test = false`);
      console.log(`Marked ${res.count} row(s) as test runs.`);
    }
  } finally { await sql.end(); }
}
