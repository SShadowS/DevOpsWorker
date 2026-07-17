import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { PipelineState } from '../../src/types/pipeline.types.ts';
import type { ReadinessReport } from '../../src/agents/analyzer/schema.ts';
import type { DevPlan } from '../../src/agents/planner/schema.ts';
import type { Changeset } from '../../src/agents/coder/schema.ts';
import type { DraftPullRequest } from '../../src/agents/draft-pr/schema.ts';
import type { WorkItemUpdate } from '../../src/agents/documenter/schema.ts';
import type { TestCasesOutput } from '../../src/agents/test-cases/schema.ts';
import type { DocsWriterOutput } from '../../src/agents/docs-writer/schema.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const PIPELINE_TYPES = join(HERE, '..', '..', 'src', 'types', 'pipeline.types.ts');

describe('PipelineState agent-owned slices (drift guard)', () => {
  test('core pipeline.types.ts imports NO agent schemas', () => {
    const src = readFileSync(PIPELINE_TYPES, 'utf8');

    // Any import that reaches into an agent directory couples core -> agents,
    // reintroducing the god-type. This is the drift guard that keeps agent
    // output schemas owned by the agents via PipelineStateSlices augmentation.
    const offendingImports = src
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line))
      .filter((line) => /from\s+['"][^'"]*\/agents\//.test(line));

    expect(offendingImports).toEqual([]);
  });

  test('core declares an augmentable PipelineStateSlices interface', () => {
    const src = readFileSync(PIPELINE_TYPES, 'utf8');
    expect(src).toMatch(/interface\s+PipelineStateSlices\b/);
    expect(src).toMatch(/PipelineState\s+extends\s+Partial<PipelineStateSlices>/);
  });

  // Compile-time reachability: these functions only typecheck if each agent's
  // slice augmentation makes its field visible on PipelineState with the same
  // type + optionality. Validated by `tsc --noEmit` (tests/** is in the program),
  // NOT by the runtime assertion below. If an augmentation stops propagating,
  // typecheck fails here.
  test('every agent output field is reachable on PipelineState with its schema type', () => {
    const readiness = (s: PipelineState): ReadinessReport | undefined => s.readiness;
    const devPlan = (s: PipelineState): DevPlan | undefined => s.devPlan;
    const changeset = (s: PipelineState): Changeset | undefined => s.changeset;
    const draftPR = (s: PipelineState): DraftPullRequest | undefined => s.draftPR;
    const workItemUpdate = (s: PipelineState): WorkItemUpdate | undefined => s.workItemUpdate;
    const testCases = (s: PipelineState): TestCasesOutput | undefined => s.testCases;
    const docsWriterDrafts = (s: PipelineState): DocsWriterOutput | undefined => s.docsWriterDrafts;

    // Touch each accessor so the compile-time checks are not elided as unused.
    const probes = [readiness, devPlan, changeset, draftPR, workItemUpdate, testCases, docsWriterDrafts];
    expect(probes).toHaveLength(7);
  });
});
