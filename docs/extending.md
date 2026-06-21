# Extending the Pipeline

The pipeline is customized through the **private overlay** — a gitignored
`private/` directory (templated by [`private.example/`](../private.example/)) that
the core loads at runtime. No core forking required. See
[`private.example/README.md`](../private.example/README.md) for the full injection-point
table; this document covers the three extensibility axes consumers most often ask
about: **stages**, **agents**, and **agent providers**.

Support status at a glance:

| Axis | Status | Mechanism |
|------|--------|-----------|
| Swap / add / remove **stages** | ✅ Supported | `manifest.pipeline` declarative edits |
| Customize **agents** (prompt, rules, skills, model) | ✅ Supported | overlay asset-staging + `manifest.models` |
| Replace a whole **agent** | ✅ Supported | replace its stage |
| Fine-grained agent override (one field) | ⚠️ Via stage replace only | — |
| Swap the **agent/LLM provider** | ❌ Not yet (Claude-only) | planned `AgentRunner` seam |

---

## 1. Stages

Everything in the pipeline is a `Stage` (`src/types/pipeline.types.ts`):

```ts
interface Stage {
  readonly name: string;
  canRun(state: PipelineState): boolean;
  execute(state: PipelineState, context: PipelineContext): Promise<PipelineState>;
}
```

The default pipeline is assembled in `src/pipeline/pipeline-definition.ts`. The
overlay edits its topology **declaratively**, anchored on stable stage names —
never by array index — via `manifest.pipeline`:

```ts
// private/manifest.ts
const manifest: OverlayManifest = {
  pipeline: ({ config, repo }) => [
    // insert a custom stage after an existing one
    { op: 'insertAfter', anchor: 'checkpoint:plan-approved', stage: myEnvProvision(config) },
    // replace a built-in stage with your own
    { op: 'replace', anchor: 'coding', stage: myCoder(config) },
    // drop a stage you don't want
    { op: 'remove', anchor: 'docs-writer' },
  ],
};
```

Edits apply in order; each anchor resolves against the already-mutated list. A
missing anchor or a resulting duplicate stage name **throws** (fail-loud — never a
silent misalignment). Build stages with the provided factories — `agentStage()`,
`revisionLoop()`, `checkpoint()` — or implement the `Stage` interface directly.

---

## 2. Agents

Each agent lives in `src/agents/<name>/` (`config.ts` = `AgentConfig`, `schema.ts`
= Zod output, `CLAUDE.md` = instructions, optional `.claude/{rules,skills}/`).
There are three levels of customization, cheapest first:

### a) Instructions, rules, skills — overlay asset-staging

Drop files under `private/agents/<name>/` and they're merged onto the base agent
at runtime (no code):

```
private/agents/coder/CLAUDE.append.md        # appended to the base CLAUDE.md
private/agents/coder/.claude/rules/<rule>.md  # added to the agent's rules
private/agents/coder/.claude/skills/<skill>/  # added to the agent's skills
private/prompts/<fragment>.md                 # overrides src/prompts/<fragment>.md
```

This is the right tool for product-specific guidance (naming conventions, an
environment CLI workflow, domain rules) without touching public code.

### b) Model — `manifest.models`

```ts
models: { coder: 'claude-sonnet-4-6', planner: 'claude-opus-4-8' }
```

### c) Whole agent — replace its stage

To change an agent's prompt-builder, output schema, or tool set, build your own
`AgentConfig` + `agentStage()` and `replace` the stage (see §1). There is no
finer-grained "override just `buildPrompt`" hook today — replacing the stage is
the supported path.

> **Note:** `AgentConfig` (`src/types/agent.types.ts`) is currently coupled to the
> Claude Agent SDK — its `plugins`, `agents`, and `hooks` fields are SDK types. A
> custom agent config imports `@anthropic-ai/claude-agent-sdk`.

---

## 3. Agent providers (LLM backend)

**Status: not yet pluggable — the pipeline runs on the Claude Agent SDK only.**

`src/sdk/run-agent.ts` calls the SDK's `query()` directly, and `AgentConfig` is
SDK-shaped (structured output via tool-use, MCP servers, hooks, subagents are all
Claude-SDK concepts). Switching to a different provider (OpenAI, Gemini, a local
model) today means rewriting `run-agent.ts`.

### Planned: the `AgentRunner` seam

A future release will introduce a provider interface so the overlay can supply a
non-Claude backend. The intended shape:

```ts
// src/sdk/agent-runner.ts (planned)
export interface AgentRunner {
  run<T>(req: {
    config: AgentConfig<T>;
    systemPrompt: string;
    userPrompt: string;
    cwd: string;
    allowedTools: string[];
  }): Promise<AgentResult<T>>;
}

// manifest.agentRunner overrides the default Claude runner
```

`AgentResult` (`src/types/agent.types.ts`) is already provider-neutral
(cost / duration / turns / tokens / structured output), so the return contract is
stable. The work is splitting `AgentConfig` into a provider-neutral core (name,
`buildPrompt`, `outputSchema`, `allowedTools`, `model`, `maxTurns`) plus a
Claude-specific extension (`plugins`/`agents`/`hooks`), and routing `runAgent()`
through `config.overlay.agentRunner ?? defaultClaudeRunner`.

Until then, **Claude is the only supported provider.** For an AL / Business
Central pipeline this is rarely a constraint — but if non-Claude support matters
to you, open an issue so it can be prioritized.
