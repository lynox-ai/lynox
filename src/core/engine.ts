import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type {
  LynoxConfig,
  LynoxUserConfig,
  ToolEntry,
  MCPServer,
  BatchRequest,
  BatchResult,
  ModelTier,
  ContextSource,
} from '../types/index.js';
import { MODEL_MAP } from '../types/index.js';
import type { Memory } from './memory.js';
import { BatchIndex } from './batch-index.js';
import { ToolRegistry } from '../tools/registry.js';
import { loadConfig, getLynoxDir } from './config.js';
import { RunHistory } from './run-history.js';
import { initDebugSubscriber, shutdownDebugSubscriber } from './debug-subscriber.js';
import { saveManifest } from './project.js';
import { resolveContext } from './context.js';
import type { LynoxContext } from '../types/index.js';
import { setTenantWorkspace, ensureContextWorkspace } from './workspace.js';

import type { SecretStore } from './secret-store.js';
import type { SecretVault } from './secret-vault.js';
import type { EmbeddingProvider } from './embedding.js';
import type { KnowledgeLayer } from './knowledge-layer.js';
import type { DataStoreBridge } from './datastore-bridge.js';

import {
  bashTool,
  readFileTool,
  writeFileTool,
  memoryStoreTool,
  memoryRecallTool,
  memoryDeleteTool,
  memoryUpdateTool,
  memoryListTool,
  memoryPromoteTool,
  spawnAgentTool,
  askUserTool,
  batchFilesTool,
  httpRequestTool,
  runPipelineTool,
  taskCreateTool,
  taskUpdateTool,
  taskListTool,
  planTaskTool,
  dataStoreCreateTool,
  dataStoreInsertTool,
  dataStoreQueryTool,
  dataStoreListTool,
  dataStoreDeleteTool,
  captureProcessTool,
  promoteProcessTool,
  apiSetupTool,
} from '../tools/builtin/index.js';
import type { ToolContext } from './tool-context.js';
import { createToolContext } from './tool-context.js';
import {
  configureBudgetAndRateLimits,
  generateInitBriefing,
  initSecrets,
  initScopes,
  initMemoryInstance,
  initEmbeddingProvider,
  initKnowledgeLayer,
  initDataStoreBridge,
  setupMemoryStoreSubscription,
} from './engine-init.js';
import { submitBatch, pollBatch } from './batch.js';
import { DataStore } from './data-store.js';
import { PluginManager } from './plugins.js';
import { isFeatureEnabled } from './features.js';
import type { MemoryScopeRef } from '../types/index.js';
import { runMemoryGc, runGraphGc } from './memory-gc.js';
import { NotificationRouter } from './notification-router.js';
import { WorkerLoop } from './worker-loop.js';
import { Session } from './session.js';
import type { SessionOptions } from './session.js';

/**
 * Per-run metadata passed to lifecycle hooks.
 * Eliminates the need for global state (e.g. tenant ID closures).
 */
export interface RunContext {
  runId: string;
  contextId: string;
  modelTier: ModelTier;
  durationMs: number;
  source: ContextSource;
  /** Active tenant ID, set via Session.tenantId (Pro). */
  tenantId?: string | undefined;
}

/**
 * Lifecycle hooks for extending the engine.
 * Pro packages register hooks to add tenant tracking, tool filtering, etc.
 */
export interface LynoxHooks {
  onInit?(engine: Engine): Promise<void>;
  onBeforeRun?(runId: string, context: RunContext): void | Promise<void>;
  onBeforeCreateAgent?(tools: ToolEntry[]): ToolEntry[];
  onAfterRun?(runId: string, costUsd: number, context: RunContext): void;
  onShutdown?(): Promise<void>;
}

export interface AccumulatedUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

const AUTO_GC_INTERVAL = 50; // Run GC every N runs

/**
 * Engine — shared singleton per process.
 * Owns all expensive, long-lived resources (KG, Memory, DataStore, Secrets, Config).
 * Creates lightweight Sessions for per-conversation state.
 */
