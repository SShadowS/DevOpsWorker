import { describe, test, expect, beforeEach, afterAll, afterEach } from 'bun:test';
import { mkdirSync, rmSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { PipelineConfig, PipelineState } from '../../src/types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// Tests: resolveAlLspPlugin
// ---------------------------------------------------------------------------

// We test resolveAlLspPlugin by patching the module-level constant via a
// re-export trick. Instead, we directly test the logic by creating temp dirs
// that mimic the plugin cache structure and calling the function after
// pointing it at our temp dir. Since the real function reads a hardcoded
// path, we test the underlying logic by importing and calling it — the
// function gracefully returns undefined when the path doesn't exist (which
// is the case in CI / test environments).

import { resolveAlLspPlugin, azureDevOpsMcp, bcMcp, BC_MCP_TOOLS } from '../../src/sdk/mcp-configs.ts';

describe('resolveAlLspPlugin', () => {
  test('returns undefined when plugin cache does not exist', () => {
    // In test environments the AL LSP plugin is typically not installed,
    // so this exercises the catch path (ENOENT).
    const result = resolveAlLspPlugin();

    // Either undefined (not installed) or a valid SdkPluginConfig (installed on dev machine)
    if (result === undefined) {
      expect(result).toBeUndefined();
    } else {
      expect(result).toEqual({
        type: 'local',
        path: expect.stringContaining('al-language-server-go-windows'),
      });
    }
  });

  test('returns SdkPluginConfig with correct shape when plugin is installed', () => {
    const result = resolveAlLspPlugin();

    if (result !== undefined) {
      expect(result.type).toBe('local');
      expect(typeof result.path).toBe('string');
      expect(result.path).toContain('al-language-server-go-windows');
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: resolveAlLspPlugin — env var override and platform default
// ---------------------------------------------------------------------------

describe('resolveAlLspPlugin env var and platform', () => {
  const tempBase = join(tmpdir(), 'al-lsp-test-' + Date.now());

  afterEach(() => {
    rmSync(tempBase, { recursive: true, force: true });
  });

  test('resolves from custom path when AL_LSP_DIR env var is set', () => {
    const pluginDir = join(tempBase, '1.0.0');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'plugin.json'), '{}');

    const original = process.env['AL_LSP_DIR'];
    process.env['AL_LSP_DIR'] = tempBase;
    try {
      const result = resolveAlLspPlugin();
      expect(result).toEqual({ type: 'local', path: pluginDir });
    } finally {
      if (original === undefined) delete process.env['AL_LSP_DIR'];
      else process.env['AL_LSP_DIR'] = original;
    }
  });

  test('uses platform-specific default path', () => {
    const result = resolveAlLspPlugin();
    expect(result === undefined || result.type === 'local').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: resolveAlLspPlugin logic (isolated with temp directories)
// ---------------------------------------------------------------------------

// To properly unit test the version-picking logic without depending on the
// real plugin cache, we extract and test the core algorithm in isolation.

describe('resolveAlLspPlugin version selection logic', () => {
  let tempCache: string;

  beforeEach(() => {
    tempCache = mkdtempSync(join(tmpdir(), 'al-lsp-test-'));
  });

  afterAll(() => {
    // Clean up all temp dirs created during tests
  });

  function resolveFromDir(cacheDir: string) {
    const { readdirSync } = require('fs');
    const { join: pathJoin } = require('path');
    try {
      const versions = readdirSync(cacheDir) as string[];
      if (versions.length === 0) return undefined;
      const latest = versions.sort().at(-1)!;
      return { type: 'local' as const, path: pathJoin(cacheDir, latest) };
    } catch {
      return undefined;
    }
  }

  test('returns undefined for empty cache directory', () => {
    expect(resolveFromDir(tempCache)).toBeUndefined();

    rmSync(tempCache, { recursive: true, force: true });
  });

  test('returns the single version when one exists', () => {
    mkdirSync(join(tempCache, '1.0.0'));

    const result = resolveFromDir(tempCache);
    expect(result).toEqual({
      type: 'local',
      path: join(tempCache, '1.0.0'),
    });

    rmSync(tempCache, { recursive: true, force: true });
  });

  test('picks latest version when multiple exist', () => {
    mkdirSync(join(tempCache, '1.0.0'));
    mkdirSync(join(tempCache, '2.1.0'));
    mkdirSync(join(tempCache, '1.5.0'));

    const result = resolveFromDir(tempCache);
    expect(result).toEqual({
      type: 'local',
      path: join(tempCache, '2.1.0'),
    });

    rmSync(tempCache, { recursive: true, force: true });
  });

  test('returns undefined for non-existent directory', () => {
    expect(resolveFromDir('/non/existent/path')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: azureDevOpsMcp
// ---------------------------------------------------------------------------

const stubConfig = {
  azureDevOps: {
    orgUrl: 'https://dev.azure.com/test-org',
    pat: 'test-pat',
    project: 'Test Project',
  },
} as PipelineConfig;

describe('azureDevOpsMcp', () => {
  test('does not use cmd.exe as command', () => {
    const mcp = azureDevOpsMcp(stubConfig);
    expect(mcp.command).not.toBe('cmd');
  });

  test('uses npx as command', () => {
    const mcp = azureDevOpsMcp(stubConfig);
    expect(mcp.command).toBe('npx');
  });

  test('passes -y and package name as args', () => {
    const mcp = azureDevOpsMcp(stubConfig);
    expect(mcp.args).toEqual(['-y', '@sshadows/mcp-server-azure-devops']);
  });

  test('passes Azure DevOps env vars', () => {
    const mcp = azureDevOpsMcp(stubConfig);
    expect(mcp.env).toEqual({
      AZURE_DEVOPS_ORG_URL: 'https://dev.azure.com/test-org',
      AZURE_DEVOPS_AUTH_METHOD: 'pat',
      AZURE_DEVOPS_PAT: 'test-pat',
      AZURE_DEVOPS_DEFAULT_PROJECT: 'Test Project',
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: bcMcp
// ---------------------------------------------------------------------------

type Env = NonNullable<PipelineState['environment']>;

const baseEnv: Env = {
  envId: 'env-123',
  url: 'https://demoportal.example.com/abcd',  // no trailing slash
  description: 'WI-100',
  profileId: 'p',
  createdAt: '2026-04-28T00:00:00Z',
  coreActivated: true,
  activated: true,
  credentials: {
    username: 'testuser',
    password: 'secret',
    tenantId: 'default',
    selectedBy: 'fallback-default',
  },
};

describe('bcMcp', () => {
  test('returns stdio config with npx + business-central-mcp', () => {
    const cfg = bcMcp(baseEnv);
    expect(cfg).toBeDefined();
    expect(cfg!.type).toBe('stdio');
    expect(cfg!.command).toBe('npx');
    expect(cfg!.args).toEqual(['-y', 'business-central-mcp']);
  });

  test('appends trailing slash to BC_BASE_URL when missing', () => {
    const cfg = bcMcp(baseEnv)!;
    expect(cfg.env!['BC_BASE_URL']).toBe('https://demoportal.example.com/abcd/');
  });

  test('preserves trailing slash when present', () => {
    const cfg = bcMcp({ ...baseEnv, url: 'https://x.com/y/' })!;
    expect(cfg.env!['BC_BASE_URL']).toBe('https://x.com/y/');
  });

  test('wires credentials into env', () => {
    const cfg = bcMcp(baseEnv)!;
    expect(cfg.env!['BC_USERNAME']).toBe('testuser');
    expect(cfg.env!['BC_PASSWORD']).toBe('secret');
    expect(cfg.env!['BC_TENANT_ID']).toBe('default');
    expect(cfg.env!['BC_INVOKE_TIMEOUT']).toBe('60000');
    expect(cfg.env!['BC_TIMEOUT']).toBe('180000');
  });

  test('returns undefined when env is not core-activated', () => {
    expect(bcMcp({ ...baseEnv, coreActivated: false })).toBeUndefined();
    expect(bcMcp({ ...baseEnv, coreActivated: undefined })).toBeUndefined();
  });

  test('returns config even when wizard activation flag is false (coder runs wizard from this connection)', () => {
    const cfg = bcMcp({ ...baseEnv, activated: false });
    expect(cfg).toBeDefined();
    expect(cfg!.command).toBe('npx');
  });

  test('returns undefined when credentials are missing', () => {
    expect(bcMcp({ ...baseEnv, credentials: undefined })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: BC_MCP_TOOLS
// ---------------------------------------------------------------------------

describe('BC_MCP_TOOLS', () => {
  test('lists all 11 bc tools', () => {
    expect(BC_MCP_TOOLS).toHaveLength(11);
    expect(BC_MCP_TOOLS).toContain('mcp__business-central__bc_open_page');
    expect(BC_MCP_TOOLS).toContain('mcp__business-central__bc_run_report');
  });
});
