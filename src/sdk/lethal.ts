import type { FileDiff } from './ado/backport.ts';

// ---------------------------------------------------------------------------
// LethAL mutation-testing results -> test-gap leads for the PR reviewer.
//
// LethAL mutates the code and reruns the tests. A mutant that SURVIVES was
// executed by a test (when `executionProven`) and nothing noticed the change:
// the test runs that code but does not check it. A `no-coverage` mutant was
// never executed by any test.
//
// The CI step publishes a build artifact named `lethal-report` holding:
//   report.json   `lethal run --out`            (report schema v2)
//   explain.json  `lethal explain report.json`  (explain schema v4)
//   exit-code     the `lethal run` exit code, as text
// Structure, not prose, is LethAL's contract: `explain.json` says its field names
// and value domains are stable under `explainSchemaVersion`, and that `meaning`,
// `note` and similar sentences may be reworded at any time. Only fields are read.
// ---------------------------------------------------------------------------

export const LETHAL_ARTIFACT = 'lethal-report';

interface ExplainSurvivor {
  mutantCode: string;
  file: string;
  line: number;
  procedureName: string;
  operatorName: string;
  originalText: string;
  mutatedText: string;
  attribution: string;
  executionProven: boolean;
  coveringTests: string[];
}

interface ReportMutant {
  mutantCode: string;
  file: string;
  line: number;
  procedureName: string;
  verdict: string;
}

export interface LethalFiles {
  explain: { explainSchemaVersion: number; survivors: ExplainSurvivor[] };
  report: {
    schemaVersion: number;
    baselineGreen: boolean;
    mutants: ReportMutant[];
    likelyEquivalentSurvivors?: { byRisk: { risk: string; mutants: string[] }[] };
  };
  exitCode?: number;
}

export interface SurvivorLead {
  code: string;
  line: number;
  operator: string;
  original: string;
  mutated: string;
  coveringTests: string[];
  /** LethAL's own flag that this kind of mutant is often equivalent (changes nothing). */
  equivalenceRisk?: string;
}

export interface ProcedureLeads {
  /** Repo-relative path, as the PR diff names it. */
  file: string;
  procedure: string;
  survivors: SurvivorLead[];
}

export interface NoCoverageLead {
  file: string;
  procedure: string;
  lines: number[];
}

export type TestGapLeads =
  | { usable: true; procedures: ProcedureLeads[]; noCoverage: NoCoverageLead[] }
  | { usable: false; reason: string };

/**
 * Lines the PR added or changed, per repo-relative file, read from its unified
 * diffs (`fetchPRDiff`). Only right-side lines count: that is where a mutant sits.
 */
