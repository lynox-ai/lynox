import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { LynoxUserConfig } from '../types/index.js';
import { ensureDirSync, writeFileAtomicSync } from './atomic-write.js';
import { LynoxUserConfigSchema } from '../types/schemas.js';
import { getErrorMessage } from './utils.js';

const CONFIG_FILENAME = 'config.json';
const LYNOX_DIR = '.lynox';

/** Override for getLynoxDir(). Set via --data-dir or LYNOX_DATA_DIR. */
let _dataDirOverride: string | null = null;

/**
 * Override the data directory for this process.
 * Must be called before Engine.init().
 */
export function setDataDir(dir: string): void {
  _dataDirOverride = dir;
}

function getUserConfigDir(): string {
  return _dataDirOverride ?? process.env['LYNOX_DATA_DIR'] ?? join(homedir(), LYNOX_DIR);
}

function getProjectConfigDir(): string {
  return join(process.cwd(), LYNOX_DIR);
}

function readConfigFile(filePath: string): LynoxUserConfig | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const result = LynoxUserConfigSchema.safeParse(parsed);
    if (!result.success) {
      process.stderr.write(`⚠ Invalid config in ${filePath}: ${result.error.issues[0]?.message ?? 'unknown error'}\n`);
      return null;
    }
    return result.data as LynoxUserConfig;
  } catch (err: unknown) {
    const msg = getErrorMessage(err);
    process.stderr.write(`⚠ Failed to parse ${filePath}: ${msg}\n`);
    return null;
  }
}

let _cachedConfig: LynoxUserConfig | null = null;

/**
 * Merge configs: env > project > user.
 * Result is cached after first call. Use reloadConfig() to refresh.
 */
export function loadConfig(): LynoxUserConfig {
  if (_cachedConfig) return _cachedConfig;
  const userConfig = readConfigFile(join(getUserConfigDir(), CONFIG_FILENAME));
  const projectConfig = readConfigFile(join(getProjectConfigDir(), CONFIG_FILENAME));

  const merged: LynoxUserConfig = { ...userConfig };

  // Allowlist: project config cannot override security-sensitive fields
  const PROJECT_SAFE_KEYS: ReadonlySet<string> = new Set([
    'default_tier', 'thinking_mode', 'effort_level',
    'max_session_cost_usd', 'embedding_provider', 'plugins',
    'organization_id', 'client_id',
    'changeset_review', 'greeting', 'context_name',
    'max_daily_cost_usd', 'max_monthly_cost_usd',
    'max_http_requests_per_hour', 'max_http_requests_per_day',
    'memory_extraction',
    'memory_half_life_days',
    'pipeline_context_limit', 'pipeline_step_result_limit',
    'memory_extraction_limit', 'http_response_limit',
    'enforce_https',
    'sentry_dsn',
    'backup_dir', 'backup_schedule', 'backup_retention_days', 'backup_encrypt',
    'experience',
  ]);

  if (projectConfig) {
    for (const [key, value] of Object.entries(projectConfig)) {
      if (value !== undefined && value !== null && PROJECT_SAFE_KEYS.has(key)) {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
  }

  if (process.env['ANTHROPIC_API_KEY']) {
    merged.api_key = process.env['ANTHROPIC_API_KEY'];
  }
  if (process.env['ANTHROPIC_BASE_URL']) {
    merged.api_base_url = process.env['ANTHROPIC_BASE_URL'];
  }
  if (process.env['LYNOX_WORKSPACE']) {
    merged.workspace_dir = process.env['LYNOX_WORKSPACE'];
  }
  if (process.env['LYNOX_EMBEDDING_PROVIDER']) {
    const ep = process.env['LYNOX_EMBEDDING_PROVIDER'];
    if (ep === 'onnx' || ep === 'local') {
      merged.embedding_provider = ep;
    }
  }
  if (process.env['LYNOX_USER']) {
    merged.user_id = process.env['LYNOX_USER'];
  }
  if (process.env['LYNOX_ORG']) {
    merged.organization_id = process.env['LYNOX_ORG'];
  }
  if (process.env['LYNOX_CLIENT']) {
    merged.client_id = process.env['LYNOX_CLIENT'];
  }
  // Default language
  if (process.env['LYNOX_LANGUAGE']) {
    merged.language = process.env['LYNOX_LANGUAGE'];
  }
  // LLM provider
  if (process.env['LYNOX_LLM_PROVIDER']) {
    const p = process.env['LYNOX_LLM_PROVIDER'];
    if (p === 'anthropic' || p === 'bedrock' || p === 'custom') {
      merged.provider = p;
    }
  }
  if (process.env['AWS_REGION']) {
    merged.aws_region = process.env['AWS_REGION'];
  }
  if (process.env['GOOGLE_CLIENT_ID']) {
    merged.google_client_id = process.env['GOOGLE_CLIENT_ID'];
  }
  if (process.env['GOOGLE_CLIENT_SECRET']) {
    merged.google_client_secret = process.env['GOOGLE_CLIENT_SECRET'];
  }
  if (process.env['TAVILY_API_KEY']) {
    merged.search_api_key = process.env['TAVILY_API_KEY'];
    if (!merged.search_provider) merged.search_provider = 'tavily';
  }
  if (process.env['SEARXNG_URL']) {
    merged.searxng_url = process.env['SEARXNG_URL'];
  }

  _cachedConfig = merged;
  return merged;
}

/**
 * Clear cached config so next loadConfig() re-reads from disk.
 */
export function reloadConfig(): void {
  _cachedConfig = null;
}

/**
 * Write config to ~/.lynox/config.json with 0600 permissions.
 */
export function saveUserConfig(config: LynoxUserConfig): void {
  const dir = getUserConfigDir();
  const filePath = join(dir, CONFIG_FILENAME);
  writeFileAtomicSync(filePath, JSON.stringify(config, null, 2) + '\n');
  _cachedConfig = null; // invalidate cache after write
}

/**
 * Read only the user config file (no project/env merging).
 * Used by /config to modify user settings without leaking env vars into the file.
 */
export function readUserConfig(): LynoxUserConfig {
  const filePath = join(getUserConfigDir(), CONFIG_FILENAME);
  return readConfigFile(filePath) ?? {};
}

let _vaultApiKeyExists: boolean | null = null;

export function hasApiKey(): boolean {
  // Non-Anthropic providers don't need ANTHROPIC_API_KEY
  const config = loadConfig();
  const provider = config.provider;
  if (provider === 'bedrock' || provider === 'custom') return true;
  if (process.env['ANTHROPIC_API_KEY']) return true;
  if (config.api_key !== undefined && config.api_key !== null && config.api_key !== '') return true;
  // Check vault (cached — avoids repeated SQLite opens)
  if (process.env['LYNOX_VAULT_KEY'] && _vaultApiKeyExists === null) {
    // Dynamic import avoided — caller can set via setVaultApiKeyExists()
  }
  return _vaultApiKeyExists === true;
}

/**
 * Tell the config module that ANTHROPIC_API_KEY exists in the vault.
 * Called by orchestrator-init after vault initialization.
 */
export function setVaultApiKeyExists(exists: boolean): void {
  _vaultApiKeyExists = exists;
}

export function getLynoxDir(): string {
  return getUserConfigDir();
}


export function ensureLynoxDir(): string {
  const dir = getUserConfigDir();
  return ensureDirSync(dir);
}
