import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { TOOL_SETS } from '../../sdk/mcp-configs.ts';

// ---------------------------------------------------------------------------
// Rule Learner Agent — analyzes PR review comments and proposes new rules
// ---------------------------------------------------------------------------

/** Absolute path to the rule-learner agent source directory. */
export const AGENT_DIR = dirname(fileURLToPath(import.meta.url));

/** Agent name (matches folder name). */
export const AGENT_NAME = 'rule-learner';

/** Read-only FS so the agent can read the existing patterns file. */
export const ALLOWED_TOOLS = [...TOOL_SETS.fsReadOnly];

/**
 * What actually keeps this agent read-only. `ALLOWED_TOOLS` above is only the
 * SDK's auto-approve list, and `learn-rules.ts` runs with
 * `permissionMode: 'bypassPermissions'` — so tools left out of it stay callable.
 * The agent reads a patterns file and returns proposed rules as structured
 * output; it has no reason to run a shell or touch the disk.
 */
export const DISALLOWED_TOOLS = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'REPL'];

/** Shared prompt fragments appended to the system prompt. */
export const SHARED_PROMPT_FRAGMENTS = ['al-review-patterns.md'];

/**
 * This agent runs through `query()` directly in `learn-rules.ts`, not through
 * `runAgent()`/`resolveAgentKnobs()` — so `DEFAULT_MODEL`, `DEFAULT_EFFORT`, and
 * any overlay `agents['rule-learner']` override are all silently inert here.
 * Exported so the dashboard's config-report can report the real value that runs
 * instead of a second hardcoded copy of it.
 */
export const MODEL = 'claude-sonnet-5';
export const MAX_TURNS = 20;
