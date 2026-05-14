/**
 * Extracted init helpers for the Lynox orchestrator.
 * Pure functions operating on explicit parameters — no class state.
 * Pattern: same as run-history-analytics.ts / run-history-persistence.ts.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { getErrorMessage } from './utils.js';
import { writeFileAtomicSync } from './atomic-write.js';
import type {
  LynoxConfig,
  LynoxUserConfig,
  LynoxContext,
  MemoryScopeRef,
  MemoryNamespace,
  MemoryScopeType,
  DataStoreColumnDef,
} from '../types/index.js';
import { scopeWeight } from './scope-resolver.js';
import type { RunHistory } from './run-history.js';
import { Memory } from './memory.js';
import { SecretVault } from './secret-vault.js';
import { SecretStore } from './secret-store.js';
import { setVaultApiKeyExists } from './config.js';
import { channels } from './observability.js';
import { configurePersistentBudget } from './session-budget.js';
import { applyHttpRateLimits, applyEnforceHttps } from './tool-context.js';
import type { ToolContext } from './tool-context.js';
import { configureMailRateLimits } from '../integrations/mail/tools/rate-limit.js';
import { resolveActiveScopes } from './scope-resolver.js';
import { createEmbeddingProvider } from './embedding.js';
import type { EmbeddingProvider, OnnxModelId } from './embedding.js';
import { KnowledgeLayer } from './knowledge-layer.js';
import { DataStoreBridge } from './datastore-bridge.js';
import { getLynoxDir } from './config.js';
import { FILE_MODE_PRIVATE } from './constants.js';
import {
  generateBriefing,
  buildFileManifest,
  diffManifest,
  formatManifestDiff,
  loadManifest,
} from './project.js';
import { getWorkspaceDir, isWorkspaceActive } from './workspace.js';
// setMemoryKnowledgeLayer removed — knowledgeLayer now on ToolContext

// ── History + Budget + Subscriptions ────────────────────────────

export function configureBudgetAndRateLimits(
  runHistory: RunHistory,
  userConfig: LynoxUserConfig,
  toolContext: ToolContext,
): void {
  // Env vars override config (managed hosting sets tier-specific limits via env)
  const envFloat = (key: string): number | undefined => {
    const v = parseFloat(process.env[key] ?? '');
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const envInt = (key: string): number | undefined => {
    const v = parseInt(process.env[key] ?? '', 10);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };

  configurePersistentBudget({
    costProvider: runHistory,
    sessionCapUSD: envFloat('LYNOX_MAX_SESSION_COST_USD') ?? userConfig.max_session_cost_usd,
    dailyCapUSD: envFloat('LYNOX_MAX_DAILY_COST_USD') ?? userConfig.max_daily_cost_usd,
    monthlyCapUSD: envFloat('LYNOX_MAX_MONTHLY_COST_USD') ?? userConfig.max_monthly_cost_usd,
  });
  applyHttpRateLimits(
    toolContext,
    runHistory,
    envInt('LYNOX_MAX_HTTP_REQUESTS_PER_HOUR') ?? userConfig.max_http_requests_per_hour,
    envInt('LYNOX_MAX_HTTP_REQUESTS_PER_DAY') ?? userConfig.max_http_requests_per_day,
  );
  // Dedup window: ENV accepts 0 to disable (envInt() rejects non-positive).
  const dedupEnv = process.env['LYNOX_MAIL_DEDUP_WINDOW_SEC'];
  const dedupEnvNum = dedupEnv !== undefined ? parseInt(dedupEnv, 10) : NaN;
  const dedupSec = Number.isFinite(dedupEnvNum) && dedupEnvNum >= 0
    ? dedupEnvNum
    : userConfig.mail_dedup_window_sec;
  configureMailRateLimits({
    provider: runHistory,
    hourlyLimit: envInt('LYNOX_MAX_MAIL_SENDS_PER_HOUR') ?? userConfig.max_mail_sends_per_hour,
    dailyLimit: envInt('LYNOX_MAX_MAIL_SENDS_PER_DAY') ?? userConfig.max_mail_sends_per_day,
    dedupWindowMs: dedupSec !== undefined ? dedupSec * 1000 : undefined,
  });
  applyEnforceHttps(toolContext, userConfig.enforce_https === true);
}

export function setupHistorySubscriptions(
  history: RunHistory,
  getCurrentRunId: () => string | null,
  getAndIncrementSeq: () => number,
  addUserWaitMs?: (ms: number) => void,
): void {
  // tool:end → fire-and-forget tool call recording
  channels.toolEnd.subscribe((msg: unknown) => {
    const runId = getCurrentRunId();
    if (!runId) return;
    const data = msg as { name: string; duration: number; success: boolean; error?: string | undefined; input?: string | undefined };
    // Track user wait time from interactive tools
    if (data.name === 'ask_user' && addUserWaitMs) {
      addUserWaitMs(Math.round(data.duration));
    }
    try {
      history.insertToolCall({
        runId,
        toolName: data.name,
        inputJson: data.input ?? '{}',
        outputJson: data.success ? '' : (data.error ?? 'unknown error'),
        durationMs: Math.round(data.duration),
        sequenceOrder: getAndIncrementSeq(),
      });
    } catch {
      // Fire-and-forget
    }
  });

  // spawn:end → genealogy tracking
  channels.spawnEnd.subscribe((msg: unknown) => {
    const data = msg as {
      parentRunId?: string | undefined;
      depth?: number | undefined;
      spawnRecords?: Array<{
        childName: string;
        childRunId?: string | undefined;
      }> | undefined;
    };
    if (!data.parentRunId || !data.spawnRecords) return;
    const parentRunId = data.parentRunId;
    const depth = data.depth ?? 1;
    for (const rec of data.spawnRecords) {
      if (!rec.childRunId) continue;
      try {
        history.insertSpawn({
          parentRunId,
          childRunId: rec.childRunId,
          depth,
        });
      } catch {
        // Fire-and-forget
      }
    }
  });
}

// ── Briefing ────────────────────────────────────────────────────

export interface BriefingResult {
  briefing: string | undefined;
  manifest: Map<string, number> | null;
}

/** Max briefing size in chars (~2K tokens). Manifest diff is trimmed first if over budget. */
const MAX_BRIEFING_CHARS = 8_000;