export class Engine {
  readonly config: LynoxConfig;
  private userConfig: LynoxUserConfig;
  readonly registry = new ToolRegistry();
  client: Anthropic;
  private readonly batchIndex = new BatchIndex();
  private memory: Memory | null = null;
  private runHistory: RunHistory | null = null;
  private securityAudit: import('./security-audit.js').SecurityAudit | null = null;
  private context: LynoxContext | null = null;
  private briefing: string | undefined = undefined;
  private currentManifest: Map<string, number> | null = null;
  private pluginManager: PluginManager | null = null;
  private embeddingProvider: EmbeddingProvider | null = null;
  private knowledgeLayer: KnowledgeLayer | null = null;
  private dataStoreBridge: DataStoreBridge | null = null;
  private secretVault: SecretVault | null = null;
  private secretStore: SecretStore | null = null;
  private userId: string | null = null;
  private activeScopes: MemoryScopeRef[] = [];
  private _pipelinesEnabled = false;
  private _dataStoreEnabled = false;
  private _dataStore: DataStore | null = null;
  private _taskManager: import('./task-manager.js').TaskManager | null = null;
  private _hooks: LynoxHooks[] = [];
  private _toolContext: ToolContext;
  private _googleAuth: import('../integrations/google/google-auth.js').GoogleAuth | null = null;
  private _lastBatchParentId: string | null = null;
  private runCount = 0;
  private _notificationRouter = new NotificationRouter();
  private _workerLoop: WorkerLoop | null = null;
  private _backupManager: import('./backup.js').BackupManager | null = null;
  private _apiStore: import('./api-store.js').ApiStore | null = null;
  private _crm: import('./crm.js').CRM | null = null;

  constructor(config: LynoxConfig) {
    this.userConfig = loadConfig();
    // Apply user config defaults if not already set in LynoxConfig
    if (!config.model) {
      config.model = this.userConfig.default_tier ?? 'sonnet';
    }
    if (!config.effort && this.userConfig.effort_level) {
      config.effort = this.userConfig.effort_level;
    }
    if (!config.thinking && this.userConfig.thinking_mode) {
      config.thinking = this.userConfig.thinking_mode === 'disabled'
        ? undefined
        : { type: 'adaptive' };
    }
    // Haiku does not support extended thinking — auto-disable
    const resolvedModel = MODEL_MAP[config.model ?? 'sonnet'];
    if (resolvedModel && resolvedModel.includes('haiku')) {
      config.thinking = undefined;
    }
    this.config = config;
    this.client = this.userConfig.api_key
      ? new Anthropic({ apiKey: this.userConfig.api_key, baseURL: this.userConfig.api_base_url })
      : this.userConfig.api_base_url
        ? new Anthropic({ baseURL: this.userConfig.api_base_url })
        : new Anthropic();

    this._toolContext = createToolContext(this.userConfig);
  }

  getUserConfig(): LynoxUserConfig {
    return this.userConfig;
  }

  /** Reload config from disk, update cached reference, and recreate API client if key changed. */
  reloadUserConfig(): void {
    const oldKey = this.userConfig.api_key;
    const oldBase = this.userConfig.api_base_url;
    this.userConfig = loadConfig();
    // Recreate API client if credentials changed
    if (this.userConfig.api_key !== oldKey || this.userConfig.api_base_url !== oldBase) {
      this._recreateClient();
    }
  }

  /** Update API key at runtime (e.g. after saving via web UI) and recreate the client. */
  setApiKey(key: string): void {
    this.userConfig.api_key = key;
    this._recreateClient();
  }

  private _recreateClient(): void {
    this.client = this.userConfig.api_key
      ? new Anthropic({ apiKey: this.userConfig.api_key, baseURL: this.userConfig.api_base_url })
      : this.userConfig.api_base_url
        ? new Anthropic({ baseURL: this.userConfig.api_base_url })
        : new Anthropic();
  }