export function changedLines(files: FileDiff[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const { path, patch } of files) {
    const lines = new Set<number>();
    let right = 0;
    for (const l of patch.split('\n')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (hunk) { right = Number(hunk[1]); continue; }
      if (right === 0 || l.startsWith('\\')) continue;
      if (l.startsWith('+')) { if (!l.startsWith('+++')) lines.add(right++); }
      else if (!l.startsWith('-')) right++;
    }
    out.set(path.replace(/^\//, ''), lines);
  }
  return out;
}

/**
 * LethAL names files relative to the app project it ran on (`src\X.al`); the PR
 * diff names them relative to the repo root (`Cloud/src/X.al`). Match by suffix.
 */
function repoPath(lethalFile: string, changed: Map<string, Set<number>>): string | undefined {
  const tail = lethalFile.replace(/\\/g, '/').replace(/^\.?\//, '');
  for (const p of changed.keys()) if (p === tail || p.endsWith(`/${tail}`)) return p;
  return undefined;
}

// ponytail: fixed caps keep the prompt bounded; make them knobs if a PR ever needs more.
const MAX_PROCEDURES = 12;
const MAX_SURVIVORS_PER_PROCEDURE = 6;
const MAX_TESTS_SHOWN = 3;

export function buildTestGapLeads(files: LethalFiles, changed: Map<string, Set<number>>): TestGapLeads {
  const { explain, report, exitCode } = files;
  // 3 = quarantined, 4 = nothing scored: LethAL's own "no usable result".
  if (exitCode === 3 || exitCode === 4) return { usable: false, reason: `lethal exited ${exitCode}` };
  if (explain.explainSchemaVersion !== 4) return { usable: false, reason: `explain schema v${explain.explainSchemaVersion}, expected v4` };
  if (report.schemaVersion !== 2) return { usable: false, reason: `report schema v${report.schemaVersion}, expected v2` };
  if (!report.baselineGreen) return { usable: false, reason: 'the tests failed before any mutation' };

  const risk = new Map<string, string>();
  for (const r of report.likelyEquivalentSurvivors?.byRisk ?? []) for (const m of r.mutants) risk.set(m, r.risk);

  const onChangedLine = (file: string, line: number) => {
    const p = repoPath(file, changed);
    return p && changed.get(p)!.has(line) ? p : undefined;
  };

  const groups = new Map<string, ProcedureLeads>();
  for (const s of explain.survivors) {
    // `exact` attribution + executionProven: a test is known to have run this very
    // mutant. Anything weaker cannot tell "not checked" from "not reached".
    if (!s.executionProven || s.attribution !== 'exact') continue;
    const file = onChangedLine(s.file, s.line);
    if (!file) continue;
    const procedure = s.procedureName || '(object level)';
    const key = `${file}::${procedure}`;
    const g = groups.get(key) ?? { file, procedure, survivors: [] };
    g.survivors.push({
      code: s.mutantCode,
      line: s.line,
      operator: s.operatorName,
      original: s.originalText,
      mutated: s.mutatedText,
      coveringTests: s.coveringTests,
      ...(risk.has(s.mutantCode) ? { equivalenceRisk: risk.get(s.mutantCode)! } : {}),
    });
    groups.set(key, g);
  }

  const uncovered = new Map<string, NoCoverageLead>();
  for (const m of report.mutants) {
    if (m.verdict !== 'no-coverage') continue;
    const file = onChangedLine(m.file, m.line);
    if (!file) continue;
    const procedure = m.procedureName || '(object level)';
    const key = `${file}::${procedure}`;
    const g = uncovered.get(key) ?? { file, procedure, lines: [] };
    if (!g.lines.includes(m.line)) g.lines.push(m.line);
    uncovered.set(key, g);
  }

  const procedures = [...groups.values()]
    .sort((a, b) => b.survivors.length - a.survivors.length)
    .slice(0, MAX_PROCEDURES);
  return { usable: true, procedures, noCoverage: [...uncovered.values()] };
}

/** Marker for the prompt block, so tests and logs can find it. */
export const TEST_GAP_MARKER = '## Mutation-testing leads (LethAL)';

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 160);

/** The block the orchestrator hands to `test-gap-analyzer`. '' when there is nothing to hand. */
export function renderTestGapBlock(leads: TestGapLeads): string {
  if (!leads.usable || (leads.procedures.length === 0 && leads.noCoverage.length === 0)) return '';
  const out = [
    TEST_GAP_MARKER,
    '',
    'LethAL ran this PR\'s tests against mutated copies of the code it changed. Each',
    'survivor below is a change to a line this PR touched that a test EXECUTED and',
    'still passed: the test runs the code but checks nothing that would catch the change.',
    '',
    'In Phase 4, also dispatch the `test-gap-analyzer` agent and pass it this whole',
    'section unchanged. Its findings are test-gap leads, never blockers; attribute them',
    'with `foundBy: ["test-gap-analyzer"]`.',
    '',
  ];
  for (const p of leads.procedures) {
    out.push(`### ${p.file} — ${p.procedure} (${p.survivors.length} survived)`);
    const tests = [...new Set(p.survivors.flatMap((s) => s.coveringTests))];
    out.push(`Covering tests (${tests.length}): ${tests.slice(0, MAX_TESTS_SHOWN).join('; ')}${tests.length > MAX_TESTS_SHOWN ? '; …' : ''}`);
    for (const s of p.survivors.slice(0, MAX_SURVIVORS_PER_PROCEDURE)) {
      const r = s.equivalenceRisk ? ` [often equivalent: ${s.equivalenceRisk}]` : '';
      out.push(`- ${s.code} line ${s.line}, ${s.operator}${r}: \`${oneLine(s.original)}\` → \`${oneLine(s.mutated)}\``);
    }
    if (p.survivors.length > MAX_SURVIVORS_PER_PROCEDURE) out.push(`- … ${p.survivors.length - MAX_SURVIVORS_PER_PROCEDURE} more`);
    out.push('');
  }
  if (leads.noCoverage.length > 0) {
    out.push('### Not executed by any test');
    for (const n of leads.noCoverage) out.push(`- ${n.file} — ${n.procedure} (lines ${n.lines.sort((a, b) => a - b).join(', ')})`);
    out.push('');
  }
  return out.join('\n');
}