export async function generateInitBriefing(
  context: LynoxContext,
  runHistory: RunHistory | null,
  activeScopes: MemoryScopeRef[],
): Promise<BriefingResult> {
  if (context.source !== 'cli' || !context.localDir) {
    return { briefing: undefined, manifest: null };
  }

  try {
    const parts: string[] = [];

    // Run history briefing (highest priority — kept intact)
    if (runHistory) {
      const brief = generateBriefing(context.localDir, runHistory);
      if (brief) parts.push(brief);
    }

    // File change awareness: diff current manifest against saved
    const prevManifest = loadManifest(getLynoxDir(), context.id);
    const manifest = buildFileManifest(context.localDir);

    let diffText: string | undefined;
    if (prevManifest) {
      const diff = diffManifest(prevManifest, manifest);
      diffText = formatManifestDiff(diff);
      if (diffText) parts.push(diffText);
    }

    // Workspace awareness
    if (isWorkspaceActive()) {
      parts.push(`<workspace>\nYour workspace directory is ${getWorkspaceDir()}. All file operations (read_file, write_file, batch_files) are sandboxed to this directory and /tmp. Bash commands default to this directory. The workspace persists across container restarts.\n</workspace>`);
    }

    // Task overview for briefing (pure SQL, <10ms)
    if (runHistory) {
      try {
        const { TaskManager } = await import('./task-manager.js');
        const tm = new TaskManager(runHistory);
        const taskBriefing = tm.getBriefingSummary(activeScopes);
        if (taskBriefing) parts.push(taskBriefing);
      } catch {
        // Best-effort
      }
    }

    if (parts.length === 0) {
      return { briefing: undefined, manifest };
    }

    let assembled = parts.join('\n\n');

    // Cap total briefing size — trim manifest diff first (most verbose, least critical)
    if (assembled.length > MAX_BRIEFING_CHARS && diffText && diffText.length > 200) {
      const suffix = '\n...[file changes truncated]';
      const nonDiffLen = assembled.length - diffText.length; // other parts + separators
      const budgetForDiff = Math.max(200, MAX_BRIEFING_CHARS - nonDiffLen - suffix.length);
      const trimmedDiff = diffText.slice(0, budgetForDiff) + suffix;
      const partsWithoutDiff = parts.filter(p => p !== diffText);
      const diffIdx = parts.indexOf(diffText);
      partsWithoutDiff.splice(diffIdx, 0, trimmedDiff);
      assembled = partsWithoutDiff.join('\n\n');
    }

    // Hard cap if still over budget
    if (assembled.length > MAX_BRIEFING_CHARS) {
      assembled = assembled.slice(0, MAX_BRIEFING_CHARS) + '\n...[briefing truncated]';
    }

    return {
      briefing: assembled,
      manifest,
    };
  } catch {
    // Briefing is best-effort — never fail init
    return { briefing: undefined, manifest: null };
  }
}

