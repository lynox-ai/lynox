import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { getErrorMessage } from './utils.js';
import type {
  NodynConfig,
  NodynUserConfig,
  ToolEntry,
  MCPServer,
  BatchRequest,
  BatchResult,
  StreamHandler,
  StreamEvent,
  ModelTier,
  EffortLevel,
  ThinkingMode,
  TabQuestion,
  ModeConfig,
  OperationalMode,
  CostSnapshot,
  GoalState,
  IAgent,
  ContextSource,
} from '../types/index.js';
import { MODEL_MAP } from '../types/index.js';
import { ModeController } from './mode-controller.js';
import type { ModeOrchestrator } from './mode-controller.js';
import { Agent } from './agent.js';
import type { Memory } from './memory.js';
import { BatchIndex } from './batch-index.js';
import { ToolRegistry } from '../tools/registry.js';
import { loadConfig, getNodynDir } from './config.js';
import { RunHistory } from './run-history.js';
import { hashPrompt } from './prompt-hash.js';
import { calculateCost } from './pricing.js';
import { channels } from './observability.js';
import { initDebugSubscriber, shutdownDebugSubscriber } from './debug-subscriber.js';
import { abortSpawnedAgents } from '../tools/builtin/spawn.js';
import { abortPipelineAgents } from '../orchestrator/runtime-adapter.js';
import { saveManifest } from './project.js';
import { resolveContext } from './context.js';
import type { NodynContext } from '../types/index.js';
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
  listPlaybooksTool,
  suggestPlaybookTool,
  extractPlaybookTool,
} from '../tools/builtin/index.js';
import type { ToolContext } from './tool-context.js';
import { createToolContext } from './tool-context.js';
import { listPlaybooks, formatPlaybookIndex } from './playbooks.js';
import {
  SYSTEM_PROMPT,
  PIPELINE_PROMPT_SUFFIX,
  DATASTORE_PROMPT_SUFFIX,
  PLAYBOOK_PROMPT_SUFFIX,
} from './orchestrator-prompts.js';
import {
  configureBudgetAndRateLimits,
  setupHistorySubscriptions,
  generateInitBriefing,
  initSecrets,
  initScopes,
  initMemoryInstance,
  initEmbeddingProvider,
  initKnowledgeLayer,
  initDataStoreBridge,
  setupMemoryStoreSubscription,
} from './orchestrator-init.js';
import { submitBatch, pollBatch } from './orchestrator-batch.js';
import { DataStore } from './data-store.js';
import { ChangesetManager } from './changeset.js';
import { PluginManager } from './plugins.js';
import { checkPersistentBudget } from './session-budget.js';
import { isFeatureEnabled } from './features.js';
import type { MemoryScopeRef } from '../types/index.js';
import { runMemoryGc, runGraphGc } from './memory-gc.js';


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
  /** Active tenant ID, set via Nodyn.tenantId (Pro). */
  tenantId?: string | undefined;
}

/**
 * Lifecycle hooks for extending the orchestrator.
 * Pro packages register hooks to add tenant tracking, tool filtering, etc.
 */
export interface NodynHooks {
  onInit?(nodyn: Nodyn): Promise<void>;
  onBeforeRun?(runId: string, context: RunContext): void | Promise<void>;
  onBeforeCreateAgent?(tools: ToolEntry[]): ToolEntry[];
  onAfterRun?(runId: string, costUsd: number, context: RunContext): void;
  onShutdown?(): Promise<void>;
}

const AUTO_GC_INTERVAL = 50; // Run GC every N runs


