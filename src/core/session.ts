import { randomUUID } from 'node:crypto';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { getErrorMessage } from './utils.js';
import { LynoxError } from './errors.js';
import type {
  LynoxUserConfig,
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
  IAgent,
} from '../types/index.js';
import { MODEL_MAP } from '../types/index.js';
import { Agent } from './agent.js';
import { hashPrompt } from './prompt-hash.js';
import { calculateCost } from './pricing.js';
import { channels } from './observability.js';
import { abortSpawnedAgents } from '../tools/builtin/spawn.js';
import { abortPipelineAgents } from '../orchestrator/runtime-adapter.js';
import { ChangesetManager } from './changeset.js';
import { isWorkspaceActive } from './workspace.js';
import { checkPersistentBudget } from './session-budget.js';
import {
  SYSTEM_PROMPT,
  PIPELINE_PROMPT_SUFFIX,
  DATASTORE_PROMPT_SUFFIX,
  DEVELOPER_PROMPT_SUFFIX,
} from './prompts.js';
import type { Engine, RunContext, AccumulatedUsage, LynoxHooks } from './engine.js';
import { setupHistorySubscriptions } from './engine-init.js';
import type { ToolContext } from './tool-context.js';
import type { Memory } from './memory.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { RunHistory } from './run-history.js';
import type { LynoxContext, MemoryScopeRef } from '../types/index.js';
import type { SecretStore } from './secret-store.js';
import type { EmbeddingProvider } from './embedding.js';
import type { KnowledgeLayer } from './knowledge-layer.js';
import type { DataStore } from './data-store.js';
import type { BatchIndex } from './batch-index.js';
import type { PluginManager } from './plugins.js';

export interface SessionOptions {
  sessionId?: string | undefined;
  model?: ModelTier | undefined;
  effort?: EffortLevel | undefined;
  thinking?: ThinkingMode | undefined;
  autonomy?: import('../types/index.js').AutonomyLevel | undefined;
  briefing?: string | undefined;
  onStream?: StreamHandler | undefined;
  promptUser?: ((question: string, options?: string[]) => Promise<string>) | undefined;
  promptTabs?: ((questions: TabQuestion[]) => Promise<string[]>) | undefined;
  tenantId?: string | undefined;
  messages?: BetaMessageParam[] | undefined;
  systemPromptSuffix?: string | undefined;
}

/**
 * Session — per-conversation state.
 * Holds Agent, messages, mode, callbacks, and run tracking.
 * Created via engine.createSession().
 */
export class Session {
  readonly engine: Engine;
  private agent: Agent | null = null;
  private agentOverrides: {
    maxIterations?: number | undefined;
    continuationPrompt?: string | undefined;
    excludeTools?: string[] | undefined;
    systemPromptSuffix?: string | undefined;
    autonomy?: import('../types/index.js').AutonomyLevel | undefined;
  } = {};
  readonly sessionId: string;
  private briefing: string | undefined;
  private _briefingConsumed = false;
  private currentRunId: string | null = null;
  private runToolCallSeq = 0;
  private _userWaitMs = 0;
  private _runToolNames = new Set<string>();
  private _retrievedMemoryIds: string[] = [];
  private _changesetManager: ChangesetManager | null = null;
  onStream: StreamHandler | null = null;
  private _promptUser: ((question: string, options?: string[]) => Promise<string>) | null = null;
  private _promptTabs: ((questions: TabQuestion[]) => Promise<string[]>) | null = null;
  private _tenantId: string | null = null;

  // Per-session config (copied from engine.config at creation, mutated independently)
  private _model: ModelTier;
  private _effort: EffortLevel;
  private _thinking: ThinkingMode | undefined;
  private _maxTokens: number | undefined;
  private _systemPrompt: string | undefined;

