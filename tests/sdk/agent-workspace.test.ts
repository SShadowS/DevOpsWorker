import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, readFileSync, lstatSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { stageAgentWorkspace } from '../../src/sdk/agent-workspace.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let agentDir: string;
let targetDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'agent-ws-test-'));
  agentDir = join(tempDir, 'agent-source');
  targetDir = join(tempDir, 'target-cwd');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(targetDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stageAgentWorkspace', () => {
  test('stages CLAUDE.md into target cwd', async () => {
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Agent Instructions');

    const staged = await stageAgentWorkspace(agentDir, targetDir);

    expect(existsSync(join(targetDir, 'CLAUDE.md'))).toBe(true);
    expect(readFileSync(join(targetDir, 'CLAUDE.md'), 'utf-8')).toBe('# Agent Instructions');
    expect(staged.links).toContain(join(targetDir, 'CLAUDE.md'));
    expect(staged.backups).toHaveLength(0);

    await staged.cleanup();
  });

  test('stages .claude/ directory as junction into target cwd', async () => {
    const claudeDir = join(agentDir, '.claude', 'skills', 'test-skill');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'SKILL.md'), '# Test Skill');

    const staged = await stageAgentWorkspace(agentDir, targetDir);

    expect(existsSync(join(targetDir, '.claude', 'skills', 'test-skill', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(targetDir, '.claude', 'skills', 'test-skill', 'SKILL.md'), 'utf-8')).toBe('# Test Skill');
    expect(staged.links).toContain(join(targetDir, '.claude'));

    await staged.cleanup();
  });

  test('backs up existing CLAUDE.md and restores on cleanup', async () => {
    writeFileSync(join(targetDir, 'CLAUDE.md'), '# Original');
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Agent');

    const staged = await stageAgentWorkspace(agentDir, targetDir);

    // During staging, target has agent's CLAUDE.md
    expect(readFileSync(join(targetDir, 'CLAUDE.md'), 'utf-8')).toBe('# Agent');
    expect(staged.backups).toHaveLength(1);
    expect(existsSync(join(targetDir, 'CLAUDE.md.bak'))).toBe(true);

    await staged.cleanup();

    // After cleanup, original is restored
    expect(readFileSync(join(targetDir, 'CLAUDE.md'), 'utf-8')).toBe('# Original');
    expect(existsSync(join(targetDir, 'CLAUDE.md.bak'))).toBe(false);
  });

  test('backs up existing .claude/ and restores on cleanup', async () => {
    mkdirSync(join(targetDir, '.claude'), { recursive: true });
    writeFileSync(join(targetDir, '.claude', 'settings.json'), '{"existing": true}');

    mkdirSync(join(agentDir, '.claude', 'skills'), { recursive: true });
    writeFileSync(join(agentDir, '.claude', 'skills', 'test.md'), 'skill');

    const staged = await stageAgentWorkspace(agentDir, targetDir);

    // Agent's .claude/ is now visible
    expect(existsSync(join(targetDir, '.claude', 'skills', 'test.md'))).toBe(true);
    expect(existsSync(join(targetDir, '.claude.bak', 'settings.json'))).toBe(true);

    await staged.cleanup();

    // Original restored
    expect(readFileSync(join(targetDir, '.claude', 'settings.json'), 'utf-8')).toBe('{"existing": true}');
    expect(existsSync(join(targetDir, '.claude.bak'))).toBe(false);
  });

  test('does nothing when agent source has no CLAUDE.md or .claude/', async () => {
    const staged = await stageAgentWorkspace(agentDir, targetDir);

    expect(staged.links).toHaveLength(0);
    expect(staged.backups).toHaveLength(0);

    await staged.cleanup();
  });

  test('cleanup removes staged files', async () => {
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Agent');
    mkdirSync(join(agentDir, '.claude'), { recursive: true });

    const staged = await stageAgentWorkspace(agentDir, targetDir);

    expect(existsSync(join(targetDir, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(targetDir, '.claude'))).toBe(true);

    await staged.cleanup();

    expect(existsSync(join(targetDir, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(targetDir, '.claude'))).toBe(false);
  });

  test('cleanup is idempotent', async () => {
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Agent');

    const staged = await stageAgentWorkspace(agentDir, targetDir);

    await staged.cleanup();
    await staged.cleanup(); // Should not throw
  });

  test('cleanup never throws', async () => {
    // Create a staged workspace, then manually break things
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Agent');

    const staged = await stageAgentWorkspace(agentDir, targetDir);

    // Manually remove the staged file before cleanup
    rmSync(join(targetDir, 'CLAUDE.md'), { force: true });

    // Cleanup should not throw even when the file is already gone
    await staged.cleanup();
  });

  test('handles stale .claude.bak from previous incomplete cleanup', async () => {
    // Simulate a previous run that left both .claude.bak (original) and
    // .claude (stale junction) behind — the scenario that causes EPERM on Windows
    mkdirSync(join(targetDir, '.claude.bak'), { recursive: true });
    writeFileSync(join(targetDir, '.claude.bak', 'settings.json'), '{"original": true}');

    mkdirSync(join(targetDir, '.claude'), { recursive: true });
    writeFileSync(join(targetDir, '.claude', 'other.json'), '{}');

    mkdirSync(join(agentDir, '.claude', 'skills'), { recursive: true });
    writeFileSync(join(agentDir, '.claude', 'skills', 'test.md'), 'skill');

    // Should NOT throw even though .claude.bak already exists
    const staged = await stageAgentWorkspace(agentDir, targetDir);

    // Agent's .claude/ is now visible via junction
    expect(existsSync(join(targetDir, '.claude', 'skills', 'test.md'))).toBe(true);

    await staged.cleanup();
  });

  test('handles stale CLAUDE.md.bak from previous incomplete cleanup', async () => {
    writeFileSync(join(targetDir, 'CLAUDE.md'), '# Current');
    writeFileSync(join(targetDir, 'CLAUDE.md.bak'), '# Stale backup');
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Agent');

    // Should NOT throw even though CLAUDE.md.bak already exists
    const staged = await stageAgentWorkspace(agentDir, targetDir);

    expect(readFileSync(join(targetDir, 'CLAUDE.md'), 'utf-8')).toBe('# Agent');

    await staged.cleanup();

    // Original restored (from new backup, stale one was removed)
    expect(readFileSync(join(targetDir, 'CLAUDE.md'), 'utf-8')).toBe('# Current');
  });

  test('detects and removes stale junction .claude/ from previous run', async () => {
    // Set up agent source with .claude/
    mkdirSync(join(agentDir, '.claude', 'skills'), { recursive: true });
    writeFileSync(join(agentDir, '.claude', 'skills', 'test.md'), 'skill');

    // Create a "stale junction" scenario: first staging leaves a junction
    const firstStaged = await stageAgentWorkspace(agentDir, targetDir);
    // Verify it's a symlink/junction
    expect(lstatSync(join(targetDir, '.claude')).isSymbolicLink()).toBe(true);
    // DON'T call cleanup — simulate a crash

    // Second staging should handle the stale junction gracefully
    const secondStaged = await stageAgentWorkspace(agentDir, targetDir);

    expect(existsSync(join(targetDir, '.claude', 'skills', 'test.md'))).toBe(true);

    await secondStaged.cleanup();
  });
});

