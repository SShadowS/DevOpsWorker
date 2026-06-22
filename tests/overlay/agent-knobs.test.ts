import { describe, test, expect } from 'bun:test';
import { resolveAgentKnobs } from '../../src/overlay/agent-knobs.ts';
import type { AgentConfig } from '../../src/types/agent.types.ts';
import type { OverlayManifest } from '../../src/overlay/types.ts';
import { z } from 'zod';

// Minimal base AgentConfig — only the fields the resolver reads matter.
function baseConfig(over: Partial<AgentConfig<z.ZodTypeAny>> = {}): AgentConfig<z.ZodTypeAny> {
  return {
    name: 'pr-reviewer',
    sharedPromptFragments: ['dependencies-folder.md'],
    buildPrompt: () => '',
    outputSchema: z.object({}),
    allowedTools: ['Read', 'Bash'],
    maxTurns: 80,
    ...over,
  } as AgentConfig<z.ZodTypeAny>;
}

const MODELS = { default: 'claude-opus-4-8', perAgent: { 'pr-reviewer': 'claude-sonnet-4-6' } };

describe('resolveAgentKnobs', () => {
  test('empty manifest → identity on base (model from perAgent)', () => {
    const k = resolveAgentKnobs(baseConfig(), {}, MODELS);
    expect(k.model).toBe('claude-sonnet-4-6');
    expect(k.allowedTools).toEqual(['Read', 'Bash']);
    expect(k.maxTurns).toBe(80);
    expect(k.sharedPromptFragments).toEqual(['dependencies-folder.md']);
  });

  test('overlay model wins over perAgent/default', () => {
    const m: OverlayManifest = { agents: { 'pr-reviewer': { model: 'claude-opus-4-8' } } };
    expect(resolveAgentKnobs(baseConfig(), m, MODELS).model).toBe('claude-opus-4-8');
  });

  test('falls back to default when no perAgent and no override', () => {
    const k = resolveAgentKnobs(baseConfig({ name: 'unknown-agent' }), {}, MODELS);
    expect(k.model).toBe('claude-opus-4-8');
  });

  test('overlay replaces allowedTools, maxTurns, fragments', () => {
    const m: OverlayManifest = { agents: { 'pr-reviewer': {
      allowedTools: ['Read'], maxTurns: 5, sharedPromptFragments: ['tdd.md'],
    } } };
    const k = resolveAgentKnobs(baseConfig(), m, MODELS);
    expect(k.allowedTools).toEqual(['Read']);
    expect(k.maxTurns).toBe(5);
    expect(k.sharedPromptFragments).toEqual(['tdd.md']);
  });

  test('maxTurns defaults to 50 when neither override nor base set it', () => {
    const k = resolveAgentKnobs(baseConfig({ maxTurns: undefined }), {}, MODELS);
    expect(k.maxTurns).toBe(50);
  });

  test('throws on empty allowedTools override', () => {
    const m: OverlayManifest = { agents: { 'pr-reviewer': { allowedTools: [] } } };
    expect(() => resolveAgentKnobs(baseConfig(), m, MODELS)).toThrow(/allowedTools is empty/);
  });

  test('throws on missing shared prompt fragment', () => {
    const m: OverlayManifest = { agents: { 'pr-reviewer': { sharedPromptFragments: ['does-not-exist.md'] } } };
    expect(() => resolveAgentKnobs(baseConfig(), m, MODELS)).toThrow(/not found under src\/prompts/);
  });

  test('accepts an existing shared prompt fragment override', () => {
    const m: OverlayManifest = { agents: { 'pr-reviewer': { sharedPromptFragments: ['tdd.md'] } } };
    expect(() => resolveAgentKnobs(baseConfig(), m, MODELS)).not.toThrow();
  });
});