interface AccumulatedUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export class Nodyn {
  private readonly config: NodynConfig;
  private userConfig: NodynUserConfig;
  private readonly registry = new ToolRegistry();
  private client: Anthropic;
  private readonly batchIndex = new BatchIndex();
  private memory: Memory | null = null;
  private agent: Agent | null = null;
  private runHistory: RunHistory | null = null;
  private securityAudit: import('./security-audit.js').SecurityAudit | null = null;
  private context: NodynContext | null = null;
  private briefing: string | undefined = undefined;
  private currentManifest: Map<string, number> | null = null;
  private currentRunId: string | null = null;
  private runToolCallSeq = 0;
  private runCount = 0;
  private readonly sessionId: string;
  private modeController: ModeController | null = null;
  private pluginManager: PluginManager | null = null;
  private agentOverrides: {
    maxIterations?: number | undefined;
    continuationPrompt?: string | undefined;
    excludeTools?: string[] | undefined;
    systemPromptSuffix?: string | undefined;
    autonomy?: import('../types/index.js').AutonomyLevel | undefined;
    preApproval?: import('../types/index.js').PreApprovalSet | undefined;
    audit?: import('../types/index.js').PreApproveAuditLike | undefined;
  } = {};

  private embeddingProvider: EmbeddingProvider | null = null;
  private knowledgeLayer: KnowledgeLayer | null = null;
  private dataStoreBridge: DataStoreBridge | null = null;
  private secretVault: SecretVault | null = null;
  private secretStore: SecretStore | null = null;
  private userId: string | null = null;
  private activeScopes: MemoryScopeRef[] = [];
  private _pipelinesEnabled = false;
  private _dataStoreEnabled = false;
  private _playbooksEnabled = false;
  private _briefingConsumed = false;
  private _dataStore: DataStore | null = null;
  private _changesetManager: ChangesetManager | null = null;
  private _taskManager: import('./task-manager.js').TaskManager | null = null;
  private _hooks: NodynHooks[] = [];
  private _toolContext: ToolContext;
  private _tenantId: string | null = null;
  private _googleAuth: import('../integrations/google/google-auth.js').GoogleAuth | null = null;
  onStream: StreamHandler | null = null;
  private _promptUser: ((question: string, options?: string[]) => Promise<string>) | null = null;
  private _promptTabs: ((questions: TabQuestion[]) => Promise<string[]>) | null = null;

  get promptUser(): ((question: string, options?: string[]) => Promise<string>) | null {
    return this._promptUser;
  }

  set promptUser(fn: ((question: string, options?: string[]) => Promise<string>) | null) {
    this._promptUser = fn;
    if (this.agent) {
      this.agent.promptUser = fn
        ? (q: string, opts?: string[]) => fn(q, opts)
        : undefined;
    }
  }

  get promptTabs(): ((questions: TabQuestion[]) => Promise<string[]>) | null {
    return this._promptTabs;
  }

  set promptTabs(fn: ((questions: TabQuestion[]) => Promise<string[]>) | null) {
    this._promptTabs = fn;
    if (this.agent) {
      this.agent.promptTabs = fn
        ? (qs: TabQuestion[]) => fn(qs)
        : undefined;
    }
  }
  /** Active tenant ID for multi-tenant billing. Set by Pro `/tenant use`. */
  get tenantId(): string | null {
    return this._tenantId;
  }

  set tenantId(id: string | null) {
    this._tenantId = id;
  }

