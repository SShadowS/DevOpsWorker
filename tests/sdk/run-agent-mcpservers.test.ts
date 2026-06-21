import { describe, test, expect } from 'bun:test';
import { resolveMcpServers } from '../../src/sdk/run-agent.ts';
import type { McpServerConfig } from '../../src/types/agent.types.ts';
import type { PipelineState } from '../../src/types/pipeline.types.ts';

const fakeState = {
  workItem: { id: 1 },
  environment: {
    envId: 'e',
    url: 'u/',
    description: 'd',
    profileId: 'p',
    createdAt: '2026-04-28',
  },
  telemetry: { totalCostUsd: 0, totalDurationMs: 0, stages: [] },
  startedAt: '2026-04-28',
} as unknown as PipelineState;

describe('resolveMcpServers', () => {
  test('static record is returned as-is', () => {
    const cfg: Record<string, McpServerConfig> = {
      foo: { command: 'echo', type: 'stdio' },
    };
    expect(resolveMcpServers(cfg, fakeState)).toEqual(cfg);
  });

  test('undefined returns empty record', () => {
    expect(resolveMcpServers(undefined, fakeState)).toEqual({});
  });

  test('function form is invoked with state', () => {
    const fn = (s: PipelineState): Record<string, McpServerConfig> =>
      s.environment ? { bar: { command: 'baz', type: 'stdio' as const } } : {};
    expect(resolveMcpServers(fn, fakeState)).toHaveProperty('bar');
    expect(
      resolveMcpServers(fn, { ...fakeState, environment: undefined } as PipelineState),
    ).toEqual({});
  });
});
