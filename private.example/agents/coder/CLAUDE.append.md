<!--
  This file is APPENDED to the coder agent's base CLAUDE.md at staging time
  (agent-workspace copies base + overlay, concatenating this after the base
  instructions). Use it for proprietary agent guidance that must not live in the
  public repo — e.g. how to invoke your environment CLI, product naming
  conventions, or internal workflow rules.

  Drop proprietary skills/rules alongside it under:
    private/agents/coder/.claude/skills/<skill>/SKILL.md
    private/agents/coder/.claude/rules/<rule>.md
-->

## Project-Specific Coder Notes (example)

- Object prefix: use `EXT` for all new AL objects.
- Environment CLI: provision/deploy via `your-cli` (documented in the env-setup skill).
