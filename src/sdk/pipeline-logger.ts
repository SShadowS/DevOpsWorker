import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ILogSink } from '../pipeline/log-sink.interface.ts';

// ---------------------------------------------------------------------------
// PipelineLogger — per-stage file logging for pipeline runs
// ---------------------------------------------------------------------------

/**
 * Writes per-stage log files to `.pipeline/logs/{workItemId}/`.
 *
 * Each stage gets a numbered log file (e.g. `00-analyzer.log`) containing
 * prompts, config, structured output, telemetry, and errors.
 *
 * All methods are no-throw — logging failures never crash the pipeline.
 */
export class PipelineLogger {
  private readonly logDir: string;
  private currentFile: string | null = null;
  private currentStageName: string | null = null;
  private stageIndex = 0;

  /** Optional agent-name forwarder — set when the sink supports per-agent attribution. */
  private agentNameSetter?: (name: string) => void;

  constructor(baseDir: string, workItemId: number, private readonly sink?: ILogSink) {
    this.logDir = join(baseDir, String(workItemId));
    try {
      mkdirSync(this.logDir, { recursive: true });
    } catch {
      // Best-effort — if we can't create the dir, logging will silently fail
    }
  }

  /** Open a new log file for a stage and write the header. */
  stageStart(stageName: string): void {
    const padded = String(this.stageIndex).padStart(2, '0');
    const safeName = stageName.replace(/[^a-zA-Z0-9_-]/g, '-');
    this.currentFile = join(this.logDir, `${padded}-${safeName}.log`);
    this.stageIndex++;

    this.currentStageName = stageName;

    const now = new Date().toISOString();
    const header = [
      '============================================================',
      `STAGE: ${stageName}`,
      `STARTED: ${now}`,
      '============================================================',
      '',
    ].join('\n');

    this.writeToFile(header);
    this.sink?.write(stageName, 'header', header);
  }

  /** Append a line to the current stage log and echo to console. */
  log(message: string): void {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    this.writeToFile(line);
    if (this.currentStageName) this.sink?.write(this.currentStageName, 'log', line);
    console.log(message);
  }

  /** Append a formatted JSON block to the current stage log. */
  logJson(label: string, data: unknown): void {
    let json: string;
    try {
      json = JSON.stringify(data, null, 2);
    } catch {
      json = String(data);
    }
    const block = `\n--- ${label} ---\n${json}\n--- end ${label} ---\n`;
    this.writeToFile(block);
    if (this.currentStageName) this.sink?.write(this.currentStageName, 'json', block);
  }

  /** Append a large text block (prompts, etc.) to the current stage log. */
  logPrompt(label: string, text: string): void {
    const block = `\n--- ${label} ---\n${text}\n--- end ${label} ---\n`;
    this.writeToFile(block);
    if (this.currentStageName) this.sink?.write(this.currentStageName, 'prompt', block);
  }

  /** Register a callback the runner uses to attribute logs to a sub-agent. */
  onAgentName(setter: (name: string) => void): void {
    this.agentNameSetter = setter;
  }

  /** Forward the active agent name to the sink (no-op if unsupported). */
  setAgentName(name: string): void {
    this.agentNameSetter?.(name);
  }

  /** Write a footer with telemetry data. */
  stageComplete(telemetry?: {
    costUsd?: number;
    durationMs?: number;
    turns?: number;
    sessionId?: string;
  }): void {
    const now = new Date().toISOString();
    const lines = ['', `COMPLETED: ${now}`];

    if (telemetry) {
      if (telemetry.costUsd !== undefined) lines.push(`COST: $${telemetry.costUsd.toFixed(4)}`);
      if (telemetry.durationMs !== undefined) lines.push(`DURATION: ${telemetry.durationMs}ms`);
      if (telemetry.turns !== undefined) lines.push(`TURNS: ${telemetry.turns}`);
      if (telemetry.sessionId) lines.push(`SESSION: ${telemetry.sessionId}`);
    }

    lines.push('');
    this.writeToFile(lines.join('\n'));
    if (this.currentStageName) this.sink?.write(this.currentStageName, 'complete', lines.join('\n'));
  }

  /** Write an error block with stack trace. */
  stageError(error: Error): void {
    const now = new Date().toISOString();
    const block = [
      '',
      `ERROR: ${now}`,
      `TYPE: ${error.constructor.name}`,
      `MESSAGE: ${error.message}`,
      '',
      'STACK TRACE:',
      error.stack ?? '(no stack trace)',
      '',
    ].join('\n');

    this.writeToFile(block);
    if (this.currentStageName) this.sink?.write(this.currentStageName, 'error', block);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private writeToFile(content: string): void {
    if (!this.currentFile) return;
    try {
      appendFileSync(this.currentFile, content);
    } catch {
      // Silently swallow — logging must never crash the pipeline
    }
  }
}