// ── Secrets ─────────────────────────────────────────────────────

export interface SecretResult {
  vault: SecretVault | null;
  store: SecretStore | null;
  briefingParts: string[];
}

/**
 * Auto-generate and persist the engine HTTP API bearer secret if none is
 * configured. Mirrors `_ensureVaultKey`'s pattern — env > persisted file >
 * generate-and-persist. Called from `LynoxHTTPApi.start()` for the Web UI
 * mode (where the server binds to 0.0.0.0); API-only mode keeps its
 * localhost-only fallback and never auto-generates.
 *
 * Priority: LYNOX_HTTP_SECRET env > ~/.lynox/http-secret file > auto-generate.
 */
export function ensureHttpSecret(): void {
  if (process.env['LYNOX_HTTP_SECRET']) return;

  const lynoxDir = getLynoxDir();
  const secretFilePath = join(lynoxDir, 'http-secret');

  if (existsSync(secretFilePath)) {
    try {
      const value = readFileSync(secretFilePath, 'utf-8').trim();
      if (value) {
        process.env['LYNOX_HTTP_SECRET'] = value;
        return;
      }
    } catch { /* fall through to regeneration */ }
  }

  const value = randomBytes(32).toString('hex');
  try {
    writeFileSync(secretFilePath, value + '\n', { mode: FILE_MODE_PRIVATE });
    process.env['LYNOX_HTTP_SECRET'] = value;
    process.stderr.write(`Generated engine HTTP secret → ${secretFilePath}\n`);
  } catch {
    // Filesystem write failed — fall back to a process-lifetime secret so
    // auth still gates the API. Restart will mint a new value, breaking
    // any persisted bearer clients, which is acceptable in the headless
    // ephemeral case where this branch fires.
    process.env['LYNOX_HTTP_SECRET'] = value;
    process.stderr.write('⚠ Could not persist engine HTTP secret. Auth is enforced for this process only.\n');
  }
}

/**
 * Auto-generate and persist a vault key if none is configured.
 * New users get a working vault out of the box.
 *
 * Priority: LYNOX_VAULT_KEY env > ~/.lynox/vault.key file > auto-generate (if no vault.db exists)
 */
function _ensureVaultKey(): void {
  if (process.env['LYNOX_VAULT_KEY']) return;

  const lynoxDir = getLynoxDir();
  const keyFilePath = join(lynoxDir, 'vault.key');
  const vaultDbPath = join(lynoxDir, 'vault.db');

  // Try loading from persisted key file
  if (existsSync(keyFilePath)) {
    try {
      const key = readFileSync(keyFilePath, 'utf-8').trim();
      if (key) {
        process.env['LYNOX_VAULT_KEY'] = key;
        return;
      }
    } catch { /* fall through */ }
  }

  // vault.db exists but no key anywhere → user lost their key, don't overwrite
  if (existsSync(vaultDbPath)) return;

  // First run: generate key and persist
  const key = randomBytes(48).toString('base64');
  try {
    writeFileSync(keyFilePath, key + '\n', { mode: FILE_MODE_PRIVATE });
    process.env['LYNOX_VAULT_KEY'] = key;
    process.stderr.write(`Generated vault key → ${keyFilePath}\n`);
  } catch {
    process.stderr.write('⚠ Could not write vault key file. Secrets will not be persisted.\n');
  }
}

