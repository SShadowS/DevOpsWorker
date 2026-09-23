import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';

// Review and pipeline containers now load Microsoft's platform and base apps from a
// symbol cache (docker/fetch-al-symbols.sh, AL_LSP_PACKAGE_CACHE) and companion apps
// from their source (AL_LSP_SOURCE_ROOTS). These prompts used to say platform symbols
// never resolve at planning time, which told agents to ignore an empty lookup that is
// now real evidence. They must describe the split instead, with a way to check
// whether the cache is loaded.
const PROMPTS = [
  'src/agents/planner/CLAUDE.md',
  'src/agents/planner/.claude/rules/USE-AL-LSP-TOOLS.md',
  'src/agents/plan-reviewer/.claude/rules/USE-AL-LSP-TOOLS.md',
  'src/agents/plan-reviewer/.claude/agents/feasibility-reviewer.md',
];

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

describe('prompts describe what the language server can see', () => {
  test.each(PROMPTS)('%s no longer says platform symbols never resolve', (p) => {
    const text = read(p);
    expect(text).not.toMatch(/never resolve/i);
    expect(text).not.toMatch(/holds AL (\*\*)?source (code )?only/i);
  });

  test.each(PROMPTS)('%s gives the cache self-check and names companion apps', (p) => {
    const text = read(p);
    expect(text).toMatch(/hover(ing)?\s+a\s+`Record Customer`\s+variable/);
    expect(text).toMatch(/companion/i);
  });
});