describe('stageAgentWorkspace — private overlay', () => {
  let overlayDir: string;

  beforeEach(() => {
    overlayDir = join(tempDir, 'overlay-agent');
    mkdirSync(overlayDir, { recursive: true });
  });

  test('merges overlay .claude/ skills over base as a real (copied) dir, not a junction', async () => {
    mkdirSync(join(agentDir, '.claude', 'skills', 'base-skill'), { recursive: true });
    writeFileSync(join(agentDir, '.claude', 'skills', 'base-skill', 'SKILL.md'), 'base');
    mkdirSync(join(overlayDir, '.claude', 'skills', 'private-skill'), { recursive: true });
    writeFileSync(join(overlayDir, '.claude', 'skills', 'private-skill', 'SKILL.md'), 'private');

    const staged = await stageAgentWorkspace(agentDir, targetDir, overlayDir);

    expect(existsSync(join(targetDir, '.claude', 'skills', 'base-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(targetDir, '.claude', 'skills', 'private-skill', 'SKILL.md'))).toBe(true);
    // A real directory — so cleanup's rm -rf can never follow a junction into source.
    expect(lstatSync(join(targetDir, '.claude')).isSymbolicLink()).toBe(false);

    await staged.cleanup();
    expect(existsSync(join(targetDir, '.claude'))).toBe(false);
  });

  test('overlay file overrides base on name clash', async () => {
    mkdirSync(join(agentDir, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(agentDir, '.claude', 'rules', 'r.md'), 'base-rule');
    mkdirSync(join(overlayDir, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(overlayDir, '.claude', 'rules', 'r.md'), 'overlay-rule');

    const staged = await stageAgentWorkspace(agentDir, targetDir, overlayDir);
    expect(readFileSync(join(targetDir, '.claude', 'rules', 'r.md'), 'utf-8')).toBe('overlay-rule');
    await staged.cleanup();
  });

  test('CLAUDE.append.md is appended to base CLAUDE.md (real file)', async () => {
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Base');
    writeFileSync(join(overlayDir, 'CLAUDE.append.md'), '## Private addendum');

    const staged = await stageAgentWorkspace(agentDir, targetDir, overlayDir);
    const content = readFileSync(join(targetDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('# Base');
    expect(content).toContain('## Private addendum');
    expect(lstatSync(join(targetDir, 'CLAUDE.md')).isSymbolicLink()).toBe(false);

    await staged.cleanup();
    expect(existsSync(join(targetDir, 'CLAUDE.md'))).toBe(false);
  });

  test('overlay dir without .claude/ or append leaves the base junction path intact', async () => {
    mkdirSync(join(agentDir, '.claude'), { recursive: true });
    const staged = await stageAgentWorkspace(agentDir, targetDir, overlayDir);
    expect(lstatSync(join(targetDir, '.claude')).isSymbolicLink()).toBe(true);
    await staged.cleanup();
  });
});

describe('stageAgentWorkspace — overlay CLAUDE.md replace', () => {
  let overlayDir: string;

  beforeEach(() => {
    overlayDir = join(tempDir, 'overlay-agent');
    mkdirSync(overlayDir, { recursive: true });
  });

  test('overlay CLAUDE.md replaces the base', async () => {
    writeFileSync(join(agentDir, 'CLAUDE.md'), 'BASE');
    writeFileSync(join(overlayDir, 'CLAUDE.md'), 'OVERLAY');

    const staged = await stageAgentWorkspace(agentDir, targetDir, overlayDir);
    expect(readFileSync(join(targetDir, 'CLAUDE.md'), 'utf8')).toBe('OVERLAY');
    await staged.cleanup();
  });

  test('overlay CLAUDE.md present → CLAUDE.append.md is ignored', async () => {
    writeFileSync(join(agentDir, 'CLAUDE.md'), 'BASE');
    writeFileSync(join(overlayDir, 'CLAUDE.md'), 'OVERLAY');
    writeFileSync(join(overlayDir, 'CLAUDE.append.md'), 'APPEND');

    const staged = await stageAgentWorkspace(agentDir, targetDir, overlayDir);
    expect(readFileSync(join(targetDir, 'CLAUDE.md'), 'utf8')).toBe('OVERLAY');
    await staged.cleanup();
  });

  test('append-only (no overlay CLAUDE.md) concatenates onto base', async () => {
    writeFileSync(join(agentDir, 'CLAUDE.md'), 'BASE');
    writeFileSync(join(overlayDir, 'CLAUDE.append.md'), 'APPEND');

    const staged = await stageAgentWorkspace(agentDir, targetDir, overlayDir);
    expect(readFileSync(join(targetDir, 'CLAUDE.md'), 'utf8')).toBe('BASE\n\nAPPEND');
    await staged.cleanup();
  });

  test('overlay-only CLAUDE.md with no public base stages correctly', async () => {
    // no CLAUDE.md in agentDir (the public base)
    writeFileSync(join(overlayDir, 'CLAUDE.md'), 'OVERLAY');

    const staged = await stageAgentWorkspace(agentDir, targetDir, overlayDir);
    expect(readFileSync(join(targetDir, 'CLAUDE.md'), 'utf8')).toBe('OVERLAY');
    await staged.cleanup();
  });

  test('cleanup restores a pre-existing CLAUDE.md in cwd', async () => {
    writeFileSync(join(agentDir, 'CLAUDE.md'), 'BASE');
    writeFileSync(join(overlayDir, 'CLAUDE.md'), 'OVERLAY');
    writeFileSync(join(targetDir, 'CLAUDE.md'), 'PREEXISTING');

    const staged = await stageAgentWorkspace(agentDir, targetDir, overlayDir);
    expect(readFileSync(join(targetDir, 'CLAUDE.md'), 'utf8')).toBe('OVERLAY');
    await staged.cleanup();
    expect(readFileSync(join(targetDir, 'CLAUDE.md'), 'utf8')).toBe('PREEXISTING');
  });
});