  readonly usage: AccumulatedUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  constructor(config: NodynConfig) {
    this.sessionId = randomUUID();
    this.userConfig = loadConfig();
    // Apply user config defaults if not already set in NodynConfig
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

  getUserConfig(): NodynUserConfig {
    return this.userConfig;
  }

  /** Reload config from disk, update cached reference, and recreate API client if key changed. */
  reloadUserConfig(): void {
    const oldKey = this.userConfig.api_key;
    const oldBase = this.userConfig.api_base_url;
    this.userConfig = loadConfig();
    // Recreate API client if credentials changed
    if (this.userConfig.api_key !== oldKey || this.userConfig.api_base_url !== oldBase) {
      this.client = this.userConfig.api_key
        ? new Anthropic({ apiKey: this.userConfig.api_key, baseURL: this.userConfig.api_base_url })
        : this.userConfig.api_base_url
          ? new Anthropic({ baseURL: this.userConfig.api_base_url })
          : new Anthropic();
    }
  }

  async init(): Promise<this> {
    // Activate debug logging early (before any channel publishing)
    initDebugSubscriber();

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

    // Configure persistent budget caps, HTTP rate limits, and history subscriptions
    if (this.runHistory) {
      configureBudgetAndRateLimits(this.runHistory, this.userConfig);
      setupHistorySubscriptions(
        this.runHistory,
        () => this.currentRunId,
        () => this.runToolCallSeq++,
      );
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
    setupMemoryStoreSubscription(
      this.knowledgeLayer, this.embeddingProvider, this.runHistory,
      this.context?.id ?? '', () => this.currentRunId,
    );

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
      ?? this.userConfig.search_api_key;
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
    const googleClientId = process.env['GOOGLE_CLIENT_ID'] ?? this.userConfig.google_client_id;
    const googleClientSecret = process.env['GOOGLE_CLIENT_SECRET'] ?? this.userConfig.google_client_secret;
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

    // Pipeline and playbook tools registered conditionally
    this._pipelinesEnabled = false;
    this._playbooksEnabled = false;

    if (this.config.mcpServers) {
      for (const server of this.config.mcpServers) {
        this.registry.registerMCP(server);
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

    // Register playbook tools
    this.registerPlaybookTools();

    this._createAgent();

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

  async run(task: string): Promise<string> {
    if (!this.agent) throw new Error('Nodyn not initialized — call init() first');

    // Create changeset manager if enabled (backup-before-write mode).
    // Autonomous modes: always ON (mandatory rollback safety for business use).
    // Interactive/guided: ON by default, explicit opt-out with changeset_review: false.
    const isAutonomous = this.agentOverrides.autonomy === 'autonomous';
    const changesetEnabled = isAutonomous || (this.userConfig.changeset_review !== false);
    if (changesetEnabled) {
      const runId = randomUUID();
      this._changesetManager = new ChangesetManager(process.cwd(), runId);
      // Re-create agent with changeset manager, preserving conversation history
      this._recreateAgent();
    } else {
      this._changesetManager = null;
    }

    // Check persistent daily/monthly budget before running
    const budgetCheck = checkPersistentBudget();
    if (!budgetCheck.allowed) {
      return budgetCheck.reason ?? 'Budget exceeded.';
    }

    // Fire onBeforeRun hooks (e.g. tenant budget enforcement in Pro)
    const preRunContext: RunContext = {
      runId: randomUUID(),
      contextId: this.context?.id ?? '',
      modelTier: this.config.model ?? 'opus',
      durationMs: 0,
      source: this.context?.source ?? 'cli',
      tenantId: this._tenantId ?? undefined,
    };
    for (const hook of this._hooks) {
      if (hook.onBeforeRun) {
        try {
          await hook.onBeforeRun(preRunContext.runId, preRunContext);
        } catch (err: unknown) {
          return `Run blocked: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }

    // Content policy: check user input for malware/exploit/phishing intent BEFORE sending to LLM
    const { checkInput } = await import('./input-guard.js');
    const inputCheck = checkInput(task, this.agentOverrides.autonomy);
    if (inputCheck.action === 'block') {
      return `⚠ Request blocked by content policy: ${inputCheck.reason ?? 'prohibited content'}. This request was not sent to the AI model.`;
    }
    if (inputCheck.action === 'flag' && this.agent.promptUser) {
      const answer = await this.agent.promptUser(
        `⚠ Content policy flag: ${inputCheck.reason ?? 'suspicious content'} — Allow this request?`,
        ['Allow', 'Deny', '\x00'],
      );
      if (!['y', 'yes', 'allow'].includes(answer.toLowerCase())) {
        return `Request denied by user after content policy flag: ${inputCheck.reason ?? 'suspicious content'}.`;
      }
    }

    const model = MODEL_MAP[this.config.model ?? 'opus'];
    const startTime = Date.now();
    this.runToolCallSeq = 0;

    // Compute prompt hash from the system prompt the agent uses
    const basePrompt = this.config.systemPrompt ?? SYSTEM_PROMPT;
    const effectivePrompt = this.agentOverrides.systemPromptSuffix
      ? basePrompt + this.agentOverrides.systemPromptSuffix
      : basePrompt;
    const promptHash = hashPrompt(effectivePrompt);

    // Record run start
    if (this.runHistory) {
      try {
        this.currentRunId = this.runHistory.insertRun({
          sessionId: this.sessionId,
          taskText: task,
          modelTier: this.config.model ?? 'opus',
          modelId: model,
          promptHash,
          contextId: this.context?.id ?? '',
          ...(this._tenantId ? { tenantId: this._tenantId } : {}),
        });
        // Snapshot prompt if this hash is new
        this.runHistory.insertPromptSnapshot(promptHash, 'default', effectivePrompt);
      } catch {
        this.currentRunId = null;
      }
    }

    // Thread run ID to agent so spawn tool can read it
    this.agent.currentRunId = this.currentRunId ?? undefined;

    const usageBefore = { ...this.usage };

    // Knowledge Graph retrieval (mandatory)
    if (this.knowledgeLayer) {
      try {
        const result = await this.knowledgeLayer.retrieve(task, this.activeScopes, {
          topK: 8,
          threshold: 0.55,
          useHyDE: true,
          useGraphExpansion: true,
        });
        this.agent.setKnowledgeContext(this.knowledgeLayer.formatRetrievalContext(result));
      } catch {
        this.agent.setKnowledgeContext('');
      }
    }

    try {
      const result = await this.agent.send(task);

      // Clear briefing after first turn — it's one-time context (run history, file diffs, advisor)
      if (!this._briefingConsumed && this.briefing) {
        this._briefingConsumed = true;
        this.agent.setBriefing(undefined);
      }

      const durationMs = Date.now() - startTime;
      const tokensIn = this.usage.input_tokens - usageBefore.input_tokens;
      const tokensOut = this.usage.output_tokens - usageBefore.output_tokens;
      const cacheRead = this.usage.cache_read_input_tokens - usageBefore.cache_read_input_tokens;
      const cacheWrite = this.usage.cache_creation_input_tokens - usageBefore.cache_creation_input_tokens;
      const costUsd = calculateCost(model, {
        input_tokens: tokensIn,
        output_tokens: tokensOut,
        cache_creation_input_tokens: cacheWrite,
        cache_read_input_tokens: cacheRead,
      });

      if (this.runHistory && this.currentRunId) {
        try {
          this.runHistory.updateRun(this.currentRunId, {
            responseText: result,
            tokensIn,
            tokensOut,
            tokensCacheRead: cacheRead,
            tokensCacheWrite: cacheWrite,
            costUsd,
            toolCallCount: this.runToolCallSeq,
            durationMs,
            stopReason: 'end_turn',
            status: 'completed',
          });
        } catch {
          // Fire-and-forget
        }
      }

      // Fire orchestrator lifecycle hooks (for Pro extensions — includes tenant cost tracking)
      const runContext: RunContext = {
        runId: this.currentRunId!,
        contextId: this.context?.id ?? '',
        modelTier: this.config.model ?? 'opus',
        durationMs,
        source: this.context?.source ?? 'cli',
        ...(this._tenantId ? { tenantId: this._tenantId } : {}),
      };
      for (const hook of this._hooks) {
        if (hook.onAfterRun) {
          try {
            hook.onAfterRun(this.currentRunId!, costUsd, runContext);
          } catch (hookErr: unknown) {
            if (channels.costWarning.hasSubscribers) {
              channels.costWarning.publish({
                type: 'hook_error',
                hookError: hookErr instanceof Error ? hookErr.message : String(hookErr),
                runId: this.currentRunId,
                costUsd,
              });
            }
          }
        }
      }

      // Fire plugin onRunComplete hooks (fire-and-forget)
      if (this.pluginManager) {
        void this.pluginManager.fireRunComplete(result);
      }

      // Auto-GC: run memory garbage collection every N runs
      this.runCount++;
      if (this.runCount % AUTO_GC_INTERVAL === 0) {
        // Knowledge Graph GC (primary path)
        if (this.knowledgeLayer) {
          void runGraphGc(this.knowledgeLayer).catch(() => {});
        }
        // Legacy flat-file + SQLite GC (fallback or dual-mode)
        if (this.memory && this.embeddingProvider && this.runHistory) {
          void runMemoryGc(this.memory, this.activeScopes, this.embeddingProvider, this.runHistory).catch(() => {});
        }
      }

      return result;
    } catch (err: unknown) {
      if (this.runHistory && this.currentRunId) {
        try {
          this.runHistory.updateRun(this.currentRunId, {
            responseText: getErrorMessage(err),
            durationMs: Date.now() - startTime,
            status: 'failed',
          });
        } catch {
          // Fire-and-forget
        }
      }
      throw err;
    } finally {
      this.currentRunId = null;
      if (this.agent) {
        this.agent.currentRunId = undefined;
      }
    }
  }

  abort(): void {
    this.agent?.abort();
    abortSpawnedAgents();
    abortPipelineAgents();
  }

  reset(): void {
    if (this.agent) {
      this.agent.reset();
    }
  }

  addTool<T>(entry: ToolEntry<T>): void {
    this.registry.register(entry);
    this._createAgent();
  }

  /** Register a tool without recreating the agent (used by ModeController) */
  registerTool<T>(entry: ToolEntry<T>): void {
    this.registry.register(entry);
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
    this._toolContext.streamHandler = this.onStream ?? null;
    this._toolContext.runHistory = this.runHistory ?? null;
    this._createAgent();
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
    this._createAgent();
  }

  /** Register playbook tools */
  registerPlaybookTools(): void {
    if (this._playbooksEnabled) return;
    this._playbooksEnabled = true;
    this.registry
      .register(listPlaybooksTool)
      .register(suggestPlaybookTool)
      .register(extractPlaybookTool);
    // runHistory + userConfig already on _toolContext
    this._createAgent();
  }

  addMCP(server: MCPServer): void {
    this.registry.registerMCP(server);
    this._createAgent();
  }

  getRegistry(): ToolRegistry {
    return this.registry;
  }

  /** Get the active changeset manager (if any). Used by REPL for post-run review. */
  getChangesetManager(): ChangesetManager | null {
    return this._changesetManager;
  }

  getPluginManager(): PluginManager | null {
    return this.pluginManager;
  }

  getMemory(): Memory | null {
    return this.memory;
  }

  getAgent(): Agent | null {
    return this.agent;
  }

  getApiConfig(): { apiKey?: string | undefined; apiBaseURL?: string | undefined } {
    return { apiKey: this.userConfig.api_key, apiBaseURL: this.userConfig.api_base_url };
  }

  getPromptTabs(): ((questions: TabQuestion[]) => Promise<string[]>) | null {
    return this._promptTabs;
  }

  saveMessages(): BetaMessageParam[] {
    return this.agent?.getMessages() ?? [];
  }

  loadMessages(messages: BetaMessageParam[]): void {
    if (this.agent) {
      this.agent.loadMessages(messages);
    }
  }

  async setMode(config: ModeConfig): Promise<void> {
    // Teardown previous mode
    if (this.modeController) {
      await this.modeController.teardown();
      this.modeController = null;
      this.agentOverrides = {};
    }

    if (config.mode === 'interactive') {
      // Reset to default interactive mode
      this._createAgent();
      return;
    }

    this.modeController = new ModeController(config);
    await this.modeController.apply(this as ModeOrchestrator);
  }

  getMode(): OperationalMode {
    return this.modeController?.getMode() ?? 'interactive';
  }

  getCostSnapshot(): CostSnapshot | null {
    return this.modeController?.getCostSnapshot() ?? null;
  }

  getGoalState(): GoalState | null {
    return this.modeController?.getGoalState() ?? null;
  }

  /** Called by ModeController to recreate agent with mode overrides */
  _recreateAgent(overrides?: {
    maxIterations?: number | undefined;
    continuationPrompt?: string | undefined;
    excludeTools?: string[] | undefined;
    systemPromptSuffix?: string | undefined;
    autonomy?: import('../types/index.js').AutonomyLevel | undefined;
    preApproval?: import('../types/index.js').PreApprovalSet | undefined;
    audit?: import('../types/index.js').PreApproveAuditLike | undefined;
  }): void {
    this.agentOverrides = overrides ?? {};
    const messages = this.saveMessages();
    this._createAgent();
    this.loadMessages(messages);
  }

  getRunHistory(): RunHistory | null {
    return this.runHistory;
  }

  /** Get the resolved NodynContext. */
  getContext(): NodynContext | null {
    return this.context;
  }

  getBriefing(): string | undefined {
    return this.briefing;
  }

  getActiveScopes(): MemoryScopeRef[] {
    return this.activeScopes;
  }

  getUserId(): string | null {
    return this.userId;
  }

  getEmbeddingProvider(): EmbeddingProvider | null {
    return this.embeddingProvider;
  }

  getKnowledgeLayer(): KnowledgeLayer | null {
    return this.knowledgeLayer;
  }

  /** Shared tool context — Pro can use this to update isolation/network policy. */
  getToolContext(): ToolContext {
    return this._toolContext;
  }

  getSecretStore(): SecretStore | null {
    return this.secretStore;
  }

  getGoogleAuth(): import('../integrations/google/google-auth.js').GoogleAuth | null {
    return this._googleAuth;
  }

  getTaskManager(): import('./task-manager.js').TaskManager | null {
    return this._taskManager;
  }

  getDataStore(): DataStore | null {
    return this._dataStore;
  }

  async shutdown(): Promise<void> {
    // Save file manifest for next session's diff
    if (this.context && this.currentManifest) {
      try {
        saveManifest(getNodynDir(), this.context.id, this.currentManifest);
      } catch {
        // Best-effort — never fail shutdown
      }
    }

    if (this.modeController) {
      await this.modeController.teardown();
      this.modeController = null;
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
    await shutdownDebugSubscriber();
  }

  async batch(reqs: BatchRequest[]): Promise<string> {
    const result = await submitBatch(
      this.client, reqs,
      {
        modelTier: this.config.model ?? 'opus',
        maxTokens: this.config.maxTokens ?? 8192,
        systemPrompt: this.config.systemPrompt,
        systemPromptSuffix: this.agentOverrides.systemPromptSuffix,
      },
      this.runHistory, this.batchIndex, this.context?.id ?? '',
    );
    if (result.parentRunId) {
      this._lastBatchParentId = result.parentRunId;
    }
    return result.batchId;
  }
  private _lastBatchParentId: string | null = null;

  getLastBatchParentId(): string | null {
    return this._lastBatchParentId;
  }

  async awaitBatch(batchId: string): Promise<BatchResult[]> {
    return pollBatch(this.client, batchId);
  }

  async batchAndAwait(reqs: BatchRequest[]): Promise<BatchResult[]> {
    const id = await this.batch(reqs);
    return this.awaitBatch(id);
  }

  getBatchIndex(): BatchIndex {
    return this.batchIndex;
  }

  setModel(tier: ModelTier): string {
    const messages = this.saveMessages();
    this.config.model = tier;
    this._createAgent();
    this.loadMessages(messages);
    return MODEL_MAP[tier];
  }

  getModelTier(): ModelTier {
    return this.config.model ?? 'opus';
  }

  setEffort(level: EffortLevel): void {
    const messages = this.saveMessages();
    this.config.effort = level;
    this._createAgent();
    this.loadMessages(messages);
  }

  getEffort(): EffortLevel {
    return this.config.effort ?? 'high';
  }

  setThinking(mode: ThinkingMode | undefined): void {
    const messages = this.saveMessages();
    this.config.thinking = mode;
    this._createAgent();
    this.loadMessages(messages);
  }

  getThinking(): ThinkingMode | undefined {
    return this.config.thinking;
  }

  setSkipMemoryExtraction(skip: boolean): void {
    if (this.agent) this.agent.skipMemoryExtraction = skip;
  }

  private _createAgent(): void {
    // Keep tool context in sync
    this._toolContext.tools = this.registry.getEntries();
    this._toolContext.streamHandler = this.onStream ?? null;

    const model = MODEL_MAP[this.config.model ?? 'opus'] ?? MODEL_MAP['sonnet'];
    const mcpServers = this.registry.getMCPServers();
    const entries = this.registry.getEntries();
    const tools = this.pluginManager
      ? entries.map(entry => ({
          definition: entry.definition,
          handler: async (input: unknown, agent: IAgent): Promise<string> => {
            const gate = await this.pluginManager!.fireToolGate(entry.definition.name, input);
            if (gate === false) {
              throw new Error(`Tool "${entry.definition.name}" blocked by plugin gate`);
            }
            return entry.handler(input, agent);
          },
        }))
      : entries;

    const streamHandler: StreamHandler = async (event: StreamEvent) => {
      if (event.type === 'turn_end') {
        this.usage.input_tokens += event.usage.input_tokens;
        this.usage.output_tokens += event.usage.output_tokens;
        this.usage.cache_creation_input_tokens += event.usage.cache_creation_input_tokens ?? 0;
        this.usage.cache_read_input_tokens += event.usage.cache_read_input_tokens ?? 0;
      }
      if (this.onStream) {
        await this.onStream(event);
      }
    };

    let basePrompt = this.config.systemPrompt ?? SYSTEM_PROMPT;
    // Append pipeline docs only when pipeline tools are registered
    if (this._pipelinesEnabled) {
      basePrompt += PIPELINE_PROMPT_SUFFIX;
    }
    // Append data store docs only when data store tools are registered
    if (this._dataStoreEnabled) {
      basePrompt += DATASTORE_PROMPT_SUFFIX;
    }
    // Append playbook docs with dynamic index
    if (this._playbooksEnabled) {
      const pbList = listPlaybooks();
      const pbIndex = formatPlaybookIndex(pbList);
      basePrompt += PLAYBOOK_PROMPT_SUFFIX.replace('{PLAYBOOK_INDEX}', pbIndex);
    }
    const systemPrompt = this.agentOverrides.systemPromptSuffix
      ? basePrompt + this.agentOverrides.systemPromptSuffix
      : basePrompt;

    // Apply hook-based tool filtering (for Pro extensions)
    let effectiveTools = tools;
    for (const hook of this._hooks) {
      if (hook.onBeforeCreateAgent) {
        effectiveTools = hook.onBeforeCreateAgent(effectiveTools);
      }
    }

    this.agent = new Agent({
      name: 'nodyn',
      model,
      systemPrompt,
      tools: effectiveTools,
      mcpServers: mcpServers.length > 0 ? mcpServers : undefined,
      thinking: this.config.thinking,
      effort: this.config.effort,
      maxTokens: this.config.maxTokens,
      memory: this.memory ?? undefined,
      onStream: streamHandler,
      promptUser: this._promptUser
        ? (q: string, opts?: string[]) => this._promptUser!(q, opts)
        : undefined,
      promptTabs: this._promptTabs
        ? (qs: TabQuestion[]) => this._promptTabs!(qs)
        : undefined,
      maxIterations: this.agentOverrides.maxIterations,
      continuationPrompt: this.agentOverrides.continuationPrompt,
      excludeTools: this.agentOverrides.excludeTools,
      apiKey: this.userConfig.api_key,
      apiBaseURL: this.userConfig.api_base_url,
      briefing: this._briefingConsumed ? undefined : this.briefing,
      autonomy: this.agentOverrides.autonomy,
      preApproval: this.agentOverrides.preApproval,
      audit: this.agentOverrides.audit,
      secretStore: this.secretStore ?? undefined,
      userId: this.userId ?? undefined,
      activeScopes: this.activeScopes.length > 0 ? this.activeScopes : undefined,
      changesetManager: this._changesetManager ?? undefined,
      toolContext: this._toolContext,
    });

    // Respect memory_extraction config (default: true)
    if (this.userConfig.memory_extraction === false) {
      this.agent.skipMemoryExtraction = true;
    }
  }

  /**
   * Register lifecycle hooks for extending the orchestrator.
   * Pro packages call this to add tenant tracking, tool filtering, etc.
   */
  registerHooks(hooks: NodynHooks): void {
    this._hooks.push(hooks);
  }
}
