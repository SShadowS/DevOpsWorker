import { describe, test, expect } from 'bun:test';
import { resolveMcpServers, mergeMcpServers } from '../../src/sdk/run-agent.ts';
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

describe('mergeMcpServers', () => {
  test('adds manifest servers alongside the agent\'s own servers', () => {
    const agentServers: Record<string, McpServerConfig> = {
      foo: { command: 'echo', type: 'stdio' },
    };
    const manifestServers = {
      custom: { command: 'custom-server', args: ['--flag'] },
    };

    const merged = mergeMcpServers(agentServers, manifestServers);

    expect(merged).toEqual({
      foo: { command: 'echo', type: 'stdio' },
      custom: { command: 'custom-server', args: ['--flag'] },
    });
  });

  test('agent-specific entry wins on key collision with a manifest entry', () => {
    const agentServers: Record<string, McpServerConfig> = {
      shared: { command: 'agent-owned', type: 'stdio' },
    };
    const manifestServers = {
      shared: { command: 'overlay-owned' },
    };

    const merged = mergeMcpServers(agentServers, manifestServers);

    expect(merged.shared).toEqual({ command: 'agent-owned', type: 'stdio' });
  });

  test('undefined manifest servers is a no-op', () => {
    const agentServers: Record<string, McpServerConfig> = {
      foo: { command: 'echo', type: 'stdio' },
    };
    expect(mergeMcpServers(agentServers, undefined)).toEqual(agentServers);
  });

  test('empty agent servers still picks up manifest servers', () => {
    const manifestServers = { custom: { command: 'custom-server' } };
    expect(mergeMcpServers({}, manifestServers)).toEqual({
      custom: { command: 'custom-server' },
    });
  });

  test('throws a clear error when a manifest entry is not a valid McpServerConfig', () => {
    const manifestServers = { bad: { notACommand: true } };
    expect(() => mergeMcpServers({}, manifestServers)).toThrow(/bad/);
  });
});