  readonly usage: AccumulatedUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  constructor(engine: Engine, opts?: SessionOptions) {
    this.engine = engine;
    this.sessionId = opts?.sessionId ?? randomUUID();
    // Copy config from engine — session mutates its own copy, not the shared config
    this._model = opts?.model ?? engine.config.model ?? 'sonnet';
    this._effort = opts?.effort ?? engine.config.effort ?? 'high';
    this._thinking = opts?.thinking ?? engine.config.thinking;
    this._maxTokens = engine.config.maxTokens;
    this._systemPrompt = engine.config.systemPrompt;
    // Truncate briefing to prevent prompt bloat (~2K tokens max)
    const rawBriefing = opts?.briefing ?? engine.getBriefing();
    this.briefing = rawBriefing && rawBriefing.length > 8000
      ? rawBriefing.slice(0, 8000) + '\n[...truncated]'
      : rawBriefing;
    this.onStream = opts?.onStream ?? null;
    this._promptUser = opts?.promptUser ?? null;
    this._promptTabs = opts?.promptTabs ?? null;
    this._tenantId = opts?.tenantId ?? null;
    if (opts?.systemPromptSuffix) {
      this.agentOverrides.systemPromptSuffix = opts.systemPromptSuffix;
    }
    if (opts?.autonomy) {
      this.agentOverrides.autonomy = opts.autonomy;
    }
    this._createAgent();

    // Each Session subscribes once to record tool calls against its own run.
    // The closures read session-local fields, so concurrent sessions don't interfere.
    const runHistory = engine.getRunHistory();
    if (runHistory) {
      setupHistorySubscriptions(
        runHistory,
        () => this.currentRunId,
        () => this.runToolCallSeq++,
        (ms: number) => { this._userWaitMs += ms; },
      );
    }

    // Create persistent thread record (idempotent — OR IGNORE)
    const threadStore = engine.getThreadStore();
    if (threadStore) {
      try {
        threadStore.createThread(this.sessionId, {
          model_tier: this._model,
          context_id: engine.getContext()?.id ?? '',
        });
      } catch { /* best-effort */ }
    }

    if (opts?.messages) {
      this.loadMessages(opts.messages);
    }
  }

  // ── User interaction callbacks ──

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

  // ── Core execution ──

