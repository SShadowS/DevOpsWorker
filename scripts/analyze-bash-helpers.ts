#!/usr/bin/env bun
/**
 * One-shot Bash-pattern clustering for stage_logs.
 *
 * Usage: bun scripts/analyze-bash-helpers.ts --entity-type work_item --stage-name coding [--since '2026-03-01'] [--top 30] [--min-count 3]
 */

import postgres from 'postgres';

type Args = {
  entityType: 'pull_request' | 'work_item' | 'all';
  stageName?: string;
  since?: string;
  top: number;
  minCount: number;
};

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    entityType: (get('--entity-type') as Args['entityType']) ?? 'pull_request',
    stageName: get('--stage-name'),
    since: get('--since'),
    top: Number(get('--top') ?? 30),
    minCount: Number(get('--min-count') ?? 3),
  };
}

function extractCommand(content: string): string | null {
  // content is the logger block with a JSON body. Pull the value of "command" tolerantly.
  // The JSON is pretty-printed, command field is on its own line, may span multiple lines.
  const m = content.match(/"command":\s*"((?:\\.|[^"\\])*)"/s);
  if (!m) return null;
  // Unescape JSON string
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

function normalize(cmd: string): string {
  let s = cmd;
  // mcp tool-result paths
  s = s.replace(/\/tmp\/[\w./-]*tool-results\/[\w.-]+/g, '<MCP_RESULT>');
  s = s.replace(/tool-results\/[\w.-]+/g, '<MCP_RESULT>');
  // Workspace session paths -> <REPO>
  s = s.replace(/\/workspace\/session\/[\w-]+\/?/g, '<REPO>/');
  s = s.replace(/\/workspace\/session\/?/g, '<REPO>/');
  // git refs with branch names containing #digits or userstory/...
  s = s.replace(/(origin\/)?userstory\/#?\d+[\w-/]*/g, '<BRANCH>');
  s = s.replace(/(origin\/)?(feature|bugfix|hotfix)\/[\w./-]+/g, '<BRANCH>');
  // Hex SHAs
  s = s.replace(/\b[0-9a-f]{7,40}\b/g, '<SHA>');
  // Pipeline IDs / numbers in `--id 12345`, `pipelines run --id <NUM>`
  s = s.replace(/\b\d{3,}\b/g, '<NUM>');
  // Python -c "..." longer-than-80: classify by imports/calls
  s = s.replace(/python3?\s+-c\s+(['"])([\s\S]+?)\1/g, (_m, _q, body) => {
    if (body.length < 60) return `python3 -c <SHORT-PY>`;
    const keys: string[] = [];
    if (/\bjson\b/.test(body)) keys.push('json');
    if (/\bre\./.test(body) || /\bimport re\b/.test(body)) keys.push('re');
    if (/\burllib|requests|http/.test(body)) keys.push('http');
    if (/\bos\./.test(body)) keys.push('os');
    if (/\bsys\./.test(body)) keys.push('sys');
    return `python3 -c <PY-SCRIPT-(${keys.join('|') || 'plain'})>`;
  });
  // Collapse repeated whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function classify(cmd: string): string {
  // Coarse intent buckets for top-line summary.
  if (/^git\b/.test(cmd) || /^cd .* && git\b/.test(cmd)) return 'git';
  if (/^bun\b/.test(cmd)) return 'bun';
  if (/python3?\s+-c/.test(cmd)) return 'inline-python';
  if (/^cat\b/.test(cmd)) return 'cat';
  if (/^ls\b/.test(cmd) || /^find\b/.test(cmd)) return 'fs-list';
  if (/^grep\b/.test(cmd) || /\| grep/.test(cmd)) return 'grep';
  if (/^az\b/.test(cmd) || /\baz pipelines\b/.test(cmd)) return 'az';
  if (/^echo\b/.test(cmd)) return 'echo';
  if (/^mkdir\b|^rm\b|^cp\b|^mv\b/.test(cmd)) return 'fs-write';
  if (/^head\b|^tail\b|^wc\b/.test(cmd)) return 'fs-read';
  return 'other';
}

async function main() {
  const args = parseArgs();
  const url = process.env.DATABASE_URL || 'postgres://pipeline:pipeline@localhost:5432/pipeline';
  const sql = postgres(url);

  const sinceClause = args.since
    ? sql`AND created_at >= ${args.since}`
    : sql``;
  const entityClause =
    args.entityType === 'all'
      ? sql``
      : sql`AND entity_type = ${args.entityType}`;
  const stageClause = args.stageName
    ? sql`AND stage_name = ${args.stageName}`
    : sql``;

  const rows: { id: number; work_item_id: number; stage_name: string; agent_name: string | null; content: string; created_at: Date }[] = await sql`
    SELECT id, work_item_id, stage_name, agent_name, content, created_at
    FROM stage_logs
    WHERE content LIKE '%TOOL INPUT: Bash%'
    ${entityClause}
    ${stageClause}
    ${sinceClause}
    ORDER BY id
  `;

  console.log(`Loaded ${rows.length} rows. entity=${args.entityType} stage=${args.stageName ?? '*'} since=${args.since ?? 'all-time'}`);
  if (rows.length === 0) {
    await sql.end();
    return;
  }

  type Cluster = {
    skeleton: string;
    freq: number;
    items: Set<number>;
    stages: Map<string, number>;
    agents: Map<string, number>;
    intent: string;
    totalLen: number;
    sample: string;
  };
  const clusters = new Map<string, Cluster>();
  let parseFail = 0;

  for (const r of rows) {
    const cmd = extractCommand(r.content);
    if (!cmd) {
      parseFail++;
      continue;
    }
    const skel = normalize(cmd);
    const intent = classify(cmd);
    let c = clusters.get(skel);
    if (!c) {
      c = {
        skeleton: skel,
        freq: 0,
        items: new Set(),
        stages: new Map(),
        agents: new Map(),
        intent,
        totalLen: 0,
        sample: cmd,
      };
      clusters.set(skel, c);
    }
    c.freq++;
    c.items.add(r.work_item_id);
    c.stages.set(r.stage_name, (c.stages.get(r.stage_name) ?? 0) + 1);
    const ag = r.agent_name ?? '(null)';
    c.agents.set(ag, (c.agents.get(ag) ?? 0) + 1);
    c.totalLen += cmd.length;
    if (cmd.length < c.sample.length) c.sample = cmd; // prefer shortest representative
  }

  const ranked = [...clusters.values()]
    .filter((c) => c.freq >= args.minCount)
    .map((c) => ({
      ...c,
      avgLen: Math.round(c.totalLen / c.freq),
      score: Math.round((c.freq * (c.totalLen / c.freq)) / 100),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, args.top);

  // Intent histogram
  const intentHist = new Map<string, number>();
  for (const c of clusters.values()) {
    intentHist.set(c.intent, (intentHist.get(c.intent) ?? 0) + c.freq);
  }

  console.log('\n=== Intent histogram ===');
  const intentSorted = [...intentHist.entries()].sort((a, b) => b[1] - a[1]);
  const totalCmds = [...clusters.values()].reduce((s, c) => s + c.freq, 0);
  for (const [k, v] of intentSorted) {
    const pct = ((v / totalCmds) * 100).toFixed(1);
    console.log(`  ${k.padEnd(16)} ${String(v).padStart(5)}  (${pct}%)`);
  }
  console.log(`  parse-fail       ${String(parseFail).padStart(5)}`);

  console.log(`\n=== Top ${ranked.length} clusters (score desc, min-count=${args.minCount}) ===`);
  console.log('| # | freq | items | stages | intent | score | example |');
  console.log('|---|------|-------|--------|--------|-------|---------|');
  ranked.forEach((c, i) => {
    const stages = [...c.stages.entries()].map(([k, v]) => `${k}:${v}`).join(',');
    const ex = c.sample.length > 80 ? c.sample.slice(0, 77) + '...' : c.sample;
    console.log(
      `| ${i + 1} | ${c.freq} | ${c.items.size} | ${stages} | ${c.intent} | ${c.score} | \`${ex.replace(/\|/g, '\\|').replace(/\n/g, ' ')}\` |`,
    );
  });

  console.log('\n=== Full skeletons (top 15) ===');
  ranked.slice(0, 15).forEach((c, i) => {
    console.log(`\n[${i + 1}] freq=${c.freq} items=${c.items.size} intent=${c.intent} score=${c.score}`);
    console.log(`  skeleton: ${c.skeleton}`);
    console.log(`  sample:   ${c.sample.split('\n')[0]}${c.sample.includes('\n') ? ' …' : ''}`);
  });

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
