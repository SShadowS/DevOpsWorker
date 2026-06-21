import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import type { PipelineState } from '../../src/types/pipeline.types.ts';
import { agentStage, resolveAgentModel } from '../../src/pipeline/stage.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshState(): PipelineState {
  return {
    currentStage: 'test',
    telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
    startedAt: new Date().toISOString(),
  };
}

const TestSchema = z.object({ value: z.string() });

function testAgentConfig(overrides?: { name?: string }) {
  return {
    name: overrides?.name ?? 'test-agent',
    sharedPromptFragments: [] as string[],
    outputSchema: TestSchema,
    allowedTools: [] as string[],
    buildPrompt: () => 'prompt',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('agentStage', () => {
  test('creates a Stage with correct name', () => {
    const stage = agentStage({
      agent: testAgentConfig({ name: 'my-agent' }),
      canRun: () => true,
      applyOutput: (s, _out) => s,
    });

    expect(stage.name).toBe('my-agent');
  });

  test('canRun delegates to config.canRun', () => {
    const stage = agentStage({
      agent: testAgentConfig({ name: 'my-agent' }),
      canRun: (s) => s.devPlan != null,
      applyOutput: (s, _out) => s,
    });

    expect(stage.canRun(freshState())).toBe(false);
    expect(stage.canRun({ ...freshState(), devPlan: {} as any })).toBe(true);
  });
});

describe('resolveAgentModel', () => {
  test('uses agent-level model when set', () => {
    const result = resolveAgentModel(
      'claude-haiku-4-5',
      'coder',
      { default: 'claude-opus-4-6', perAgent: { coder: 'claude-sonnet-4-6' } },
    );
    expect(result).toBe('claude-haiku-4-5');
  });

  test('uses perAgent override when agent model is undefined', () => {
    const result = resolveAgentModel(
      undefined,
      'coder',
      { default: 'claude-opus-4-6', perAgent: { coder: 'claude-sonnet-4-6' } },
    );
    expect(result).toBe('claude-sonnet-4-6');
  });

  test('falls back to default when no agent model or perAgent override', () => {
    const result = resolveAgentModel(
      undefined,
      'coder',
      { default: 'claude-opus-4-6', perAgent: {} },
    );
    expect(result).toBe('claude-opus-4-6');
  });

  test('falls back to default when perAgent is undefined', () => {
    const result = resolveAgentModel(
      undefined,
      'coder',
      { default: 'claude-opus-4-6' },
    );
    expect(result).toBe('claude-opus-4-6');
  });

  test('matches correct agent name in perAgent map', () => {
    const result = resolveAgentModel(
      undefined,
      'planner',
      { default: 'claude-opus-4-6', perAgent: { coder: 'claude-sonnet-4-6', planner: 'claude-haiku-4-5' } },
    );
    expect(result).toBe('claude-haiku-4-5');
  });
});