  async init(): Promise<this> {
    // Activate debug logging early (before any channel publishing)
    initDebugSubscriber();

    // Initialize Sentry error reporting (opt-in — requires DSN env var or config field)
    const sentryDsn = process.env['LYNOX_SENTRY_DSN'] ?? this.userConfig.sentry_dsn;
    if (sentryDsn) {
      try {
        const { initSentry, installGlobalHandlers } = await import('./sentry.js');
        const sentryActive = await initSentry(sentryDsn);
        if (sentryActive) {
          installGlobalHandlers();
          // Subscribe to tool:end channel for automatic breadcrumbs
          const { channels: obsChannels } = await import('./observability.js');
          const { addToolBreadcrumb } = await import('./sentry.js');
          obsChannels.toolEnd.subscribe((msg: unknown) => {
            const data = msg as { name?: string; success?: boolean; duration?: number } | undefined;
            if (data?.name) {
              addToolBreadcrumb(String(data.name), Boolean(data.success), typeof data.duration === 'number' ? data.duration : 0);
            }
          });
        }
      } catch {
        // Sentry init failed — non-critical, continue without it
      }
    }

    // Initialize run history (optional — fails gracefully)
    try {
      this.runHistory = new RunHistory();
      this._toolContext.runHistory = this.runHistory;
    } catch {
      this.runHistory = null;
    }

    // Initialize security audit trail (subscribes to guard/security channels)
    if (this.runHistory) {
      try {
        const { SecurityAudit } = await import('./security-audit.js');
        this.securityAudit = new SecurityAudit();
      } catch {
        this.securityAudit = null;
      }
    }

    // Configure persistent budget caps and HTTP rate limits
    // History subscriptions (toolEnd → recordToolCall) are set up per-Session in the constructor.
    if (this.runHistory) {
      configureBudgetAndRateLimits(this.runHistory, this.userConfig);
    }

    // Resolve context (CLI: project detection, others: explicit)
    this.context = resolveContext(this.config);

    // Non-CLI sources always get isolated workspace
    if (this.context && this.context.source !== 'cli') {
      const wsDir = ensureContextWorkspace(this.context);
      setTenantWorkspace(wsDir);
    }

    // Generate session briefing
    if (this.context) {
      const briefingResult = await generateInitBriefing(this.context, this.runHistory, this.activeScopes);
      this.briefing = briefingResult.briefing;
      this.currentManifest = briefingResult.manifest;
    }

    // Initialize secrets
    const secretResult = initSecrets(this.userConfig);
    this.secretVault = secretResult.vault;
    this.secretStore = secretResult.store;
    for (const part of secretResult.briefingParts) {
      this.briefing = this.briefing ? `${this.briefing}\n\n${part}` : part;
    }

    // Resolve user ID and active scopes
    const scopeResult = initScopes(this.userConfig, this.context, this.runHistory, this.memory);
    this.userId = scopeResult.userId;
    this.activeScopes = scopeResult.scopes;
    if (scopeResult.briefingPart) {
      this.briefing = this.briefing ? `${this.briefing}\n\n${scopeResult.briefingPart}` : scopeResult.briefingPart;
    }

    // Initialize memory
    this.memory = await initMemoryInstance(
      this.config, this.userConfig, this.activeScopes,
      this.context?.id, this.secretStore,
    );

    // Initialize embedding provider + knowledge graph
    this.embeddingProvider = initEmbeddingProvider(this.userConfig, this.runHistory);
    this.knowledgeLayer = await initKnowledgeLayer(this.userConfig, this.embeddingProvider, this.client);
    this._toolContext.knowledgeLayer = this.knowledgeLayer;

    // Initialize DataStore ↔ Knowledge Graph Bridge
    if (this.knowledgeLayer && this._dataStore) {
      this.dataStoreBridge = initDataStoreBridge(this.knowledgeLayer, this._dataStore);
    }

    // Subscribe to memory:store for automatic knowledge graph storage
    // Note: sourceRunId is null here because memory store events don't carry session context.
    // A future improvement could include runId in the channel payload.
    setupMemoryStoreSubscription(
      this.knowledgeLayer, this.embeddingProvider, this.runHistory,
      this.context?.id ?? '', () => null,
    );

    // Load API profiles (teaches agent how to use external APIs)
    try {
      const { ApiStore } = await import('./api-store.js');
      this._apiStore = new ApiStore();
      const apisDir = join(getLynoxDir(), 'apis');
      const loaded = this._apiStore.loadFromDirectory(apisDir);
      if (loaded > 0) {
        // Inject API knowledge into briefing
        const apiContext = this._apiStore.formatForSystemPrompt();
        this.briefing = this.briefing ? `${this.briefing}\n\n${apiContext}` : apiContext;
        // Wire per-API rate limiter into tool context
        this._toolContext.apiStore = this._apiStore;
      }
    } catch {
      this._apiStore = null;
    }

    // Register builtin tools
    this.registry
      .register(bashTool)
      .register(readFileTool)
      .register(writeFileTool)
      .register(memoryStoreTool)
      .register(memoryRecallTool)
      .register(memoryDeleteTool)
      .register(memoryUpdateTool)
      .register(memoryListTool)
      .register(memoryPromoteTool)
      .register(spawnAgentTool)
      .register(askUserTool)
      .register(batchFilesTool)
      .register(httpRequestTool)
      .register(apiSetupTool)
      .register(taskCreateTool)
      .register(taskUpdateTool)
      .register(taskListTool)
      .register(planTaskTool);

    // Wire task manager if run history is available
    if (this.runHistory) {
      const { TaskManager } = await import('./task-manager.js');
      this._taskManager = new TaskManager(this.runHistory);
      this._toolContext.taskManager = this._taskManager;
    }

    // Initialize DataStore (best-effort — never fail init)
    try {
      this._dataStore = new DataStore();
      this._toolContext.dataStore = this._dataStore;
      const collections = this._dataStore.listCollections();
      if (collections.length > 0) {
        this.registerDataStoreTools();
        const lines = collections.map(c =>
          `${c.name} (${c.scopeType}${c.scopeId ? ':' + c.scopeId : ''}) — ${c.recordCount} records, updated ${c.updatedAt.slice(0, 10)}`
        );
        const dataBlock = `<data_collections>\n${lines.join('\n')}\n</data_collections>`;
        this.briefing = this.briefing ? `${this.briefing}\n\n${dataBlock}` : dataBlock;
      }
    } catch {
      this._dataStore = null;
    }

    // Web search tool (conditional — requires API key)
    const searchKey = process.env['TAVILY_API_KEY']
      ?? process.env['BRAVE_API_KEY']
      ?? this.userConfig.search_api_key
      ?? this.secretStore?.resolve('TAVILY_API_KEY')
      ?? this.secretStore?.resolve('SEARCH_API_KEY');
    if (searchKey) {
      try {
        const { createSearchProvider, detectProviderType, createWebSearchTool } = await import('../integrations/search/index.js');
        const providerType = detectProviderType(searchKey, this.userConfig.search_provider);
        const searchProvider = createSearchProvider(providerType, searchKey);
        this.registry.register(createWebSearchTool(searchProvider));
      } catch {
        // Web search init failed — non-critical, continue without it
      }
    }

    // Google Workspace tools (conditional — requires client ID + secret)
    const googleClientId = process.env['GOOGLE_CLIENT_ID']
      ?? this.userConfig.google_client_id
      ?? this.secretStore?.resolve('GOOGLE_CLIENT_ID');
    const googleClientSecret = process.env['GOOGLE_CLIENT_SECRET']
      ?? this.userConfig.google_client_secret
      ?? this.secretStore?.resolve('GOOGLE_CLIENT_SECRET');
    if (googleClientId && googleClientSecret) {
      try {
        const { createGoogleTools } = await import('../integrations/google/index.js');
        const { tools: googleTools, auth: googleAuth } = createGoogleTools({
          clientId: googleClientId,
          clientSecret: googleClientSecret,
          serviceAccountKeyPath: process.env['GOOGLE_SERVICE_ACCOUNT_KEY'],
          vault: this.secretVault ?? undefined,
          scopes: this.userConfig.google_oauth_scopes,
        });
        for (const tool of googleTools) {
          this.registry.register(tool);
        }
        this._googleAuth = googleAuth;
      } catch {
        // Google Workspace init failed — non-critical, continue without it
      }
    }

    // Pipeline tools registered conditionally
    this._pipelinesEnabled = false;

    if (this.config.mcpServers) {
      for (const server of this.config.mcpServers) {
        this.registry.registerMCP(server);
      }
    }

    // Load persistent MCP servers from user config
    if (this.userConfig.mcp_servers) {
      for (const server of this.userConfig.mcp_servers) {
        if (server.name && server.url) {
          this.registry.registerMCP({ type: 'url', name: server.name, url: server.url });
        }
      }
    }

    // Load plugins (best-effort — never fail init, gated behind feature flag)
    if (isFeatureEnabled('plugins')) {
      try {
        this.pluginManager = new PluginManager(this.userConfig);
        await this.pluginManager.loadPlugins();
        for (const tool of this.pluginManager.getTools()) {
          this.registry.register(tool);
        }
      } catch {
        this.pluginManager = null;
      }
    }

    // Register pipeline tools and inject config
    this.registerPipelineTools();

    // Initialize CRM (auto-creates contacts/deals/interactions tables)
    if (this._dataStore) {
      try {
        const { CRM } = await import('./crm.js');
        this._crm = new CRM(this._dataStore);
        this._crm.ensureSchema();
      } catch {
        this._crm = null;
      }
    }

    // Initialize backup manager (always available — backup is essential)
    try {
      const { BackupManager } = await import('./backup.js');
      const backupDir = this.userConfig.backup_dir ?? join(getLynoxDir(), 'backups');
      this._backupManager = new BackupManager(getLynoxDir(), {
        backupDir,
        retentionDays: this.userConfig.backup_retention_days ?? 30,
        encrypt: this.userConfig.backup_encrypt ?? (!!process.env['LYNOX_VAULT_KEY']),
      }, process.env['LYNOX_VAULT_KEY'] ?? null);
    } catch {
      this._backupManager = null;
    }

    // Auto-backup on version change (protects against update regressions)
    if (this._backupManager) {
      try {
        const { existsSync: exists, readFileSync: readF, writeFileSync: writeF } = await import('node:fs');
        const versionFile = join(getLynoxDir(), '.last_version');
        let currentVersion = 'unknown';
        try {
          const { fileURLToPath } = await import('node:url');
          const { dirname } = await import('node:path');
          const thisDir = dirname(fileURLToPath(import.meta.url));
          const pkgPath = join(thisDir, '..', '..', 'package.json');
          if (exists(pkgPath)) {
            const pkg = JSON.parse(readF(pkgPath, 'utf-8')) as { version?: string };
            currentVersion = pkg.version ?? 'unknown';
          }
        } catch { /* best effort */ }

        const lastVersion = exists(versionFile) ? readF(versionFile, 'utf-8').trim() : null;

        if (lastVersion && lastVersion !== currentVersion && currentVersion !== 'unknown') {
          process.stderr.write(`[lynox] Version changed (${lastVersion} → ${currentVersion}) — creating pre-update backup...\n`);
          const result = await this._backupManager.createBackup();
          if (result.success) {
            process.stderr.write(`[lynox] Pre-update backup created: ${result.path}\n`);
          } else {
            process.stderr.write(`[lynox] Pre-update backup failed: ${result.error ?? 'unknown'}\n`);
          }
        }

        // Always write current version
        if (currentVersion !== 'unknown') {
          writeF(versionFile, currentVersion, { mode: 0o600 });
        }
      } catch {
        // Version check failed — non-critical
      }
    }

    // Wire Google Drive backup upload if Google auth is available
    if (this._backupManager && this._googleAuth) {
      try {
        const { GDriveBackupUploader } = await import('./backup-upload-gdrive.js');
        this._backupManager.setGDriveUploader(new GDriveBackupUploader(this._googleAuth));
      } catch {
        // Non-critical — GDrive backup upload not available
      }
    }

    // Fire plugin session start hooks
    if (this.pluginManager) {
      void this.pluginManager.fireSessionStart();
    }

    // Fire orchestrator lifecycle hooks (for Pro extensions)
    for (const hook of this._hooks) {
      if (hook.onInit) {
        await hook.onInit(this).catch(() => { /* best-effort */ });
      }
    }

    return this;
  }