export function initSecrets(userConfig: LynoxUserConfig): SecretResult {
  const parts: string[] = [];
  let vault: SecretVault | null = null;
  let store: SecretStore | null = null;

  // Auto-generate vault key for new users
  _ensureVaultKey();

  try {
    try {
      vault = new SecretVault();
      const migrated = vault.migrateFromFile();
      if (migrated > 0) {
        parts.push(`Migrated ${migrated} secret(s) from secrets.json to encrypted vault.`);
      }

      // Migrate secrets from plaintext config to vault
      _migrateConfigSecretsToVault(vault, userConfig);

      // Load secrets from vault — vault wins over config.json, but explicit env vars
      // always override vault (so users can fix stale vault entries without Web UI).
      const vaultApiKey = vault.get('ANTHROPIC_API_KEY');
      if (vaultApiKey && !process.env['ANTHROPIC_API_KEY']) {
        userConfig.api_key = vaultApiKey;
      } else if (vaultApiKey && process.env['ANTHROPIC_API_KEY']) {
        process.stderr.write('[lynox] ANTHROPIC_API_KEY env var overrides vault value\n');
      }

      const vaultGoogleSecret = vault.get('GOOGLE_CLIENT_SECRET');
      if (vaultGoogleSecret && !process.env['GOOGLE_CLIENT_SECRET']) {
        userConfig.google_client_secret = vaultGoogleSecret;
      }

      const vaultSearchKey = vault.get('SEARCH_API_KEY') ?? vault.get('TAVILY_API_KEY');
      if (vaultSearchKey && !process.env['TAVILY_API_KEY']) {
        userConfig.search_api_key = vaultSearchKey;
      }


      // Load MCP secret from vault if not set via env
      if (!process.env['LYNOX_MCP_SECRET']) {
        const mcpSecret = vault.get('LYNOX_MCP_SECRET');
        if (mcpSecret) {
          process.env['LYNOX_MCP_SECRET'] = mcpSecret;
        }
      }

      // Mistral API key — BYOK users may store it via Web UI (vault) without
      // exporting an env var. Voice (speak/transcribe) and the llm_mode
      // eu-sovereign override (core/config.ts) read from process.env, so sync
      // vault → env here on init. Env still wins if the user set both.
      if (!process.env['MISTRAL_API_KEY']) {
        const mistralKey = vault.get('MISTRAL_API_KEY');
        if (mistralKey) {
          process.env['MISTRAL_API_KEY'] = mistralKey;
        }
      }

      // Warn if MCP secret is stale (>90 days since last update)
      _warnStaleMcpSecret(vault);

      // Inform config module about vault api_key presence
      setVaultApiKeyExists(vault.has('ANTHROPIC_API_KEY'));
    } catch {
      vault = null;
      // Warn if vault.db exists but vault key is missing
      if (!process.env['LYNOX_VAULT_KEY']) {
        const vaultDbPath = join(getLynoxDir(), 'vault.db');
        if (existsSync(vaultDbPath)) {
          process.stderr.write('⚠ Encrypted vault found but LYNOX_VAULT_KEY is not set. Set the LYNOX_VAULT_KEY env var or configure in Settings → Config → Security.\n');
        }
      }
    }
    store = new SecretStore(userConfig, vault ?? undefined);
    if (store.size > 0) {
      const names = store.listNames().map(n => `secret:${n} (${store!.getMasked(n)})`).join(', ');
      parts.push(`<secrets>${names}</secrets>`);
    }
  } catch {
    store = null;
  }

  return { vault, store, briefingParts: parts };
}

/**
 * Migrate secrets from plaintext config.json to encrypted vault.
 * Only runs once per secret: if vault has no entry and config has one.
 * After migration, removes the field from the config file.
 */
function _migrateConfigSecretsToVault(vault: SecretVault, userConfig: LynoxUserConfig): void {
  const migrations: Array<{
    vaultName: string;
    configField: keyof LynoxUserConfig;
    envVar: string;
  }> = [
    { vaultName: 'ANTHROPIC_API_KEY', configField: 'api_key', envVar: 'ANTHROPIC_API_KEY' },
    { vaultName: 'GOOGLE_CLIENT_SECRET', configField: 'google_client_secret', envVar: 'GOOGLE_CLIENT_SECRET' },
    { vaultName: 'SEARCH_API_KEY', configField: 'search_api_key', envVar: 'TAVILY_API_KEY' },
  ];

  const fieldsToRemove: string[] = [];

  for (const m of migrations) {
    if (vault.has(m.vaultName)) continue;
    const value = userConfig[m.configField];
    if (typeof value !== 'string' || !value) continue;
    if (process.env[m.envVar]) continue; // Don't store env-sourced keys
    vault.set(m.vaultName, value, 'any');
    fieldsToRemove.push(m.configField);
  }

  if (fieldsToRemove.length === 0) return;

  // Remove migrated fields from plaintext config file
  try {
    const configPath = join(getLynoxDir(), 'config.json');
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      let changed = false;
      for (const field of fieldsToRemove) {
        if (parsed[field]) {
          delete parsed[field];
          changed = true;
        }
      }
      if (changed) {
        writeFileAtomicSync(configPath, JSON.stringify(parsed, null, 2) + '\n');
      }
    }
  } catch {
    // Best-effort — config file removal is not critical
  }
}

