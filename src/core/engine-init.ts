/**
 * Extracted init helpers for the Lynox orchestrator.
 * Pure functions operating on explicit parameters — no class state.
 * Pattern: same as run-history-analytics.ts / run-history-persistence.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
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
import { SCOPE_WEIGHTS } from '../types/index.js';
import type { RunHistory } from './run-history.js';
import { Memory } from './memory.js';
import { SecretVault } from './secret-vault.js';
import { SecretStore } from './secret-store.js';
import { setVaultApiKeyExists } from './config.js';
import { channels } from './observability.js';
import { configurePersistentBudget } from './session-budget.js';
import { configureHttpRateLimits, configureEnforceHttps } from '../tools/builtin/http.js';
import { resolveActiveScopes } from './scope-resolver.js';
import { createEmbeddingProvider } from './embedding.js';
import type { EmbeddingProvider, OnnxModelId } from './embedding.js';
import { KnowledgeLayer } from './knowledge-layer.js';
import { KNOWLEDGE_GRAPH_DB_NAME } from './knowledge-graph.js';
import { DataStoreBridge } from './datastore-bridge.js';
import { getLynoxDir } from './config.js';
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
): void {
  configurePersistentBudget({
    costProvider: runHistory,
    dailyCapUSD: userConfig.max_daily_cost_usd,
    monthlyCapUSD: userConfig.max_monthly_cost_usd,
  });
  configureHttpRateLimits({
    provider: runHistory,
    hourlyLimit: userConfig.max_http_requests_per_hour,
    dailyLimit: userConfig.max_http_requests_per_day,
  });
  configureEnforceHttps(userConfig.enforce_https === true);
}

export function setupHistorySubscriptions(
  history: RunHistory,
  getCurrentRunId: () => string | null,
  getAndIncrementSeq: () => number,
): void {
  // tool:end → fire-and-forget tool call recording
  channels.toolEnd.subscribe((msg: unknown) => {
    const runId = getCurrentRunId();
    if (!runId) return;
    const data = msg as { name: string; duration: number; success: boolean; error?: string | undefined; input?: string | undefined };
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

export function initSecrets(userConfig: LynoxUserConfig): SecretResult {
  const parts: string[] = [];
  let vault: SecretVault | null = null;
  let store: SecretStore | null = null;

  try {
    try {
      vault = new SecretVault();
      const migrated = vault.migrateFromFile();
      if (migrated > 0) {
        parts.push(`Migrated ${migrated} secret(s) from secrets.json to encrypted vault.`);
      }

      // Migrate secrets from plaintext config to vault
      _migrateConfigSecretsToVault(vault, userConfig);

      // Load secrets from vault if not set via env or config
      if (!userConfig.api_key && !process.env['ANTHROPIC_API_KEY']) {
        const vaultApiKey = vault.get('ANTHROPIC_API_KEY');
        if (vaultApiKey) {
          userConfig.api_key = vaultApiKey;
        }
      }
      if (!userConfig.google_client_secret && !process.env['GOOGLE_CLIENT_SECRET']) {
        const v = vault.get('GOOGLE_CLIENT_SECRET');
        if (v) userConfig.google_client_secret = v;
      }
      if (!userConfig.search_api_key && !process.env['TAVILY_API_KEY'] && !process.env['BRAVE_API_KEY']) {
        const v = vault.get('SEARCH_API_KEY');
        if (v) userConfig.search_api_key = v;
      }
      if (!userConfig.voyage_api_key && !process.env['VOYAGE_API_KEY']) {
        const v = vault.get('VOYAGE_API_KEY');
        if (v) userConfig.voyage_api_key = v;
      }

      // Load MCP secret from vault if not set via env
      if (!process.env['LYNOX_MCP_SECRET']) {
        const mcpSecret = vault.get('LYNOX_MCP_SECRET');
        if (mcpSecret) {
          process.env['LYNOX_MCP_SECRET'] = mcpSecret;
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
          process.stderr.write('⚠ Encrypted vault found but LYNOX_VAULT_KEY is not set. Run: lynox init\n');
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
    { vaultName: 'VOYAGE_API_KEY', configField: 'voyage_api_key', envVar: 'VOYAGE_API_KEY' },
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

  // Also check BRAVE_API_KEY env for search_api_key
  if (!vault.has('SEARCH_API_KEY') && userConfig.search_api_key && process.env['BRAVE_API_KEY']) {
    // search_api_key came from BRAVE_API_KEY env — don't migrate
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
      `${s.type}:${s.id}${s.type === 'global' ? '' : ` (${SCOPE_WEIGHTS[s.type]})`}`
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
  const memory = new Memory(
    undefined,
    userConfig.api_key,
    userConfig.api_base_url,
    contextId,
    maskFn,
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
      userConfig.voyage_api_key,
      userConfig.embedding_model as OnnxModelId | undefined,
    );
  } catch {
    return null;
  }
}

export async function initKnowledgeLayer(
  userConfig: LynoxUserConfig,
  embeddingProvider: EmbeddingProvider | null,
  client: Anthropic,
): Promise<KnowledgeLayer | null> {
  if (userConfig.knowledge_graph_enabled === false || !embeddingProvider) return null;
  try {
    const lynoxDir = getLynoxDir();
    const graphPath = `${lynoxDir}/${KNOWLEDGE_GRAPH_DB_NAME}`;
    const layer = new KnowledgeLayer(graphPath, embeddingProvider, client);
    await layer.init();
    return layer;
  } catch (err: unknown) {
    process.stderr.write(`[lynox:knowledge] Graph init failed: ${getErrorMessage(err)}\n`);
    return null;
  }
}

export function initDataStoreBridge(
  knowledgeLayer: KnowledgeLayer,
  dataStore: import('./data-store.js').DataStore,
): DataStoreBridge {
  const bridge = new DataStoreBridge(
    knowledgeLayer.getGraph(),
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
    const data = msg as { namespace: string; content: string; scopeType?: string | undefined; scopeId?: string | undefined };

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
            { sourceRunId: getCurrentRunId() ?? undefined },
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