  /** Create a new per-conversation session. */
  createSession(opts?: SessionOptions): Session {
    return new Session(this, opts);
  }

  /** Register pipeline tools on demand (saves ~350 tokens when not used) */
  registerPipelineTools(): void {
    if (this._pipelinesEnabled) return;
    this._pipelinesEnabled = true;
    this.registry
      .register(runPipelineTool)
      .register(captureProcessTool)
      .register(promoteProcessTool);
    // Update tool context with pipeline dependencies
    this._toolContext.tools = this.registry.getEntries();
    this._toolContext.runHistory = this.runHistory ?? null;
  }

  /** Register data store tools on demand */
  registerDataStoreTools(): void {
    if (this._dataStoreEnabled || !this._dataStore) return;
    this._dataStoreEnabled = true;
    this.registry
      .register(dataStoreCreateTool)
      .register(dataStoreInsertTool)
      .register(dataStoreQueryTool)
      .register(dataStoreListTool)
      .register(dataStoreDeleteTool);
  }

  addTool<T>(entry: ToolEntry<T>): void {
    this.registry.register(entry);
  }

  /** Register a tool without recreating agents */
  registerTool<T>(entry: ToolEntry<T>): void {
    this.registry.register(entry);
  }

  addMCP(server: MCPServer): void {
    this.registry.registerMCP(server);
  }