const MCP_SECRET_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/**
 * Warn if the MCP secret in the vault is older than 90 days.
 * Env-only secrets can't be age-checked — we just recommend vault storage.
 */
function _warnStaleMcpSecret(vault: SecretVault): void {
  if (!vault.has('LYNOX_MCP_SECRET')) {
    if (process.env['LYNOX_MCP_SECRET']) {
      // Secret is env-only — can't track age, just hint
      // (no warning here, the TLS warning in mcp-server already covers exposure)
    }
    return;
  }

  const entries = vault.list();
  const mcpEntry = entries.find(e => e.name === 'LYNOX_MCP_SECRET');
  if (!mcpEntry) return;

  const updatedAt = new Date(mcpEntry.updatedAt).getTime();
  const ageMs = Date.now() - updatedAt;
  if (ageMs > MCP_SECRET_MAX_AGE_MS) {
    const ageDays = Math.round(ageMs / (24 * 60 * 60 * 1000));
    process.stderr.write(
      `⚠ MCP secret is ${ageDays} days old — consider rotating: lynox vault set LYNOX_MCP_SECRET <new-secret>\n`,
    );
  }
}

// ── Scopes ──────────────────────────────────────────────────────

export interface ScopeResult {
  userId: string | null;
  scopes: MemoryScopeRef[];
  briefingPart: string | undefined;
}

export function initScopes(
  userConfig: LynoxUserConfig,
  context: LynoxContext | null,
  runHistory: RunHistory | null,
  memory: Memory | null,
): ScopeResult {
  const userId = userConfig.user_id ?? null;
  const scopes = resolveActiveScopes({
    userId: userId ?? undefined,
    contextId: context?.id,
  });

  // Register scopes in SQLite (best-effort)
  if (runHistory) {
    try {
      for (const scope of scopes) {
        let name: string;
        switch (scope.type) {
          case 'global':
            name = 'Global';
            break;
          case 'context':
            name = context?.name
              ? `Context: ${context.name}`
              : `Context ${scope.id.slice(0, 8)}`;
            break;
          case 'user':
            name = `User ${scope.id}`;
            break;
        }
        runHistory.insertScope(scope.id, scope.type, name);
      }
    } catch { /* fire-and-forget */ }
  }

  let briefingPart: string | undefined;
  if (scopes.length > 0) {
    const scopeList = scopes.map(s =>
      `${s.type}:${s.id}${s.type === 'global' ? '' : ` (${scopeWeight(s.type)})`}`
    ).join(', ');
    const autoNote = (memory?.['_autoScope'] === true && scopes.length > 1)
      ? ' Auto-scope active.' : '';
    briefingPart = `<memory_scopes>${scopeList}${autoNote}</memory_scopes>`;
  }

  return { userId, scopes, briefingPart };
}

// ── Memory ──────────────────────────────────────────────────────

export async function initMemoryInstance(
  config: LynoxConfig,
  userConfig: LynoxUserConfig,
  activeScopes: MemoryScopeRef[],
  contextId: string | undefined,
  secretStore: SecretStore | null,
): Promise<Memory | null> {
  if (config.memory === false) return null;

  const maskFn = secretStore
    ? (text: string) => secretStore.maskSecrets(text)
    : undefined;
  const { isFeatureEnabled } = await import('./features.js');
  const memory = new Memory(
    undefined,
    userConfig.api_key,
    userConfig.api_base_url,
    contextId,
    maskFn,
    isFeatureEnabled('flat-file-memory'),
    userConfig.provider,
    userConfig.openai_model_id,
  );

  if (activeScopes.length > 0) {
    memory.setActiveScopes(activeScopes);
  }
  const autoScopeConfig = userConfig.memory_auto_scope;
  if (autoScopeConfig !== undefined) {
    memory.setAutoScope(autoScopeConfig);
  } else {
    memory.setAutoScope(activeScopes.length > 1);
  }
  if (userConfig.memory_extraction_limit !== undefined) {
    memory.setExtractionLimit(userConfig.memory_extraction_limit);
  }

  await memory.loadAll();
  return memory;
}