  async run(task: string | unknown[]): Promise<string> {
    if (!this.agent) throw new Error('Session not initialized — agent missing');

    // Extract text for subsystems that need string (input guard, KG retrieval, run history).
    // Multimodal content (e.g. Telegram vision) is an array of content blocks.
    const isMultimodal = Array.isArray(task);
    const taskText = isMultimodal ? '[image]' : task;
    const threadStore = this.engine.getThreadStore();

    // Create changeset manager if enabled (backup-before-write mode).
    // Only enable when workspace is active (real project files) — without workspace,
    // writes go to ~/.lynox/workspace/ and the normal isDangerous() guard is sufficient.
    const isAutonomous = this.agentOverrides.autonomy === 'autonomous';
    const hasWorkspace = isWorkspaceActive();
    const changesetEnabled = hasWorkspace && (isAutonomous || (this.engine.getUserConfig().changeset_review !== false));
    if (changesetEnabled) {
      const runId = randomUUID();
      this._changesetManager = new ChangesetManager(process.cwd(), runId);
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
    const context = this.engine.getContext();
    const preRunContext: RunContext = {
      runId: randomUUID(),
      contextId: context?.id ?? '',
      modelTier: this._model,
      durationMs: 0,
      source: context?.source ?? 'cli',
      tenantId: this._tenantId ?? undefined,
    };
    for (const hook of this.engine.getHooks()) {
      if (hook.onBeforeRun) {
        try {
          await hook.onBeforeRun(preRunContext.runId, preRunContext);
        } catch (err: unknown) {
          return `Run blocked: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }

    // Content policy: check user input for malware/exploit/phishing intent BEFORE sending to LLM
    // Skip for multimodal content — input guard operates on text only
    if (!isMultimodal) {
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
    }

    // Auto-downgrade to haiku for simple tasks (cost optimization)
    if (!isMultimodal && this._model !== 'haiku' && !this._thinking) {
      const isSimple = this._isSimpleTask(taskText);
      if (isSimple) {
        this._model = 'haiku';
        this._recreateAgent();
      }
    }

    const model = MODEL_MAP[this._model];
    const startTime = Date.now();
    this.runToolCallSeq = 0;
    this._userWaitMs = 0;
    this._runToolNames.clear();
    this._retrievedMemoryIds = [];

    // Compute prompt hash from the system prompt the agent uses
    const basePrompt = this._systemPrompt ?? SYSTEM_PROMPT;
    const effectivePrompt = this.agentOverrides.systemPromptSuffix
      ? basePrompt + this.agentOverrides.systemPromptSuffix
      : basePrompt;
    const promptHash = hashPrompt(effectivePrompt);

    // Record run start
    const runHistory = this.engine.getRunHistory();
    if (runHistory) {
      try {
        this.currentRunId = runHistory.insertRun({
          sessionId: this.sessionId,
          taskText,
          modelTier: this._model,
          modelId: model,
          promptHash,
          contextId: context?.id ?? '',
          ...(this._tenantId ? { tenantId: this._tenantId } : {}),
        });
        // Snapshot prompt if this hash is new
        runHistory.insertPromptSnapshot(promptHash, 'default', effectivePrompt);
      } catch {
        this.currentRunId = null;
      }
    }

    // Thread run ID to agent so spawn tool can read it
    this.agent.currentRunId = this.currentRunId ?? undefined;

    const usageBefore = { ...this.usage };

    // Knowledge Graph retrieval (mandatory)
    // Skip for multimodal — KG retrieval operates on text queries only
    const knowledgeLayer = this.engine.getKnowledgeLayer();
    if (knowledgeLayer && !isMultimodal) {
      try {
        const result = await knowledgeLayer.retrieve(task, this.engine.getActiveScopes(), {
          topK: 8,
          threshold: 0.55,
          useHyDE: true,
          useGraphExpansion: true,
        });
        this._retrievedMemoryIds = result.memories.map(m => m.id);
        this.agent.setKnowledgeContext(knowledgeLayer.formatRetrievalContext(result));
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

      if (runHistory && this.currentRunId) {
        try {
          runHistory.updateRun(this.currentRunId, {
            responseText: result,
            tokensIn,
            tokensOut,
            tokensCacheRead: cacheRead,
            tokensCacheWrite: cacheWrite,
            costUsd,
            toolCallCount: this.runToolCallSeq,
            durationMs,
            userWaitMs: this._userWaitMs,
            stopReason: 'end_turn',
            status: 'completed',
          });
        } catch {
          // Fire-and-forget
        }
      }

      // Persist messages to thread (fire-and-forget)
      if (threadStore) {
        try {
          const allMessages = this.saveMessages();
          const existingCount = threadStore.getMessageCount(this.sessionId);
          const newMessages = allMessages.slice(existingCount);
          if (newMessages.length > 0) {
            threadStore.appendMessages(this.sessionId, newMessages, existingCount);
            threadStore.updateThread(this.sessionId, {
              message_count: allMessages.length,
              total_tokens: this.usage.input_tokens + this.usage.output_tokens,
              total_cost_usd: costUsd,
            });

            // Auto-generate title on first run (heuristic: first user message)
            if (existingCount === 0) {
              const title = generateThreadTitle(taskText);
              threadStore.updateThread(this.sessionId, { title });
            }
          }
        } catch { /* fire-and-forget */ }
      }

      // Auto-confirm retrieved memories on success
      if (knowledgeLayer && this._retrievedMemoryIds.length > 0) {
        try {
          knowledgeLayer.feedbackOnRetrieval(this._retrievedMemoryIds, 'useful');
        } catch { /* fire-and-forget */ }
      }

      // Fire orchestrator lifecycle hooks (for Pro extensions — includes tenant cost tracking)
      const runContext: RunContext = {
        runId: this.currentRunId!,
        contextId: context?.id ?? '',
        modelTier: this._model,
        durationMs,
        source: context?.source ?? 'cli',
        ...(this._tenantId ? { tenantId: this._tenantId } : {}),
      };
      for (const hook of this.engine.getHooks()) {
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
      const pluginManager = this.engine.getPluginManager();
      if (pluginManager) {
        void pluginManager.fireRunComplete(result);
      }

      // Trigger engine-level GC counter
      this.engine.incrementRunCount();

      return result;
    } catch (err: unknown) {
      // Sentry capture — structured error with tags
      void import('./sentry.js').then(({ captureLynoxError, captureError: captureSentryError }) => {
        if (err instanceof LynoxError) {
          captureLynoxError(err);
        } else {
          captureSentryError(err);
        }
      }).catch(() => {});

      if (runHistory && this.currentRunId) {
        try {
          runHistory.updateRun(this.currentRunId, {
            responseText: getErrorMessage(err),
            durationMs: Date.now() - startTime,
            userWaitMs: this._userWaitMs,
            status: 'failed',
          });
        } catch {
          // Fire-and-forget
        }
      }

      // Persist messages to thread even on failure (preserve partial progress)
      if (threadStore) {
        try {
          const allMessages = this.saveMessages();
          const existingCount = threadStore.getMessageCount(this.sessionId);
          const newMessages = allMessages.slice(existingCount);
          if (newMessages.length > 0) {
            threadStore.appendMessages(this.sessionId, newMessages, existingCount);
            threadStore.updateThread(this.sessionId, { message_count: allMessages.length });
          }
        } catch { /* fire-and-forget */ }
      }

      throw err;
    } finally {
      this.currentRunId = null;
      if (this.agent) {
        this.agent.currentRunId = undefined;
      }
    }
  }

  /** Track tool name used during current run (called from stream handler). */
  recordToolName(name: string): void {
    this._runToolNames.add(name);
  }

  private _getToolsUsed(): string[] {
    return [...this._runToolNames];
  }

  /** Heuristic: detect simple tasks that can use haiku instead of sonnet/opus. */
  private _isSimpleTask(task: string): boolean {
    const lower = task.toLowerCase();
    const len = task.length;

    // Complex tasks → always keep current model
    const complexPatterns = [
      /\b(implement|build|create|design|refactor|fix|debug|deploy|migrate)\b/i,
      /\b(schreib|entwickl|bau|erstell|analysier|optimier)\b/i,
      /\b(code|function|class|component|api|database|test|schema|query)\b/i,
      /\b(file|datei|config|server|docker|pipeline|workflow)\b/i,
    ];
    if (complexPatterns.some(p => p.test(lower))) return false;
    if (len > 200) return false;

    // Short, simple queries → haiku
    const simplePatterns = [
      /^(was |wer |wo |wann |wie viel|how |what |who |where |when )/i,
      /^(zeig |list |show |check |status |prüf)/i,
      /^(erinner|recall|remember|merke)/i,
    ];
    if (simplePatterns.some(p => p.test(lower)) && len < 120) return true;
    if (len < 40) return true;

    return false;
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

  // ── Messages ──

  saveMessages(): BetaMessageParam[] {
    return this.agent?.getMessages() ?? [];
  }

  loadMessages(messages: BetaMessageParam[]): void {
    if (this.agent) {
      this.agent.loadMessages(messages);
    }
  }

  // ── Model / Effort / Thinking ──

  setModel(tier: ModelTier): string {
    const messages = this.saveMessages();
    this._model = tier;
    this._createAgent();
    this.loadMessages(messages);
    return MODEL_MAP[tier];
  }

  getModelTier(): ModelTier {
    return this._model;
  }

  setEffort(level: EffortLevel): void {
    const messages = this.saveMessages();
    this._effort = level;
    this._createAgent();
    this.loadMessages(messages);
  }

  getEffort(): EffortLevel {
    return this._effort;
  }

  setThinking(mode: ThinkingMode | undefined): void {
    const messages = this.saveMessages();
    this._thinking = mode;
    this._createAgent();
    this.loadMessages(messages);
  }

  getThinking(): ThinkingMode | undefined {
    return this._thinking;
  }

  setSkipMemoryExtraction(skip: boolean): void {
    if (this.agent) this.agent.skipMemoryExtraction = skip;
  }

  // ── Agent creation (internal) ──

  /** Recreate agent with overrides (preserves conversation history) */
  _recreateAgent(overrides?: {
    maxIterations?: number | undefined;
    continuationPrompt?: string | undefined;
    excludeTools?: string[] | undefined;
    systemPromptSuffix?: string | undefined;
    autonomy?: import('../types/index.js').AutonomyLevel | undefined;
  }): void {
    this.agentOverrides = overrides ?? {};
    const messages = this.saveMessages();
    this._createAgent();
    this.loadMessages(messages);
  }

  private _createAgent(): void {
    const engine = this.engine;
    const userConfig = engine.getUserConfig();
    const registry = engine.getRegistry();
    const pluginManager = engine.getPluginManager();
    const toolContext = engine.getToolContext();

    // Keep tool context in sync
    toolContext.tools = registry.getEntries();
    toolContext.streamHandler = this.onStream ?? null;

    const model = MODEL_MAP[this._model] ?? MODEL_MAP['sonnet'];
    const mcpServers = registry.getMCPServers();
    const entries = registry.getEntries();
    const tools = pluginManager
      ? entries.map(entry => ({
          definition: entry.definition,
          handler: async (input: unknown, agent: IAgent): Promise<string> => {
            const gate = await pluginManager.fireToolGate(entry.definition.name, input);
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
        void import('./sentry.js').then(({ addLLMBreadcrumb }) => {
          addLLMBreadcrumb(model, event.usage.input_tokens, event.usage.output_tokens);
        }).catch(() => {});
      }
      // Track tool names for thread insights
      if (event.type === 'tool_call' && 'name' in event) {
        this.recordToolName(event.name as string);
      }
      if (this.onStream) {
        await this.onStream(event);
      }
    };

    let basePrompt = this._systemPrompt ?? SYSTEM_PROMPT;
    // Append pipeline docs only when pipeline tools are registered
    if (engine.getPipelinesEnabled()) {
      basePrompt += PIPELINE_PROMPT_SUFFIX;
    }
    // Append data store docs only when data store tools are registered
    if (engine.getDataStoreEnabled()) {
      basePrompt += DATASTORE_PROMPT_SUFFIX;
    }
    // Append developer mode suffix when experience is set to 'developer'
    if (userConfig.experience === 'developer') {
      basePrompt += DEVELOPER_PROMPT_SUFFIX;
    }
    const systemPrompt = this.agentOverrides.systemPromptSuffix
      ? basePrompt + this.agentOverrides.systemPromptSuffix
      : basePrompt;

    // Apply hook-based tool filtering (for Pro extensions)
    let effectiveTools = tools;
    for (const hook of engine.getHooks()) {
      if (hook.onBeforeCreateAgent) {
        effectiveTools = hook.onBeforeCreateAgent(effectiveTools);
      }
    }

    this.agent = new Agent({
      name: 'lynox',
      model,
      systemPrompt,
      tools: effectiveTools,
      mcpServers: mcpServers.length > 0 ? mcpServers : undefined,
      thinking: this._thinking,
      effort: this._effort,
      maxTokens: this._maxTokens,
      memory: engine.getMemory() ?? undefined,
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
      apiKey: userConfig.api_key,
      apiBaseURL: userConfig.api_base_url,
      briefing: this._briefingConsumed ? undefined : this.briefing,
      autonomy: this.agentOverrides.autonomy,
      secretStore: engine.getSecretStore() ?? undefined,
      userId: engine.getUserId() ?? undefined,
      activeScopes: engine.getActiveScopes().length > 0 ? engine.getActiveScopes() : undefined,
      changesetManager: this._changesetManager ?? undefined,
      toolContext,
    });

    // Respect memory_extraction config (default: true)
    if (userConfig.memory_extraction === false) {
      this.agent.skipMemoryExtraction = true;
    }
  }

  // ── Engine delegation (so CLI commands can call session.getMemory() etc.) ──

  getRegistry(): ToolRegistry { return this.engine.getRegistry(); }
  getMemory(): Memory | null { return this.engine.getMemory(); }
  getRunHistory(): RunHistory | null { return this.engine.getRunHistory(); }
  getContext(): LynoxContext | null { return this.engine.getContext(); }
  getUserConfig(): LynoxUserConfig { return this.engine.getUserConfig(); }
  getKnowledgeLayer(): KnowledgeLayer | null { return this.engine.getKnowledgeLayer(); }
  getSecretStore(): SecretStore | null { return this.engine.getSecretStore(); }
  getGoogleAuth(): import('../integrations/google/google-auth.js').GoogleAuth | null { return this.engine.getGoogleAuth(); }
  getTaskManager(): import('./task-manager.js').TaskManager | null { return this.engine.getTaskManager(); }
  getDataStore(): DataStore | null { return this.engine.getDataStore(); }
  getPluginManager(): PluginManager | null { return this.engine.getPluginManager(); }
  getActiveScopes(): MemoryScopeRef[] { return this.engine.getActiveScopes(); }
  getUserId(): string | null { return this.engine.getUserId(); }
  getEmbeddingProvider(): EmbeddingProvider | null { return this.engine.getEmbeddingProvider(); }
  getToolContext(): ToolContext { return this.engine.getToolContext(); }
  getApiConfig(): { apiKey?: string | undefined; apiBaseURL?: string | undefined } { return this.engine.getApiConfig(); }
  getBatchIndex(): BatchIndex { return this.engine.getBatchIndex(); }
  getBriefing(): string | undefined { return this.briefing; }
  getAgent(): Agent | null { return this.agent; }
  getChangesetManager(): ChangesetManager | null { return this._changesetManager; }
  getPromptTabs(): ((questions: TabQuestion[]) => Promise<string[]>) | null { return this._promptTabs; }

  // ── Engine delegation — tool registration ──

  registerTool<T>(entry: ToolEntry<T>): void { this.engine.registerTool(entry); }
  registerPipelineTools(): void { this.engine.registerPipelineTools(); }
  registerDataStoreTools(): void { this.engine.registerDataStoreTools(); }
  registerHooks(hooks: LynoxHooks): void { this.engine.registerHooks(hooks); }
  addTool<T>(entry: ToolEntry<T>): void {
    this.engine.addTool(entry);
    this._createAgent();
  }
  addMCP(server: MCPServer): void {
    this.engine.addMCP(server);
    this._createAgent();
  }

  // ── Engine delegation — batch ──

  async batch(reqs: BatchRequest[]): Promise<string> {
    return this.engine.batch(reqs, { systemPromptSuffix: this.agentOverrides.systemPromptSuffix });
  }
  async awaitBatch(batchId: string): Promise<BatchResult[]> { return this.engine.awaitBatch(batchId); }
  async batchAndAwait(reqs: BatchRequest[]): Promise<BatchResult[]> {
    return this.engine.batchAndAwait(reqs, { systemPromptSuffix: this.agentOverrides.systemPromptSuffix });
  }
  getLastBatchParentId(): string | null { return this.engine.getLastBatchParentId(); }

  // ── Engine delegation — config ──

  reloadUserConfig(): void {
    this.engine.reloadUserConfig();
    const messages = this.saveMessages();
    this._createAgent();
    this.loadMessages(messages);
  }

  // ── Shutdown (delegates to engine, plus session-level teardown) ──

  async shutdown(): Promise<void> {
    await this.engine.shutdown();
  }
}

/** Generate a short thread title from the first user message. */
function generateThreadTitle(taskText: string): string {
  // Strip markdown, trim, and take first meaningful line
  let title = taskText
    .replace(/^#+\s*/gm, '')
    .replace(/\[.*?\]\(.*?\)/g, '')
    .replace(/[*_`~]/g, '')
    .trim();

  // Take the first line if multi-line
  const firstLine = title.split('\n')[0] ?? title;
  title = firstLine.trim();

  // Cap at 80 chars
  if (title.length > 80) {
    title = title.slice(0, 77) + '...';
  }

  return title || 'New Chat';
}
