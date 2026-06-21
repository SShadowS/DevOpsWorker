import { join } from 'path';
import { homedir, platform } from 'os';
import { readdirSync, statSync } from 'fs';
import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig } from '../types/agent.types.ts';
import type { PipelineConfig, PipelineState } from '../types/pipeline.types.ts';

// ---------------------------------------------------------------------------
// MCP server configurations — constructed from PipelineConfig at runtime
// ---------------------------------------------------------------------------

/**
 * Azure DevOps MCP server — provides work item, PR, pipeline, and repo tools.
 * Used by agents that need DevOps read or write access.
 */
export function azureDevOpsMcp(config: PipelineConfig): McpServerConfig {
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@sshadows/mcp-server-azure-devops'],
    env: {
      AZURE_DEVOPS_ORG_URL: config.azureDevOps.orgUrl,
      AZURE_DEVOPS_AUTH_METHOD: 'pat',
      AZURE_DEVOPS_PAT: config.azureDevOps.pat,
      AZURE_DEVOPS_DEFAULT_PROJECT: config.azureDevOps.project,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool name constants — used in AgentConfig.allowedTools
// ---------------------------------------------------------------------------

/** Built-in Claude Code tools */
export const TOOLS = {
  // File system (read-only)
  Read: 'Read',
  Glob: 'Glob',
  Grep: 'Grep',

  // File system (write)
  Edit: 'Edit',
  Write: 'Write',

  // Shell
  Bash: 'Bash',

  // Web
  WebFetch: 'WebFetch',
  WebSearch: 'WebSearch',

  // Sub-agents
  Task: 'Task',

  // Code intelligence
  LSP: 'LSP',

  // Skills
  Skill: 'Skill',
} as const;

/** Common tool sets for agent configurations */
export const TOOL_SETS = {
  /** Read-only file system access */
  fsReadOnly: [TOOLS.Read, TOOLS.Glob, TOOLS.Grep] as string[],

  /** Full file system access */
  fsReadWrite: [TOOLS.Read, TOOLS.Glob, TOOLS.Grep, TOOLS.Edit, TOOLS.Write] as string[],

  /** File system + shell (for agents that need git/az CLI) */
  fsAndBash: [TOOLS.Read, TOOLS.Glob, TOOLS.Grep, TOOLS.Edit, TOOLS.Write, TOOLS.Bash] as string[],

  /** Read-only file system access + LSP code intelligence */
  fsReadOnlyWithLSP: [TOOLS.Read, TOOLS.Glob, TOOLS.Grep, TOOLS.LSP] as string[],

  /** File system + shell + LSP code intelligence */
  fsAndBashWithLSP: [TOOLS.Read, TOOLS.Glob, TOOLS.Grep, TOOLS.Edit, TOOLS.Write, TOOLS.Bash, TOOLS.LSP] as string[],
} as const;

/** MCP-provided tool name sets (for allowedTools whitelisting) */
export const MCP_TOOLS = {
  /** Read-only Zendesk tools — ticket, user, org, article lookups; no mutations */
  zendeskReadOnly: [
    'mcp__zendesk__search',
    'mcp__zendesk__get_ticket',
    'mcp__zendesk__get_ticket_comments',
    'mcp__zendesk__get_ticket_attachments',
    'mcp__zendesk__analyze_ticket_images',
    'mcp__zendesk__analyze_ticket_documents',
    'mcp__zendesk__get_document_summary',
    'mcp__zendesk__list_tickets',
    'mcp__zendesk__get_user',
    'mcp__zendesk__list_users',
    'mcp__zendesk__get_organization',
    'mcp__zendesk__list_organizations',
    'mcp__zendesk__get_group',
    'mcp__zendesk__list_groups',
    'mcp__zendesk__get_article',
    'mcp__zendesk__list_articles',
    'mcp__zendesk__get_macro',
    'mcp__zendesk__list_macros',
    'mcp__zendesk__get_automation',
    'mcp__zendesk__list_automations',
    'mcp__zendesk__get_trigger',
    'mcp__zendesk__list_triggers',
    'mcp__zendesk__get_view',
    'mcp__zendesk__list_views',
    'mcp__zendesk__list_chats',
    'mcp__zendesk__get_talk_stats',
    'mcp__zendesk__support_info',
  ] as string[],
  /** Read-only pipeline tools — list runs, get logs, get timeline */
  pipelinesReadOnly: [
    'mcp__azureDevOps__list_pipeline_runs',
    'mcp__azureDevOps__get_pipeline_run',
    'mcp__azureDevOps__pipeline_timeline',
    'mcp__azureDevOps__get_pipeline_log',
  ] as string[],

  /** Pipeline tools including trigger (for agents that kick off CI) */
  pipelinesWithTrigger: [
    'mcp__azureDevOps__list_pipeline_runs',
    'mcp__azureDevOps__get_pipeline_run',
    'mcp__azureDevOps__pipeline_timeline',
    'mcp__azureDevOps__get_pipeline_log',
    'mcp__azureDevOps__trigger_pipeline',
  ] as string[],

  /** Work item read access */
  workItemRead: [
    'mcp__azureDevOps__get_work_item',
  ] as string[],

  /** Additional PR review tools — commit listing for cherry-pick detection */
  prReviewExtra: [
    'mcp__azureDevOps__list_commits',
  ] as string[],
} as const;

// ---------------------------------------------------------------------------
// Plugin configurations — SDK plugins loaded by path
// ---------------------------------------------------------------------------

function defaultAlLspCacheDir(): string {
  const platformSuffix = platform() === 'win32'
    ? 'al-language-server-go-windows'
    : 'al-language-server-go-linux';
  return join(homedir(), '.claude', 'plugins', 'cache', 'claude-code-lsps', platformSuffix);
}

/** Resolve the installed AL LSP plugin, or undefined if not installed. */
export function resolveAlLspPlugin(): SdkPluginConfig | undefined {
  const cacheDir = process.env['AL_LSP_DIR'] ?? defaultAlLspCacheDir();
  try {
    const entries = readdirSync(cacheDir);
    // Filter to version directories (e.g. "1.6.1") — the plugin root may also contain
    // files (plugin.json, .lsp.json) and non-version dirs (bin/) that must be skipped.
    const versions = entries.filter(e =>
      /^\d+\.\d+/.test(e) && (() => { try { return statSync(join(cacheDir, e)).isDirectory(); } catch { return false; } })()
    );
    if (versions.length === 0) return undefined;
    // Pick latest version (lexicographic sort — semver-safe for same digit count)
    const latest = versions.sort().at(-1)!;
    return { type: 'local', path: join(cacheDir, latest) };
  } catch {
    return undefined;  // Plugin not installed
  }
}

// ---------------------------------------------------------------------------
// Business Central MCP
// ---------------------------------------------------------------------------

/**
 * Business Central MCP server — provides interactive BC page tools.
 * Returns undefined if the env is not core-activated (env-provision hasn't completed)
 * or credentials are missing. NOTE: bc-mcp is wired up regardless of whether the
 * per-app wizard has been run — coder uses this same connection to RUN the wizard.
 * After the wizard completes, ApplicationArea-gated fields render correctly.
 */
export function bcMcp(
  env: NonNullable<PipelineState['environment']>,
): McpServerConfig | undefined {
  if (!env.coreActivated || !env.credentials) return undefined;
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'business-central-mcp'],
    env: {
      BC_BASE_URL: env.url.endsWith('/') ? env.url : env.url + '/',
      BC_USERNAME: env.credentials.username,
      BC_PASSWORD: env.credentials.password,
      BC_TENANT_ID: env.credentials.tenantId,
      BC_INVOKE_TIMEOUT: '60000',
      BC_TIMEOUT: '180000',
    },
  };
}

