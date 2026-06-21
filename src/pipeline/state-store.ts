import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import type { PipelineConfig, PipelineState } from '../types/pipeline.types.ts';
import type { IStateStore } from './state-store.interface.ts';

// ---------------------------------------------------------------------------
// StateStore — JSON file persistence for pipeline state
// ---------------------------------------------------------------------------

export class StateStore implements IStateStore {
  constructor(private readonly stateDir: string) {}

  /** Get the file path for a work item's state */
  private path(workItemId: number): string {
    return join(this.stateDir, `${workItemId}.json`);
  }

  /** Ensure the state directory exists */
  private ensureDir(): void {
    if (!existsSync(this.stateDir)) {
      mkdirSync(this.stateDir, { recursive: true });
    }
  }

  /** Check if state exists for a work item */
  exists(workItemId: number): boolean {
    return existsSync(this.path(workItemId));
  }

  /** Load pipeline state for a work item. Returns null if not found. */
  load(workItemId: number): PipelineState | null {
    const filePath = this.path(workItemId);
    if (!existsSync(filePath)) return null;

    try {
      const raw = readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as PipelineState;
    } catch (err) {
      throw new Error(`Failed to load pipeline state from ${filePath}: ${err}`);
    }
  }

  /** Persist pipeline state to disk. Overwrites any existing state. */
  save(workItemId: number, state: PipelineState): void {
    this.ensureDir();
    const filePath = this.path(workItemId);
    try {
      writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
    } catch (err) {
      throw new Error(`Failed to save pipeline state to ${filePath}: ${err}`);
    }
  }

  /** Get the file path for a work item's config */
  private configPath(workItemId: number): string {
    return join(this.stateDir, `${workItemId}.config.json`);
  }

  /** Persist pipeline config alongside state (secrets stripped) */
  saveConfig(workItemId: number, config: PipelineConfig): void {
    this.ensureDir();
    const filePath = this.configPath(workItemId);
    // Strip secrets before persisting
    const sanitized = {
      ...config,
      azureDevOps: { ...config.azureDevOps, pat: '' },
    };
    try {
      writeFileSync(filePath, JSON.stringify(sanitized, null, 2), 'utf-8');
    } catch (err) {
      throw new Error(`Failed to save pipeline config to ${filePath}: ${err}`);
    }
  }

  /** Load persisted pipeline config. Returns null if not found. */
  loadConfig(workItemId: number): PipelineConfig | null {
    const filePath = this.configPath(workItemId);
    if (!existsSync(filePath)) return null;

    try {
      const raw = readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as PipelineConfig;
    } catch (err) {
      throw new Error(`Failed to load pipeline config from ${filePath}: ${err}`);
    }
  }

  /** List all work item IDs with persisted state */
  listAll(): number[] {
    if (!existsSync(this.stateDir)) return [];
    return readdirSync(this.stateDir)
      .filter(f => f.endsWith('.json') && !f.endsWith('.config.json'))
      .map(f => parseInt(f.replace('.json', ''), 10))
      .filter(id => !isNaN(id));
  }

  /** Create a fresh pipeline state for a new run */
  static createInitial(startingStage: string): PipelineState {
    return {
      currentStage: startingStage,
      telemetry: {
        totalCostUsd: 0,
        totalDurationMs: 0,
        stages: [],
      },
      startedAt: new Date().toISOString(),
    };
  }
}
