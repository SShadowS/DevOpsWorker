import { describe, test, expect } from 'bun:test';
import { resolveAgentKnobs } from '../../src/overlay/agent-knobs.ts';
import type { AgentConfig } from '../../src/types/agent.types.ts';
import type { OverlayManifest } from '../../src/overlay/types.ts';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// resolveAgentKnobs — database-sourced knobs (4th argument)
//
// Precedence, deliberately: database > overlay manifest > agent's own config
// > pipeline default. The database wins over the manifest because an
// operator's deliberate, live change should beat a checked-in default.
// `allowedTools`/`sharedPromptFragments` are untouched by this — the database
// only ever supplies `model` and `maxTurns`.
// ---------------------------------------------------------------------------

function baseConfig(over: Partial<AgentConfig<z.ZodTypeAny>> = {}): AgentConfig<z.ZodTypeAny> {
  return {
    name: 'coder',
    sharedPromptFragments: [],
    buildPrompt: () => '',
    outputSchema: z.object({}),
    allowedTools: ['Read', 'Bash'],
    ...over,
  } as AgentConfig<z.ZodTypeAny>;
}

const MODELS = { default: 'claude-opus-5', perAgent: { coder: 'claude-sonnet-5' } };

describe('resolveAgentKnobs — no database knobs (today\'s behaviour, unchanged)', () => {
  test('omitting the 4th argument entirely resolves exactly as before', () => {
    const k = resolveAgentKnobs(baseConfig({ model: 'claude-haiku-4-5' }), {}, MODELS);
    expect(k.model).toBe('claude-haiku-4-5');
    expect(k.maxTurns).toBe(50);
  });

  test('passing an empty object for the 4th argument changes nothing', () => {
    const k = resolveAgentKnobs(baseConfig({ model: 'claude-haiku-4-5', maxTurns: 30 }), {}, MODELS, {});
    expect(k.model).toBe('claude-haiku-4-5');
    expect(k.maxTurns).toBe(30);
  });

  test('a database object with both fields undefined is byte-identical to no database knobs', () => {
    const withDb = resolveAgentKnobs(baseConfig(), {}, MODELS, { model: undefined, maxTurns: undefined });
    const without = resolveAgentKnobs(baseConfig(), {}, MODELS);
    expect(withDb).toEqual(without);
  });
});

describe('resolveAgentKnobs — model precedence: database > overlay > base > perAgent > default', () => {
  test('database beats an overlay override', () => {
    const m: OverlayManifest = { agents: { coder: { model: 'claude-opus-4-8' } } };
    const k = resolveAgentKnobs(baseConfig(), m, MODELS, { model: 'db-model' });
    expect(k.model).toBe('db-model');
  });

  test('database beats the agent\'s own declared model, with no overlay present', () => {
    const k = resolveAgentKnobs(baseConfig({ model: 'claude-sonnet-5' }), {}, MODELS, { model: 'db-model' });
    expect(k.model).toBe('db-model');
  });

  test('overlay beats the agent\'s own config when no database value exists', () => {
    const m: OverlayManifest = { agents: { coder: { model: 'claude-opus-4-8' } } };
    const k = resolveAgentKnobs(baseConfig({ model: 'claude-sonnet-5' }), m, MODELS);
    expect(k.model).toBe('claude-opus-4-8');
  });

  test('the agent\'s own config beats the pipeline default (and perAgent) when nothing else is set', () => {
    const k = resolveAgentKnobs(baseConfig({ model: 'claude-sonnet-5' }), {}, MODELS);
    expect(k.model).toBe('claude-sonnet-5');
  });

  test('a database model for a DIFFERENT agent has no effect', () => {
    const k = resolveAgentKnobs(baseConfig({ name: 'planner' }), {}, MODELS, { model: undefined });
    expect(k.model).toBe(MODELS.default);
  });
});

describe('resolveAgentKnobs — maxTurns precedence: database > overlay > base > 50', () => {
  test('database beats an overlay override', () => {
    const m: OverlayManifest = { agents: { coder: { maxTurns: 40 } } };
    const k = resolveAgentKnobs(baseConfig(), m, MODELS, { maxTurns: 200 });
    expect(k.maxTurns).toBe(200);
  });

  test('database beats the agent\'s own declared maxTurns, with no overlay present', () => {
    const k = resolveAgentKnobs(baseConfig({ maxTurns: 80 }), {}, MODELS, { maxTurns: 200 });
    expect(k.maxTurns).toBe(200);
  });

  test('overlay beats the agent\'s own config when no database value exists', () => {
    const m: OverlayManifest = { agents: { coder: { maxTurns: 40 } } };
    const k = resolveAgentKnobs(baseConfig({ maxTurns: 80 }), m, MODELS);
    expect(k.maxTurns).toBe(40);
  });

  test('the agent\'s own config beats the pipeline default (50) when nothing else is set', () => {
    const k = resolveAgentKnobs(baseConfig({ maxTurns: 80 }), {}, MODELS);
    expect(k.maxTurns).toBe(80);
  });

  test('falls all the way through to 50 when nothing declares it anywhere', () => {
    const k = resolveAgentKnobs(baseConfig(), {}, MODELS, {});
    expect(k.maxTurns).toBe(50);
  });
});

describe('resolveAgentKnobs — database knobs never touch allowedTools/sharedPromptFragments', () => {
  test('allowedTools and sharedPromptFragments are unaffected by database knobs', () => {
    const k = resolveAgentKnobs(
      baseConfig({ allowedTools: ['Read'], sharedPromptFragments: ['tdd.md'] }),
      {},
      MODELS,
      { model: 'db-model', maxTurns: 999 },
    );
    expect(k.allowedTools).toEqual(['Read']);
    expect(k.sharedPromptFragments).toEqual(['tdd.md']);
  });
});
