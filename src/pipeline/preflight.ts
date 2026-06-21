import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import type { PipelineConfig } from '../types/pipeline.types.ts';
import { PreflightError } from '../sdk/errors.ts';

// ---------------------------------------------------------------------------
// Preflight checks — validate environment before pipeline run
// ---------------------------------------------------------------------------

export interface PreflightCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

export interface PreflightResult {
  passed: boolean;
  checks: PreflightCheck[];
}

/**
 * Synchronous sleep — blocks the event loop for the given milliseconds.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Runs a command, throwing on non-zero exit. Replaceable for testing. */
type CommandRunner = (command: string) => void;

function defaultCommandRunner(command: string): void {
  execSync(command, { stdio: 'pipe', timeout: 10_000, env: process.env });
}

let runCommand: CommandRunner = defaultCommandRunner;
let usingCustomRunner = false;

/**
 * Memoized availability results, keyed by command. CLI availability is stable
 * for a process lifetime, so caching avoids re-spawning slow CLIs (e.g. `az`
 * cold-starts in ~5s) on every pipeline run within a long-lived watcher.
 */
const commandCache = new Map<string, boolean>();

/**
 * Override the command runner — for tests, to avoid spawning real CLIs.
 * Pass `null` to restore the default `execSync`-based runner.
 */
export function setCommandRunner(fn: CommandRunner | null): void {
  runCommand = fn ?? defaultCommandRunner;
  usingCustomRunner = fn !== null;
}

/** Clear the memoized command-availability cache (test isolation). */
export function clearCommandCache(): void {
  commandCache.clear();
}

/**
 * Return true if a command succeeds (exit code 0). Results are memoized per
 * command. Retries up to {@link maxAttempts} times with a 1-second delay to
 * tolerate transient process-spawn failures on Windows (skipped under an
 * injected test runner, where retries are pointless).
 */
function commandExists(command: string, maxAttempts = 3): boolean {
  const cached = commandCache.get(command);
  if (cached !== undefined) return cached;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      runCommand(command);
      commandCache.set(command, true);
      return true;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts && !usingCustomRunner) {
        sleepSync(1_000);
      }
    }
  }
  const tag = lastError instanceof Error ? lastError.message : String(lastError);
  console.error(`[preflight] ${command} failed after ${maxAttempts} attempts: ${tag}`);
  commandCache.set(command, false);
  return false;
}

/**
 * Run all preflight checks against the pipeline config.
 */
export function runPreflightChecks(config: PipelineConfig): PreflightResult {
  const checks: PreflightCheck[] = [];

  // 1. git
  checks.push(
    commandExists('git --version')
      ? { name: 'git', status: 'ok', message: 'git is available' }
      : { name: 'git', status: 'fail', message: 'git not found in PATH' },
  );

  // 2. az CLI (warn-only — agents use AZURE_DEVOPS_EXT_PAT, not az login)
  checks.push(
    commandExists('az --version')
      ? { name: 'az-cli', status: 'ok', message: 'Azure CLI is available' }
      : { name: 'az-cli', status: 'warn', message: 'Azure CLI (az) not found or slow to start — agents use PAT auth instead' },
  );

  // 3. az logged in
  if (checks.find(c => c.name === 'az-cli')?.status === 'ok') {
    checks.push(
      commandExists('az account show')
        ? { name: 'az-auth', status: 'ok', message: 'Azure CLI is authenticated' }
        : { name: 'az-auth', status: 'warn', message: 'Azure CLI not logged in — agents use PAT auth instead' },
    );
  }

  // 4. bun
  checks.push(
    commandExists('bun --version')
      ? { name: 'bun', status: 'ok', message: 'Bun runtime is available' }
      : { name: 'bun', status: 'fail', message: 'Bun not found in PATH' },
  );

  // 5. npx (for MCP server)
  checks.push(
    commandExists('npx --version')
      ? { name: 'npx', status: 'ok', message: 'npx is available' }
      : { name: 'npx', status: 'fail', message: 'npx not found in PATH' },
  );

  // 6. Main repo exists
  const docOutputPath = config.paths.targetRepo;
  checks.push(
    existsSync(docOutputPath)
      ? { name: 'main-repo-exists', status: 'ok', message: `Main repo found: ${docOutputPath}` }
      : { name: 'main-repo-exists', status: 'fail', message: `Main repo not found: ${docOutputPath}` },
  );

  // 7. Main repo is a git repo
  if (existsSync(docOutputPath)) {
    const gitDir = join(docOutputPath, '.git');
    checks.push(
      existsSync(gitDir)
        ? { name: 'main-repo-git', status: 'ok', message: 'Main repo is a git repository' }
        : { name: 'main-repo-git', status: 'fail', message: 'Main repo is not a git repository' },
    );

    // 8. git status clean
    try {
      const status = execSync('git status --porcelain', {
        cwd: docOutputPath,
        stdio: 'pipe',
        timeout: 10_000,
        env: process.env,
      }).toString().trim();

      checks.push(
        status === ''
          ? { name: 'main-repo-clean', status: 'ok', message: 'Main repo working tree is clean' }
          : { name: 'main-repo-clean', status: 'warn', message: `Main repo has uncommitted changes:\n${status}` },
      );
    } catch {
      checks.push({ name: 'main-repo-clean', status: 'warn', message: 'Could not check git status' });
    }
  }

  // 9. Companion repos
  if (config.companions) {
    const sessionRoot = config.paths.sessionRoot;
    for (const name of Object.keys(config.companions)) {
      if (name === config.repoKey) continue; // skip self
      const companionPath = join(sessionRoot, name);
      checks.push(
        existsSync(companionPath)
          ? { name: `companion-${name.toLowerCase()}`, status: 'ok' as const, message: `Companion ${name} found` }
          : { name: `companion-${name.toLowerCase()}`, status: 'warn' as const, message: `Companion ${name} not found at ${companionPath}` },
      );
    }
  }

  // 9. Azure DevOps PAT
  checks.push(
    config.azureDevOps.pat
      ? { name: 'ado-pat', status: 'ok', message: 'Azure DevOps PAT is set' }
      : { name: 'ado-pat', status: 'fail', message: 'AZURE_DEVOPS_PAT environment variable not set' },
  );

  // Env-provisioning CLI available (only if environment config is set)
  if (config.environment) {
    const cliPath = resolve(config.paths.sessionRoot, config.environment.envCli);
    if (existsSync(cliPath)) {
      checks.push({ name: 'env-cli', status: 'ok', message: `Found at ${cliPath}` });
    } else {
      checks.push({ name: 'env-cli', status: 'warn', message: `Not found at ${cliPath} — BC env provisioning will be skipped` });
    }
  }

  const passed = checks.every(c => c.status !== 'fail');
  return { passed, checks };
}

/**
 * Run preflight checks and throw PreflightError if any fail.
 */
export function assertPreflight(config: PipelineConfig): PreflightResult {
  const result = runPreflightChecks(config);

  if (!result.passed) {
    const failures = result.checks.filter(c => c.status === 'fail');
    const toolFailures = failures.filter(f =>
      ['git', 'az-cli', 'bun', 'npx'].includes(f.name),
    );
    if (toolFailures.length > 0) {
      const path = process.env['PATH'] ?? '(not set)';
      console.error(`[preflight] PATH at time of failure: ${path}`);
    }
    throw new PreflightError(failures);
  }

  return result;
}
