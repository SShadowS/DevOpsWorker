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

/** Shared prompt fragments appended to the system prompt. */
export const SHARED_PROMPT_FRAGMENTS = ['al-review-patterns.md'];