  // ── Getters ──

  getRegistry(): ToolRegistry { return this.registry; }
  getMemory(): Memory | null { return this.memory; }
  getRunHistory(): RunHistory | null { return this.runHistory; }
  getContext(): LynoxContext | null { return this.context; }
  getBriefing(): string | undefined { return this.briefing; }
  getActiveScopes(): MemoryScopeRef[] { return this.activeScopes; }
  getUserId(): string | null { return this.userId; }
  getEmbeddingProvider(): EmbeddingProvider | null { return this.embeddingProvider; }
  getKnowledgeLayer(): KnowledgeLayer | null { return this.knowledgeLayer; }
  getToolContext(): ToolContext { return this._toolContext; }
  getSecretStore(): SecretStore | null { return this.secretStore; }
  getGoogleAuth(): import('../integrations/google/google-auth.js').GoogleAuth | null { return this._googleAuth; }

  /** Re-initialize Google Workspace integration after credentials change. */
  async reloadGoogle(): Promise<boolean> {
    const clientId = this.secretStore?.resolve('GOOGLE_CLIENT_ID')
      ?? process.env['GOOGLE_CLIENT_ID']
      ?? this.userConfig.google_client_id;
    const clientSecret = this.secretStore?.resolve('GOOGLE_CLIENT_SECRET')
      ?? process.env['GOOGLE_CLIENT_SECRET']
      ?? this.userConfig.google_client_secret;
    if (!clientId || !clientSecret) return false;
    try {
      const { createGoogleTools } = await import('../integrations/google/index.js');
      const { tools: googleTools, auth: googleAuth } = createGoogleTools({
        clientId,
        clientSecret,
        serviceAccountKeyPath: process.env['GOOGLE_SERVICE_ACCOUNT_KEY'],
        vault: this.secretVault ?? undefined,
        scopes: this.userConfig.google_oauth_scopes,
      });
      for (const tool of googleTools) {
        this.registry.register(tool);
      }
      this._googleAuth = googleAuth;
      return true;
    } catch {
      return false;
    }
  }
  getTaskManager(): import('./task-manager.js').TaskManager | null { return this._taskManager; }
  getDataStore(): DataStore | null { return this._dataStore; }
  getPluginManager(): PluginManager | null { return this.pluginManager; }
  getApiConfig(): { apiKey?: string | undefined; apiBaseURL?: string | undefined } {
    return { apiKey: this.userConfig.api_key, apiBaseURL: this.userConfig.api_base_url };
  }
  getBatchIndex(): BatchIndex { return this.batchIndex; }
  getLastBatchParentId(): string | null { return this._lastBatchParentId; }
  getHooks(): LynoxHooks[] { return this._hooks; }
  getPipelinesEnabled(): boolean { return this._pipelinesEnabled; }
  getDataStoreEnabled(): boolean { return this._dataStoreEnabled; }
  getNotificationRouter(): NotificationRouter { return this._notificationRouter; }
  getWorkerLoop(): WorkerLoop | null { return this._workerLoop; }
  getBackupManager(): import('./backup.js').BackupManager | null { return this._backupManager; }
  getApiStore(): import('./api-store.js').ApiStore | null { return this._apiStore; }
  getCRM(): import('./crm.js').CRM | null { return this._crm; }