// ── Embeddings + Knowledge Graph ────────────────────────────────

export function initEmbeddingProvider(
  userConfig: LynoxUserConfig,
  runHistory: RunHistory | null,
): EmbeddingProvider | null {
  if (!runHistory) return null;
  try {
    return createEmbeddingProvider(
      userConfig.embedding_provider ?? 'onnx',
      userConfig.embedding_model as OnnxModelId | undefined,
    );
  } catch {
    return null;
  }
}

/** Default filename for the unified agent memory SQLite database. */
const AGENT_MEMORY_DB_NAME = 'agent-memory.db';

export async function initKnowledgeLayer(
  userConfig: LynoxUserConfig,
  embeddingProvider: EmbeddingProvider | null,
  client: Anthropic,
  runHistory?: RunHistory | null | undefined,
): Promise<KnowledgeLayer | null> {
  if (userConfig.knowledge_graph_enabled === false || !embeddingProvider) return null;
  try {
    const lynoxDir = getLynoxDir();
    const dbPath = `${lynoxDir}/${AGENT_MEMORY_DB_NAME}`;
    const layer = new KnowledgeLayer(dbPath, embeddingProvider, client, runHistory ?? undefined);
    await layer.init();
    return layer;
  } catch (err: unknown) {
    process.stderr.write(`[lynox:knowledge] Agent memory init failed: ${getErrorMessage(err)}\n`);
    return null;
  }
}

export function initDataStoreBridge(
  knowledgeLayer: KnowledgeLayer,
  dataStore: import('./data-store.js').DataStore,
): DataStoreBridge {
  const bridge = new DataStoreBridge(
    knowledgeLayer.getDb(),
    knowledgeLayer.getEntityResolver(),
    dataStore,
  );
  knowledgeLayer.setDataStoreBridge(bridge);

  // Subscribe to dataStoreInsert for async entity indexing
  channels.dataStoreInsert.subscribe((msg: unknown) => {
    const data = msg as {
      event: string;
      collection: string;
      columns?: DataStoreColumnDef[];
      records?: Record<string, unknown>[];
      scopeType?: string;
      scopeId?: string;
    };
    const scope: MemoryScopeRef = {
      type: (data.scopeType as MemoryScopeRef['type']) ?? 'context',
      id: data.scopeId ?? '',
    };

    if (data.event === 'collection_created' && data.columns) {
      void bridge.registerCollection(data.collection, data.columns, scope).catch(() => {});
    } else if (data.event === 'records_inserted' && data.records) {
      void bridge.indexRecords(data.collection, data.records, scope).catch(() => {});
    }
  });

  return bridge;
}

// ── Memory Store Subscription ───────────────────────────────────

export function setupMemoryStoreSubscription(
  knowledgeLayer: KnowledgeLayer | null,
  _embeddingProvider: EmbeddingProvider | null,
  _runHistory: RunHistory | null,
  contextId: string,
  getCurrentRunId: () => string | null,
): void {
  if (!knowledgeLayer) return;

  const MAX_EMBEDDING_CONCURRENCY = 3;
  const activeEmbeddings = new Set<Promise<void>>();

  channels.memoryStore.subscribe((msg: unknown) => {
    const data = msg as { namespace: string; content: string; scopeType?: string | undefined; scopeId?: string | undefined; sourceThreadId?: string | undefined };

    const run = async (): Promise<void> => {
      if (activeEmbeddings.size >= MAX_EMBEDDING_CONCURRENCY) {
        await Promise.race(activeEmbeddings);
      }

      const embedTask = (async () => {
        try {
          const scope: MemoryScopeRef = data.scopeType && data.scopeId
            ? { type: data.scopeType as MemoryScopeType, id: data.scopeId }
            : { type: 'context', id: contextId };
          await knowledgeLayer.store(
            data.content,
            data.namespace as MemoryNamespace,
            scope,
            { sourceRunId: getCurrentRunId() ?? undefined, sourceThreadId: data.sourceThreadId },
          );
        } catch (err: unknown) {
          process.stderr.write(`[lynox:embedding] Failed to store embedding for ${data.namespace}: ${getErrorMessage(err)}\n`);
        }
      })();

      activeEmbeddings.add(embedTask);
      void embedTask.finally(() => { activeEmbeddings.delete(embedTask); });
    };

    void run();
  });
}

// ── Seed Embeddings (removed — Knowledge Graph handles its own seeding) ──
