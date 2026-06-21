import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolvePrivateDir } from '../overlay/loader.ts';

// ---------------------------------------------------------------------------
// Prompt loading & assembly
// ---------------------------------------------------------------------------

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Read a prompt markdown file relative to src/.
 *
 * Prompt fragments (`prompts/<name>`) support a private-overlay OVERRIDE: when
 * `<PRIVATE_DIR>/prompts/<name>` exists it is used instead of the public
 * `src/prompts/<name>`. The public files ship generic/neutral content so a clean
 * clone runs; the overlay supplies the real (proprietary) values.
 *
 * Returns the file content as a string, or throws if not found.
 */
export function readPromptFile(relativePath: string): string {
  if (relativePath.startsWith('prompts/')) {
    const privateDir = resolvePrivateDir();
    if (privateDir) {
      const overlayPath = join(privateDir, relativePath);
      if (existsSync(overlayPath)) return readFileSync(overlayPath, 'utf-8').trim();
    }
  }

  const fullPath = join(SRC_DIR, relativePath);
  try {
    return readFileSync(fullPath, 'utf-8').trim();
  } catch (err) {
    throw new Error(`Failed to read prompt file: ${fullPath} — ${err}`);
  }
}

/**
 * Build an agent's complete system prompt from:
 * 1. Shared prompt fragments (project-context.md, repo-structure.md, etc.)
 * 2. Agent-specific prompt.md (role, goals, approach)
 * 3. Agent-specific rules.md (constraints, rules)
 *
 * The agent's config.ts specifies WHICH shared fragments to include.
 */
export function buildSystemPrompt(
  agentName: string,
  sharedFragments: string[],
): string {
  const parts: string[] = [];

  // 1. Shared fragments
  for (const fragment of sharedFragments) {
    parts.push(readPromptFile(`prompts/${fragment}`));
  }

  // 2. Agent-specific prompt
  parts.push(readPromptFile(`agents/${agentName}/prompt.md`));

  // 3. Agent-specific rules
  try {
    parts.push(readPromptFile(`agents/${agentName}/rules.md`));
  } catch {
    // rules.md is optional — some agents may not have extra rules
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Build concatenated shared fragment content for use in systemPrompt.append.
 * Used by the Claude Code preset path (useClaudeCodePreset: true) where
 * agent-specific instructions come from CLAUDE.md instead of prompt.md/rules.md.
 */
export function buildSharedFragmentContent(fragmentNames: string[]): string {
  if (fragmentNames.length === 0) return '';
  return fragmentNames
    .map(name => readPromptFile(`prompts/${name}`))
    .join('\n\n---\n\n');
}
