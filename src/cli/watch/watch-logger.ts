import type { PipelineConfig } from '../../types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// Shared watcher logging helpers.
//
// Extracted as a leaf module (no imports from `../watch.ts` or its siblings)
// so both the main poll loop (watch.ts) and the container dispatcher
// (container-dispatcher.ts) can log identically without those two modules
// importing each other.
// ---------------------------------------------------------------------------

export function log(message: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${message}`);
}

export function logError(label: string, err: unknown): void {
  log(`${label}: ${err}`);
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (e.code) log(`  code: ${e.code}`);
    if (e.status !== undefined) log(`  exit status: ${e.status}`);
    if (e.stderr) log(`  stderr: ${Buffer.isBuffer(e.stderr) ? e.stderr.toString().trim() : e.stderr}`);
    if (e.stack) log(`  stack: ${String(e.stack).split('\n').slice(1, 4).join('\n')}`);
  }
}

// ---------------------------------------------------------------------------
// Color-coded per-WI logging
// ---------------------------------------------------------------------------

const COLORS = [
  '\x1b[36m', // cyan
  '\x1b[35m', // magenta
  '\x1b[33m', // yellow
  '\x1b[32m', // green
  '\x1b[34m', // blue
  '\x1b[91m', // bright red
];
const RESET = '\x1b[0m';

let colorIndex = 0;
const wiColors = new Map<number, string>();

export function colorForWI(id: number): string {
  if (!wiColors.has(id)) wiColors.set(id, COLORS[colorIndex++ % COLORS.length]!);
  return wiColors.get(id)!;
}

export function releaseColor(id: number): void {
  wiColors.delete(id);
}

export function logWI(id: number, message: string): void {
  const c = colorForWI(id);
  log(`${c}[WI #${id}]${RESET} ${message}`);
}

export function logWIError(id: number, label: string, err: unknown): void {
  logWI(id, `${label}: ${err}`);
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (e.code) logWI(id, `  code: ${e.code}`);
    if (e.status !== undefined) logWI(id, `  exit status: ${e.status}`);
    if (e.stderr) logWI(id, `  stderr: ${Buffer.isBuffer(e.stderr) ? e.stderr.toString().trim() : e.stderr}`);
    if (e.stack) logWI(id, `  stack: ${String(e.stack).split('\n').slice(1, 4).join('\n')}`);
  }
}

export function workItemUrl(id: number, config: PipelineConfig): string {
  const org = encodeURIComponent(config.azureDevOps.organization);
  const project = encodeURIComponent(config.azureDevOps.project);
  return `https://dev.azure.com/${org}/${project}/_workitems/edit/${id}`;
}

/** Reset module-level color state — exported for testing only. */
export function _resetColorState(): void {
  colorIndex = 0;
  wiColors.clear();
}