/** All bc_* tool names — used in allowedTools whitelisting. */
export const BC_MCP_TOOLS: string[] = [
  'mcp__business-central__bc_open_page',
  'mcp__business-central__bc_read_data',
  'mcp__business-central__bc_write_data',
  'mcp__business-central__bc_execute_action',
  'mcp__business-central__bc_respond_dialog',
  'mcp__business-central__bc_navigate',
  'mcp__business-central__bc_search_pages',
  'mcp__business-central__bc_close_page',
  'mcp__business-central__bc_switch_company',
  'mcp__business-central__bc_list_companies',
  'mcp__business-central__bc_run_report',
];

/**
 * AL Object ID Ninja MCP server — assigns/releases AL object IDs against the
 * shared Ninja backend so concurrent work never collides on an object ID.
 *
 * No env config: the server detects the AL app from the file path passed in each
 * tool call and reads ranges + the backend authorization key from the app's
 * app.json and .objidconfig. The target repo must contain a committed
 * .objidconfig (STANDARD/team mode) for backend reservations to work.
 */
export function alObjectIdNinjaMcp(): McpServerConfig {
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@vjeko.com/al-object-id-ninja-mcp'],
  };
}

/** Ninja object-ID tool names — used in allowedTools whitelisting. */
export const OBJID_MCP_TOOLS: string[] = [
  'mcp__al-object-id-ninja__ninja_assignObjectId',
  'mcp__al-object-id-ninja__ninja_unassignObjectId',
];