  /** Start the background worker loop. Call from long-lived server modes (Telegram, MCP). */
  startWorkerLoop(intervalMs?: number | undefined): void {
    if (this._workerLoop) return; // already started
    this._workerLoop = new WorkerLoop(this, this._notificationRouter, intervalMs);
    this._workerLoop.start();
  }

  // ── Batch ──

  async batch(reqs: BatchRequest[], sessionConfig?: { systemPromptSuffix?: string | undefined }): Promise<string> {
    const result = await submitBatch(
      this.client, reqs,
      {
        modelTier: this.config.model ?? 'opus',
        maxTokens: this.config.maxTokens ?? 8192,
        systemPrompt: this.config.systemPrompt,
        systemPromptSuffix: sessionConfig?.systemPromptSuffix,
      },
      this.runHistory, this.batchIndex, this.context?.id ?? '',
    );
    if (result.parentRunId) {
      this._lastBatchParentId = result.parentRunId;
    }
    return result.batchId;
  }

  async awaitBatch(batchId: string): Promise<BatchResult[]> {
    return pollBatch(this.client, batchId);
  }

  async batchAndAwait(reqs: BatchRequest[], sessionConfig?: { systemPromptSuffix?: string | undefined }): Promise<BatchResult[]> {
    const id = await this.batch(reqs, sessionConfig);
    return this.awaitBatch(id);
  }

