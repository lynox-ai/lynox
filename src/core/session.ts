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
import { MODEL_MAP, CHARS_PER_TOKEN, CONTEXT_WINDOW, getModelId, clampTier } from '../types/index.js';
import { getActiveProvider, isBedrockEuOnly } from './llm-client.js';
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
  GOOGLE_PROMPT_SUFFIX,
  PIPELINE_PROMPT_SUFFIX,
  DATASTORE_PROMPT_SUFFIX,
  CRM_PROMPT_SUFFIX,
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

/** Per-run overrides — applied via agent setters, never mutate session state. */
export interface RunOptions {
  effort?: EffortLevel | undefined;
  thinking?: ThinkingMode | undefined;
}

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
  private _isCompacting = false;
  onStream: StreamHandler | null = null;
  private _promptUser: ((question: string, options?: string[]) => Promise<string>) | null = null;
  private _promptTabs: ((questions: TabQuestion[]) => Promise<string[]>) | null = null;
  private _promptSecret: ((name: string, prompt: string, keyType?: string) => Promise<boolean>) | null = null;
  private _tenantId: string | null = null;
  private _skipMemoryExtractionOverride: boolean | null = null;

  // Per-session config (copied from engine.config at creation, mutated independently)
  private _registryVersion = 0;
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
    this._effort = opts?.effort ?? engine.config.effort ?? 'medium';
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

  get promptSecret(): ((name: string, prompt: string, keyType?: string) => Promise<boolean>) | null {
    return this._promptSecret;
  }

  set promptSecret(fn: ((name: string, prompt: string, keyType?: string) => Promise<boolean>) | null) {
    this._promptSecret = fn;
    if (this.agent) {
      this.agent.promptSecret = fn
        ? (name: string, prompt: string, keyType?: string) => fn(name, prompt, keyType)
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

  async run(task: string | unknown[], runOptions?: RunOptions): Promise<string> {
    if (!this.agent) throw new Error('Session not initialized — agent missing');

    // Hot-reload tools when registry changed (e.g. Google connected mid-session)
    if (this.engine.getRegistry().version !== this._registryVersion) {
      this._recreateAgent();
    }

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

    // Apply pending step hint from previous ask_user selection
    const toolCtx = this.getToolContext();
    const pendingHint = toolCtx.pendingStepHint;
    if (pendingHint) {
      toolCtx.pendingStepHint = null;
      const maxTier = toolCtx.userConfig.max_tier;
      if (pendingHint.model) {
        this._model = clampTier(pendingHint.model, maxTier);
        this._recreateAgent();
      }
      if (pendingHint.effort) {
        this._effort = pendingHint.effort;
      }
      if (pendingHint.thinking) {
        this._thinking = pendingHint.thinking === 'enabled'
          ? { type: 'enabled', budget_tokens: 10_000 }
          : pendingHint.thinking === 'disabled'
            ? { type: 'disabled' }
            : { type: 'adaptive' };
      }
    }

    // Auto-downgrade to haiku for simple tasks (cost optimization)
    // Allow downgrade with adaptive thinking (Haiku auto-disables thinking in agent.ts)
    // Only block when thinking is explicitly enabled with a budget
    const savedModel = this._model;
    const thinkingBlocksDowngrade = this._thinking?.type === 'enabled';
    if (!isMultimodal && this._model !== 'haiku' && !thinkingBlocksDowngrade) {
      if (this._isSimpleTask(taskText)) {
        this._model = 'haiku';
        this._recreateAgent();
      }
    }

    // Apply per-run overrides via agent setters (never mutate session state)
    const hasRunOverrides = runOptions?.effort !== undefined || runOptions?.thinking !== undefined;
    if (hasRunOverrides && this.agent) {
      if (runOptions?.effort !== undefined) this.agent.setEffort(runOptions.effort);
      if (runOptions?.thinking !== undefined) this.agent.setThinking(runOptions.thinking);
    }

    const model = getModelId(this._model, getActiveProvider(), isBedrockEuOnly());
    const startTime = Date.now();
    this.runToolCallSeq = 0;
    this._userWaitMs = 0;
    this._runToolNames.clear();
    this._retrievedMemoryIds = [];

    // Compute prompt hash from the system prompt the agent uses
    let basePrompt = this._systemPrompt ?? SYSTEM_PROMPT;
    if (this.engine.config.language) {
      const langName = { de: 'German', en: 'English', fr: 'French', it: 'Italian', es: 'Spanish', nl: 'Dutch', pt: 'Portuguese', sv: 'Swedish' }[this.engine.config.language] ?? this.engine.config.language;
      basePrompt += `\n\n**Language override**: Respond in ${langName}. The user has explicitly set this preference.`;
    }
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

    // Thread run ID and session ID to agent so spawn tool and memory extraction can use them
    this.agent.currentRunId = this.currentRunId ?? undefined;
    this.agent.currentThreadId = this.sessionId;

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
        this.agent.setKnowledgeContext(knowledgeLayer.formatRetrievalContext(result, undefined, task));
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

      // Auto-compact if context is filling up (soft compaction before hard truncation kicks in)
      if (!this._isCompacting) {
        void this._autoCompactIfNeeded();
      }

      return result;
    } catch (err: unknown) {
      // Bugsink capture — structured error with tags
      void import('./error-reporting.js').then(({ captureLynoxError, captureError: captureReportedError }) => {
        if (err instanceof LynoxError) {
          captureLynoxError(err);
        } else {
          captureReportedError(err);
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
        // Restore per-run overrides to session defaults
        if (hasRunOverrides) {
          this.agent.setEffort(this._effort);
          this.agent.setThinking(this._thinking ?? { type: 'adaptive' });
        }
      }
      // Restore model if auto-downgraded to haiku for this run
      if (this._model !== savedModel) {
        this._model = savedModel;
        this._recreateAgent();
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

  /** Heuristic: detect simple tasks that can use haiku instead of sonnet/opus.
   *  Principle: when in doubt, keep Sonnet. A slightly higher cost is better
   *  than a bad answer from Haiku on a task that needs reasoning. */
  private _isSimpleTask(task: string): boolean {
    const lower = task.toLowerCase().trim();
    const len = task.length;

    // --- Blockers: anything that needs reasoning stays on current model ---
    const reasoningBlockers = [
      /\b(implement|build|create|design|refactor|fix|debug|deploy|migrate)\b/i,
      /\b(schreib|entwickl|bau|erstell|analysier|optimier)\b/i,
      /\b(code|function|class|component|api|database|test|schema|query)\b/i,
      /\b(file|datei|config|server|docker|pipeline|workflow)\b/i,
      // Reasoning & opinion indicators — must not go to Haiku
      /\b(warum|weshalb|wieso|why|erkl[äa]r|explain|begründ|reason)\b/i,
      /\b(denkst|meinst|findest|glaubst|würdest|sollte|think|opinion|suggest)\b/i,
      /\b(einsch[äa]tz|bewert|vergleich|assess|evaluat|compar|review)\b/i,
      /\b(strategie|plan|konzept|approach|strategy|architektur|entscheid)\b/i,
      /\b(aber|however|allerdings|berücksichtig|consider|beacht)\b/i,
    ];
    if (reasoningBlockers.some(p => p.test(lower))) return false;
    if (len > 200) return false;

    // --- Follow-up acknowledgments (pure acks, no continuation) ---
    const hasHistory = this.agent && this.agent.getMessages().length > 0;
    if (hasHistory) {
      // Only pure acks — no comma/aber/und continuation
      const pureAck = /^(danke|thanks|thx|ok|okay|alles klar|passt|perfekt|super|gut|nice|cool|great|yes|ja|nein|no|verstanden|got it|makes sense|klar|genau)[.!]?\s*$/i;
      if (pureAck.test(lower) && len < 40) return true;
    }

    // --- Short factual lookups → haiku ---
    const factualPatterns = [
      /^(was ist|was sind|wer ist|wo ist|wann |wie viel|how many|what is|who is|where is|when )/i,
      /^(zeig |list |show |check |status |prüf)/i,
      /^(erinner|recall|remember|merke)/i,
    ];
    if (factualPatterns.some(p => p.test(lower)) && len < 80) return true;

    // --- Greetings → haiku ---
    if (/^(hallo|hello|hi |hey |moin|grüß)/i.test(lower) && len < 60) return true;

    // --- Very short AND no reasoning words (already checked above) → haiku ---
    if (len < 25) return true;

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

  /**
   * Compact the conversation: summarize history into a concise summary,
   * reset messages, and inject the summary as synthetic context.
   * Used by CLI /compact command and auto-compaction.
   */
  async compact(focus?: string): Promise<{ success: boolean; summary: string }> {
    const prompt = focus
      ? `Summarize the key points of our conversation so far, focusing on: ${focus}. Be extremely concise — bullet points only.`
      : 'Summarize the key points of our conversation so far. Be extremely concise — bullet points only.';
    let summary = '';
    try {
      summary = await this.run(prompt);
    } catch {
      // Compaction prompt failed — reset anyway to free context
    }
    this.reset();
    if (summary) {
      this.loadMessages([
        { role: 'user' as const, content: 'What have we discussed so far?' },
        { role: 'assistant' as const, content: `[Conversation summary]\n${summary}` },
      ]);
      return { success: true, summary };
    }
    return { success: false, summary: '' };
  }

  /**
   * Estimate current context usage percentage.
   * Uses the same CHARS_PER_TOKEN constant as agent truncation.
   */
  getContextUsagePercent(): number {
    if (!this.agent) return 0;
    const messages = this.agent.getMessages();
    const msgLen = JSON.stringify(messages).length;
    const estimatedTokens = msgLen / CHARS_PER_TOKEN;
    const maxCtx = CONTEXT_WINDOW[MODEL_MAP[this._model]] ?? 200_000;
    return Math.round(estimatedTokens / maxCtx * 100);
  }

  /**
   * Auto-compact if context usage exceeds 75%.
   * Runs after each successful run() to prevent context overflow.
   * Guard flag prevents recursive compaction since compact() calls run().
   */
  private async _autoCompactIfNeeded(): Promise<void> {
    if (this._isCompacting || !this.agent) return;
    const usagePercent = this.getContextUsagePercent();
    if (usagePercent <= 75) return;

    this._isCompacting = true;
    try {
      const result = await this.compact();
      if (result.success && this.onStream) {
        void this.onStream({
          type: 'context_compacted',
          summary: result.summary,
          previousUsagePercent: usagePercent,
          agent: this.agent.name,
        });
      }
    } catch {
      // Auto-compaction failed — not fatal, hard truncation will handle it
    } finally {
      this._isCompacting = false;
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
    return getModelId(tier, getActiveProvider(), isBedrockEuOnly());
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
    this._skipMemoryExtractionOverride = skip;
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
    this._registryVersion = registry.version;
    const pluginManager = engine.getPluginManager();
    const toolContext = engine.getToolContext();

    // Keep tool context in sync
    toolContext.tools = registry.getEntries();
    toolContext.streamHandler = this.onStream ?? null;

    const model = getModelId(this._model, getActiveProvider(), isBedrockEuOnly());
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
        // Inject actual model so the client can compute correct costs
        (event as { model?: string }).model = model;
        this.usage.input_tokens += event.usage.input_tokens;
        this.usage.output_tokens += event.usage.output_tokens;
        this.usage.cache_creation_input_tokens += event.usage.cache_creation_input_tokens ?? 0;
        this.usage.cache_read_input_tokens += event.usage.cache_read_input_tokens ?? 0;
        void import('./error-reporting.js').then(({ addLLMBreadcrumb }) => {
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
    // Append Google Workspace docs only when Google tools are registered
    if (engine.getGoogleAuth()) {
      basePrompt += GOOGLE_PROMPT_SUFFIX;
    }
    // Append pipeline docs only when pipeline tools are registered
    if (engine.getPipelinesEnabled()) {
      basePrompt += PIPELINE_PROMPT_SUFFIX;
    }
    // Append data store docs only when data store tools are registered
    if (engine.getDataStoreEnabled()) {
      basePrompt += DATASTORE_PROMPT_SUFFIX;
      // Append CRM docs only when contacts/deals have actual records
      if (engine.hasCrmData()) {
        basePrompt += CRM_PROMPT_SUFFIX;
      }
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
      provider: userConfig.provider,
      awsRegion: userConfig.aws_region,
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
    // Per-thread override takes precedence over global config
    if (this._skipMemoryExtractionOverride !== null) {
      this.agent.skipMemoryExtraction = this._skipMemoryExtractionOverride;
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
  getApiConfig(): ReturnType<import('./engine.js').Engine['getApiConfig']> { return this.engine.getApiConfig(); }
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

  async reloadUserConfig(): Promise<void> {
    await this.engine.reloadUserConfig();
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
  // Strip system context prefixes (e.g. onboarding prompts)
  let title = taskText.replace(/^\[ONBOARDING \d+\/\d+\][\s\S]*?\n\n/i, '');

  // Strip markdown, trim, and take first meaningful line
  title = title
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