  // ── Hooks ──

  registerHooks(hooks: LynoxHooks): void {
    this._hooks.push(hooks);
  }

  // ── GC ──

  /** Called by Session after each run. Triggers auto-GC when threshold reached. */
  incrementRunCount(): void {
    this.runCount++;
    if (this.runCount % AUTO_GC_INTERVAL === 0) {
      if (this.knowledgeLayer) {
        void runGraphGc(this.knowledgeLayer).catch(() => {});
      }
      if (this.memory && this.embeddingProvider && this.runHistory) {
        void runMemoryGc(this.memory, this.activeScopes, this.embeddingProvider, this.runHistory).catch(() => {});
      }
    }
  }

  // ── Shutdown ──

  async shutdown(): Promise<void> {
    // Stop worker loop first — prevents new task executions during shutdown
    if (this._workerLoop) {
      this._workerLoop.stop();
      this._workerLoop = null;
    }

    // Save file manifest for next session's diff
    if (this.context && this.currentManifest) {
      try {
        saveManifest(getLynoxDir(), this.context.id, this.currentManifest);
      } catch {
        // Best-effort — never fail shutdown
      }
    }

    // Fire orchestrator shutdown hooks (for Pro extensions — includes worker pool shutdown)
    for (const hook of this._hooks) {
      if (hook.onShutdown) {
        await hook.onShutdown().catch(() => { /* best-effort */ });
      }
    }
    if (this.runHistory) {
      try { this.runHistory.close(); } catch { /* ignore */ }
    }
    if (this.secretVault) {
      try { this.secretVault.close(); } catch { /* ignore */ }
    }
    if (this._dataStore) {
      try { this._dataStore.close(); } catch { /* ignore */ }
    }
    if (this.knowledgeLayer) {
      try { await this.knowledgeLayer.close(); } catch { /* ignore */ }
      this.knowledgeLayer = null;
    }
    // Flush Sentry events before shutdown
    try {
      const { shutdownSentry } = await import('./sentry.js');
      await shutdownSentry();
    } catch {
      // best-effort
    }
    await shutdownDebugSubscriber();
  }
}
