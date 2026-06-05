import { randomUUID } from 'node:crypto';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { getErrorMessage } from './utils.js';
import { LynoxError } from './errors.js';
import type {
  LynoxUserConfig,
  ToolEntry,
  BatchRequest,
  BatchResult,
  StreamHandler,
  StreamEvent,
  ModelTier,
  EffortLevel,
  ThinkingMode,
  TabQuestion,
  IAgent,
  PromptUserFn,
  PromptTabsFn,
  PromptSecretFn,
  PromptMeta,
} from '../types/index.js';
import { effectiveContextWindow, getModelId, clampTier } from '../types/index.js';
import { getActiveProvider } from './llm-client.js';
import { resolveProviderApiKey } from './llm/provider-keys.js';
import { Agent } from './agent.js';
import { hashPrompt } from './prompt-hash.js';
import { calculateCost } from './pricing.js';
import { channels } from './observability.js';
import { ToolCallTracker } from './output-guard.js';
import { abortSpawnedAgents } from '../tools/builtin/spawn.js';
import { abortPipelineAgents } from '../orchestrator/runtime-adapter.js';
import { ChangesetManager } from './changeset.js';
import {
  ToolResultBlobStore,
  DEFAULT_TOOL_RESULT_BLOB_THRESHOLD_CHARS,
} from './tool-result-blob-store.js';
import { isWorkspaceActive } from './workspace.js';
import { checkPersistentBudget } from './session-budget.js';
import {
  SYSTEM_PROMPT,
  GOOGLE_PROMPT_SUFFIX,
  PIPELINE_PROMPT_SUFFIX,
  DATASTORE_PROMPT_SUFFIX,
  CRM_PROMPT_SUFFIX,
  DEVELOPER_PROMPT_SUFFIX,
  NO_WEB_SEARCH_PROMPT_SUFFIX,
  WEB_SEARCH_FALLBACK_PROMPT_SUFFIX,
  currentDateContext,
  modelIdentityContext,
  withCurrentTimePrefix,
} from './prompts.js';
import type { Engine, RunContext, AccumulatedUsage, LynoxHooks } from './engine.js';
import { setupHistorySubscriptions } from './engine-init.js';
import { persistAgentMessages, persistFailedTurnDisplay, persistCompactionMarker } from './eager-persist.js';
import { buildPostCompactionMessages } from './compaction-messages.js';
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

/** Context-usage % at which auto-compaction fires as a LAST-RESORT safety net.
 *  The primary path is user-triggered "prepare & compact" from COMPACT_PREPARE_PERCENT
 *  up (the UI surfaces a compact button + a one-time agent offer); auto only catches
 *  a runaway that would otherwise hard-truncate. Raised from 75% — compacting eagerly
 *  threw away ~50k of usable window on a 200k model and forced a lossy summary mid-task. */
const AUTO_COMPACT_PERCENT = 90;
/** Context-usage % at which the UI surfaces a calm "prepare & compact" offer
 *  (banner button + a one-time `compaction_offer` stream event). Below this, no
 *  compaction signal at all. */
const COMPACT_PREPARE_PERCENT = 80;

/** Per-run overrides — applied via agent setters, never mutate session state. */
export interface RunOptions {
  effort?: EffortLevel | undefined;
  thinking?: ThinkingMode | undefined;
  /** Suppress ALL tools for this run — used by compaction so the summarization
   *  turn returns the summary as TEXT instead of wandering off to a tool. */
  noTools?: boolean | undefined;
  /** Internal/system run (e.g. compaction summary) — NOT a user-initiated turn.
   *  Skips the synchronous user-message persist so an internal prompt never
   *  lands in the visible thread as a user row. */
  internal?: boolean | undefined;
  /** Fired right after each eager-persist checkpoint. The HTTP layer uses it to
   *  stamp the run buffer's current seq as `last_persisted_seq` in the run
   *  registry, so a reconnecting client can replay-then-tail from exactly the
   *  durable boundary (Tier-2 resumable re-attach, no double-render). */
  onPersistCheckpoint?: (() => void) | undefined;
}

export interface SessionOptions {
  sessionId?: string | undefined;
  model?: ModelTier | undefined;
  effort?: EffortLevel | undefined;
  thinking?: ThinkingMode | undefined;
  autonomy?: import('../types/index.js').AutonomyLevel | undefined;
  briefing?: string | undefined;
  onStream?: StreamHandler | undefined;
  promptUser?: PromptUserFn | undefined;
  promptTabs?: PromptTabsFn | undefined;
  promptSecret?: PromptSecretFn | undefined;
  tenantId?: string | undefined;
  messages?: BetaMessageParam[] | undefined;
  systemPromptSuffix?: string | undefined;
  costGuard?: import('../types/index.js').CostGuardConfig | undefined;
}

/**
 * Token/cost totals for the most recently completed run, in the UI footer's
 * convention (`tokensIn` = base input + both cache buckets). Mirrors the
 * payload `setMessageUsage` persists; exposed via `getLastRunUsage()` so the
 * HTTP API can echo it in the `done` SSE event — a fallback that lets the
 * per-message footer render even when the `turn_end` frame is lost.
 */
export interface RunUsageSummary {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  model: string;
  /** Diagnostics (opt-in UI panel): the run's id for log/Bugsink correlation
   *  and its wall-to-wall agent duration. Persisted via setMessageUsage so the
   *  diagnostics detail survives a thread resume. */
  runId?: string;
  durationMs?: number;
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
    costGuard?: import('../types/index.js').CostGuardConfig | undefined;
  } = {};
  readonly sessionId: string;
  private briefing: string | undefined;
  private _briefingConsumed = false;
  private currentRunId: string | null = null;
  /** Per-run hook fired right after each eager-persist checkpoint so the HTTP
   *  layer can record the run buffer's high-water seq as `last_persisted_seq`
   *  (Tier-2 resumable re-attach uses it as the replay `?since=`). Stashed for
   *  the run's duration; cleared in the run() finally. */
  private _onPersistCheckpoint: (() => void) | null = null;
  private runToolCallSeq = 0;
  private _userWaitMs = 0;
  private _runToolNames = new Set<string>();
  private _retrievedMemoryIds: string[] = [];
  private _changesetManager: ChangesetManager | null = null;
  private _profileOverride: import('../types/index.js').ModelProfile | null = null;
  private _isCompacting = false;
  /** One-shot guard: the "prepare & compact" offer is streamed once per fill,
   *  reset when usage drops back below COMPACT_PREPARE_PERCENT or after a
   *  compaction, so it can re-offer on the next fill but doesn't nag every turn. */
  private _compactionOffered = false;
  onStream: StreamHandler | null = null;
  private _promptUser: PromptUserFn | null = null;
  private _promptTabs: PromptTabsFn | null = null;
  private _promptSecret: PromptSecretFn | null = null;
  private _tenantId: string | null = null;
  private _skipMemoryExtractionOverride: boolean | null = null;
  /**
   * Mutable per-Session state — counters (http_request count, write_file
   * bytes) plus outbound-host approvals + in-flight prompt dedup. Owned
   * here so the same reference flows into the main Agent and every
   * spawned sub-agent — one budget + one approval set per conversation,
   * reset between sessions. Previously these lived as module-level
   * state in tools/builtin/http.ts and tools/builtin/fs.ts and grew
   * (or, in the Set/Map's case, leaked) for the lifetime of the process.
   */
  private readonly _sessionCounters: import('../types/agent.js').SessionCounters = {
    httpRequests: 0,
    writeBytes: 0,
    costUSD: 0,
    approvedOutboundDomains: new Set<string>(),
    pendingOutboundPrompts: new Map<string, Promise<boolean>>(),
  };
  private _userTimezone: string | null = null;
  /**
   * Phase 2 Context Hygiene — per-conversation store of large tool results
   * evicted at the last `compact()`. Owned here so it survives Agent
   * recreation (setModel/setEffort/_recreateAgent all rebuild the Agent);
   * the same reference is threaded into every Agent so the
   * `recall_tool_result` tool resolves handles. Cleared at the start of the
   * next `compact()` — see `compact()`.
   */
  private readonly _toolResultBlobStore = new ToolResultBlobStore();
  /**
   * H-024 shadow mode — per-conversation `ToolCallTracker` for behavioural
   * anomaly detection. Owned here (not on the Agent) so the rolling 20-call
   * window survives Agent recreation (setModel / setEffort / _recreateAgent
   * all rebuild the Agent — see _createAgent below). The same reference is
   * threaded into every Agent via `toolCallTracker` on AgentConfig so a
   * sub-agent spawn or model-switch mid-conversation doesn't reset the
   * detector's history. Shadow mode is observability-only — see the wiring
   * in agent.ts `_executeOne` for the no-block contract.
   */
  private readonly _toolCallTracker: ToolCallTracker = new ToolCallTracker();
  /** H-024 shadow-mode tracker (read-only access for agent.ts wiring + tests). */
  get toolCallTracker(): ToolCallTracker { return this._toolCallTracker; }

  // Per-session config (copied from engine.config at creation, mutated independently)
  private _registryVersion = 0;
  /**
   * Engine config-version snapshot taken at the last Agent build. If the
   * engine recreates its LLM client (Settings provider/key swap, vault
   * rotation, BYOK key change), `engine.getConfigVersion()` advances and
   * this Session rebuilds its Agent on the next run() so the new
   * apiKey/provider/baseURL propagates. Without it, a UI-side provider
   * switch updates engine.client but the long-lived Session.agent keeps
   * a stale snapshot → empty replies + footer stuck on the old provider
   * until logout (rafael 2026-05-27 BYOK provider-switch bug).
   */
  private _configVersionAtAgentBuild = 0;
  private _model: ModelTier;
  private _effort: EffortLevel;
  private _thinking: ThinkingMode | undefined;
  private _maxTokens: number | undefined;
  /** Token/cost totals of the most recently completed run; null until the
   *  first run finishes. Echoed in the `done` SSE event — see getLastRunUsage(). */
  private _lastRunUsage: RunUsageSummary | null = null;
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
    this._model = opts?.model ?? engine.config.model ?? 'balanced';
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
    this._promptSecret = opts?.promptSecret ?? null;
    this._tenantId = opts?.tenantId ?? null;
    if (opts?.systemPromptSuffix) {
      this.agentOverrides.systemPromptSuffix = opts.systemPromptSuffix;
    }
    if (opts?.autonomy) {
      this.agentOverrides.autonomy = opts.autonomy;
    }
    if (opts?.costGuard) {
      this.agentOverrides.costGuard = opts.costGuard;
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

  get promptUser(): PromptUserFn | null {
    return this._promptUser;
  }

  set promptUser(fn: PromptUserFn | null) {
    this._promptUser = fn;
    if (this.agent) {
      this.agent.promptUser = fn
        ? (q: string, opts?: string[], meta?: PromptMeta) => fn(q, opts, meta)
        : undefined;
    }
  }

  get promptTabs(): PromptTabsFn | null {
    return this._promptTabs;
  }

  set promptTabs(fn: PromptTabsFn | null) {
    this._promptTabs = fn;
    if (this.agent) {
      this.agent.promptTabs = fn
        ? (qs: TabQuestion[], meta?: PromptMeta) => fn(qs, meta)
        : undefined;
    }
  }

  get promptSecret(): PromptSecretFn | null {
    return this._promptSecret;
  }

  set promptSecret(fn: PromptSecretFn | null) {
    this._promptSecret = fn;
    if (this.agent) {
      this.agent.promptSecret = fn
        ? (name: string, prompt: string, keyType?: string, meta?: PromptMeta) => fn(name, prompt, keyType, meta)
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

  /**
   * IANA timezone of the human user (e.g. 'Europe/Zurich'). Set per request
   * by the HTTP-API /run handler from the client's
   * `Intl.DateTimeFormat().resolvedOptions().timeZone`. Threaded into the
   * per-turn `[Now: …]` marker so the model presents scheduled times in the
   * user's local wallclock instead of UTC.
   */
  get userTimezone(): string | null {
    return this._userTimezone;
  }

  set userTimezone(tz: string | null) {
    if (this._userTimezone === tz) return;
    this._userTimezone = tz;
    // Push to the live Agent so sub-agent / pipeline paths that read
    // `parentAgent.userTimezone` see the latest value without recreating
    // the agent (cheap, mutable field).
    if (this.agent) this.agent.userTimezone = tz ?? undefined;
  }

  // ── Core execution ──

  async run(task: string | unknown[], runOptions?: RunOptions): Promise<string> {
    if (!this.agent) throw new Error('Session not initialized — agent missing');

    // Hot-reload tools when registry changed (e.g. Google connected mid-session)
    if (this.engine.getRegistry().version !== this._registryVersion) {
      this._recreateAgent();
    }

    // Hot-rebuild Agent when the engine's LLM client was recreated (provider
    // swap, BYOK key rotation, vault reload). _recreateAgent constructs the
    // Agent against `this.engine.client`, so a stale snapshot means the
    // Session keeps calling the previous provider's API with the old key —
    // empty assistant replies + footer stuck on the previous provider name
    // until the session is destroyed (rafael 2026-05-27 Settings provider
    // switch from Anthropic → Mistral).
    if (this.engine.getConfigVersion() !== this._configVersionAtAgentBuild) {
      this._recreateAgent();
    }

    // Extract text for subsystems that need string (input guard, KG retrieval, run history).
    // Multimodal content (e.g. vision: image + text) is an array of content blocks.
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
          const reason = err instanceof Error ? err.message : String(err);
          // Surface the block as a `warning` SSE event so the web-UI shows a
          // distinct, localized banner/toast instead of letting the reason
          // string slip through as a `done.result` that the chat used to
          // render as total silence (rafael 2026-05-29, first-session
          // fail-closed credit check). The returned string is still the
          // single source for non-SSE callers (CLI) and the `done.result`
          // inline render fallback. `warning` (not `error`) keeps the failed
          // user turn intact — the block is transient (credit re-syncs).
          await this.onStream?.({ type: 'warning', code: 'run_blocked', detail: reason, agent: this.agent?.name ?? 'lynox' });
          return `Run blocked: ${reason}`;
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

    // The main agent always runs on the configured tier (engine.config.model,
    // Sonnet by default). There is no per-turn auto-downgrade: classifying a
    // task by its input text alone is blind to conversation context and to how
    // tool-heavy the turn becomes — a short follow-up in a research thread
    // ("gemini und search") would wrongly run multi-step web research on Haiku.
    // Tier selection belongs in explicit config (default_tier / model profiles
    // / setModel), not a heuristic.

    // Apply per-run overrides via agent setters (never mutate session state)
    const hasRunOverrides = runOptions?.effort !== undefined || runOptions?.thinking !== undefined;
    if (hasRunOverrides && this.agent) {
      if (runOptions?.effort !== undefined) this.agent.setEffort(runOptions.effort);
      if (runOptions?.thinking !== undefined) this.agent.setThinking(runOptions.thinking);
    }

    // Stash the eager-persist checkpoint hook for this run (cleared in finally).
    this._onPersistCheckpoint = runOptions?.onPersistCheckpoint ?? null;

    const model = getModelId(this._model, getActiveProvider());
    const startTime = Date.now();
    this.runToolCallSeq = 0;
    this._userWaitMs = 0;
    this._runToolNames.clear();
    this._retrievedMemoryIds = [];

    // Capture the ThreadStore message count BEFORE the run starts so the
    // end-of-run "is this the first run?" check survives eager-persist
    // (without this, eager checkpoints during the run inflate existingCount
    // and the first-run title generation never fires).
    const startMessageCount = this.engine.getThreadStore()?.getMessageCount(this.sessionId) ?? 0;

    // Compute prompt hash from the system prompt the agent uses
    let basePrompt = this._systemPrompt ?? SYSTEM_PROMPT;
    if (this.engine.config.language) {
      const langName = { de: 'German', en: 'English', fr: 'French', it: 'Italian', es: 'Spanish', nl: 'Dutch', pt: 'Portuguese', sv: 'Swedish' }[this.engine.config.language] ?? this.engine.config.language;
      basePrompt += `\n\n**Language override**: Respond in ${langName}. The user has explicitly set this preference.`;
    }
    // Mirror the prompt-assembly that _createAgent uses so the hash and the
    // recorded snapshot reflect what the Agent actually sees (Fix C, v1.5.2).
    const runIdentityContext = modelIdentityContext(
      this._profileOverride?.provider ?? this.engine.getUserConfig().provider,
      model,
    );
    const effectivePrompt = (this.agentOverrides.systemPromptSuffix
      ? basePrompt + this.agentOverrides.systemPromptSuffix
      : basePrompt) + runIdentityContext + currentDateContext();
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

    // Knowledge Graph retrieval
    // Skip for multimodal — KG retrieval operates on text queries only.
    // Skip for short clarifications (1-2 words, ≤ 20 chars) — a follow-up
    // like "bexio" or "yes please" has no semantic specificity, so top-K
    // retrieval surfaces whatever has the weakest match in memory
    // (typically stale status/learnings) and the LLM anchors to that.
    // The 2026-04-21 drift incident was exactly this cascade. Prior-turn
    // context stays visible to the LLM via conversation history; no extra
    // grounding is needed for a clarification.
    const knowledgeLayer = this.engine.getKnowledgeLayer();
    const { isShortClarification } = await import('./short-input-heuristic.js');
    const skipShortInputRetrieval = typeof task === 'string' && isShortClarification(task);
    if (knowledgeLayer && !isMultimodal && !skipShortInputRetrieval) {
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
    } else if (skipShortInputRetrieval) {
      // Clear any prior turn's retrieved context so stale memory can't
      // bleed forward as still-relevant grounding.
      this.agent.setKnowledgeContext('');
    }

    // Per-turn precise time, outside the hour-truncated cached system prompt so
    // the model gets wallclock-accuracy without breaking Anthropic's prompt
    // cache. Computed once so the durable persist below and the agent buffer
    // carry byte-identical user content (keeps the count-based eager-persist
    // delta aligned — no duplicate row).
    const userContent = withCurrentTimePrefix(task, this._userTimezone ?? undefined);

    // Seq floor for this run's footprint — captured BEFORE the durable persist
    // so the failed-turn catch flips exactly the rows this run created.
    const runStartSeq = threadStore?.getNextSeq(this.sessionId) ?? startMessageCount;

    // DURABLE USER TURN: persist the user message synchronously, before the
    // model runs. Eager-persist only checkpoints AFTER the first assistant
    // reply, so an abort/disconnect/process-restart before that first
    // checkpoint (stale-run takeover, navigate-away, queued send) used to lose
    // the user turn entirely while later assistant replies survived — the
    // continued-session prompts that vanished on reload (rafael 2026-06-04,
    // lynox Marktanalyse). Idempotent with eager-persist: the count-based
    // delta slice sees this row already on disk and skips it. Skipped for
    // internal runs (compaction summary) so a system prompt never shows as a
    // user message.
    if (threadStore && runOptions?.internal !== true) {
      try {
        const totalBefore = threadStore.getMessageCount(this.sessionId);
        threadStore.appendMessages(
          this.sessionId,
          [{ role: 'user', content: userContent as BetaMessageParam['content'] }],
          runStartSeq,
          { message_count: totalBefore + 1 },
        );
      } catch {
        // Fire-and-forget — eager-persist still covers the happy path; never
        // block the run on a persistence hiccup.
      }
    }

    try {
      const result = await this.agent.send(
        userContent,
        { suppressTools: runOptions?.noTools === true },
      );

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

      // Snapshot this run's usage in the UI footer's convention (tokensIn =
      // base input + both cache buckets). Stashed for getLastRunUsage() so the
      // HTTP API can echo it in the `done` event — a fallback that renders the
      // per-message footer even when the `turn_end` SSE frame is lost.
      const runUsage: RunUsageSummary = {
        tokensIn: tokensIn + cacheRead + cacheWrite,
        tokensOut,
        cacheRead,
        cacheWrite,
        costUsd,
        model,
        ...(this.currentRunId ? { runId: this.currentRunId } : {}),
        durationMs,
      };
      this._lastRunUsage = runUsage;

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

      // Roll up run-level fields. After F-Eager-Persist, `_persistMessages`
      // has typically already appended every message + updated message_count
      // during the run, so `appendMessages` here is normally a no-op. We
      // still ALWAYS write the cost / token rollup (eager-persist doesn't
      // know token counts; those are only computed here at run-end) plus
      // the first-run title — both gated on the START count, not the now
      // (`startMessageCount === 0` = "thread was empty when this run began").
      if (threadStore) {
        try {
          const allMessages = this.saveMessages();
          // Slice against the API-row count (display-only B-full notes aren't
          // in agent.messages); start new seqs at the total row count so they
          // sort after any interleaved display note. Identical until a failed
          // turn has persisted a note. See eager-persist.ts for the rationale.
          const apiCount = threadStore.getApiMessageCount(this.sessionId);
          const totalCount = threadStore.getMessageCount(this.sessionId);
          const newMessages = allMessages.slice(apiCount);
          // Per-thread cost/tokens = SUM over run_history for this session (the
          // single source of truth), NOT this run's cost. The column used to be
          // overwritten with the last run's cost each turn, so a multi-turn
          // thread under-reported its spend (rafael 2026-06-04). This run is
          // already recorded in run_history (updateRun above), so the sum
          // includes it; stamping it here self-heals historically-wrong rows.
          const threadTotals = runHistory ? runHistory.getThreadTotals(this.sessionId) : null;
          const rollupTokens = threadTotals
            ? threadTotals.tokens_in + threadTotals.tokens_out
            : this.usage.input_tokens + this.usage.output_tokens;
          const rollupCost = threadTotals ? threadTotals.cost_usd : costUsd;
          if (newMessages.length > 0) {
            // Combined append + rollup in one transaction (P1). Seqs start at
            // MAX(seq)+1 (deletion-safe), message_count tracks total rows.
            threadStore.appendMessages(this.sessionId, newMessages, threadStore.getNextSeq(this.sessionId), {
              message_count: totalCount + newMessages.length,
              total_tokens: rollupTokens,
              total_cost_usd: rollupCost,
            });
          } else {
            // Eager already persisted — just stamp the cost/token rollup.
            threadStore.updateThread(this.sessionId, {
              total_tokens: rollupTokens,
              total_cost_usd: rollupCost,
            });
          }
          if (startMessageCount === 0) {
            const title = generateThreadTitle(taskText);
            threadStore.updateThread(this.sessionId, { title });
          }
          // Stamp this run's token/cost totals onto its final assistant
          // message so the per-message footer survives a thread resume.
          threadStore.setMessageUsage(this.sessionId, JSON.stringify(runUsage));
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

      // B-full: persist the failed turn as DISPLAY-ONLY so it survives reload
      // ("null Mitteilung" fix) WITHOUT lingering in the model's API context.
      // The agent already rolled its in-memory context back to before the
      // failed turn; here we (1) flip any rows this run eager-persisted to
      // display-only so the disk matches that rollback, (2) ensure the failed
      // user message survives in display history, and (3) append a structured,
      // localizable failure note. None of these re-enter the prompt because the
      // resume hydration filters display_only=1 (session-store.ts).
      persistFailedTurnDisplay({
        // runStartSeq is the seq of this run's first row (the durably-persisted
        // user message). Flipping from here marks exactly this run's footprint
        // display-only — and won't double-add the user message (already on disk).
        threadStore,
        sessionId: this.sessionId,
        startSeq: runStartSeq,
        task,
        error: err,
      });

      throw err;
    } finally {
      this.currentRunId = null;
      this._onPersistCheckpoint = null;
      if (this.agent) {
        this.agent.currentRunId = undefined;
        // Restore per-run overrides to session defaults
        if (hasRunOverrides) {
          this.agent.setEffort(this._effort);
          this.agent.setThinking(this._thinking ?? { type: 'adaptive' });
        }
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
  async compact(focus?: string, opts?: { confirmScope?: boolean }): Promise<{ success: boolean; summary: string }> {
    // Phase 2 Context Hygiene: clear blobs retained at the *previous*
    // compaction first. A blob is recallable only until the next compaction —
    // this clear is what hard-drops the prior window and is the sole bound on
    // the store's memory (it can never grow across more than one window).
    this._toolResultBlobStore.clear();

    // Snapshot the pre-summary history. Large tool results live here; the
    // summary run below only *appends* (the summary prompt + reply), so the
    // snapshot still captures every result that is about to be reset away.
    const preCompactionMessages = this.saveMessages();

    // Structured compaction: a lossy prose summary used to drop artifacts and
    // open tasks, leaving the agent unable to continue. Name what must survive.
    const base = 'Summarize the conversation so far so work can continue without the full history. Reply with the summary itself as plain text — do NOT call any tool and do NOT save it as an artifact; this text IS the surviving context. Keep, as compact bullet points: decisions made (and why), artifacts created (keep their titles/ids), open tasks and the immediate next step, and concrete facts the user provided. Drop small talk and resolved detours.';
    const prompt = focus ? `${base}\nGive extra weight to: ${focus}.` : base;
    let summary = '';
    try {
      // noTools: the summary MUST come back as text. With tools available the
      // agent would sometimes save the summary as an artifact and reply with a
      // useless pointer ("saved as artifact …"), so the injected context lost
      // the open task and continuity broke (observed live 2026-06-03).
      summary = await this.run(prompt, { noTools: true, internal: true });
    } catch {
      // Compaction prompt failed — reset anyway to free context
    }

    // Evict large tool results into the blob store BEFORE the reset, so the
    // verbatim payloads survive the history wipe and stay recallable via
    // `recall_tool_result`. Eviction runs only here (O4/O5) — never
    // mid-conversation — so the warm prompt cache is untouched between turns.
    const thresholdChars = this.engine.getUserConfig().tool_result_blob_threshold_chars
      ?? DEFAULT_TOOL_RESULT_BLOB_THRESHOLD_CHARS;
    const handles = this._toolResultBlobStore.evictFrom(preCompactionMessages, thresholdChars);

    this.reset();
    if (summary) {
      this.loadMessages(
        buildPostCompactionMessages(summary, handles, { confirmScope: opts?.confirmScope }),
      );
      // Persist the visible marker for BOTH paths (auto + manual /compact) so a
      // user-triggered compaction is just as transparent on reload/export as an
      // automatic one. Best-effort — never block. (The live UI marker is streamed
      // by _autoCompactIfNeeded for auto, and pushed by compactNow() for manual.)
      persistCompactionMarker(this.engine.getThreadStore(), this.sessionId);
      return { success: true, summary };
    }
    return { success: false, summary: '' };
  }

  /**
   * Estimate current context usage percentage.
   * Sources occupancy from the agent's last real API usage when available (the
   * exact figure the UI meter shows) so auto-compaction triggers on true
   * occupancy — not a char-estimate that over-counts JSON overhead. Applies the
   * user's `max_context_window_tokens` cap via the effectiveContextWindow SSOT.
   */
  getContextUsagePercent(): number {
    if (!this.agent) return 0;
    const estimatedTokens = this.agent.getEstimatedOccupancyTokens();
    const userCap = this.engine.getUserConfig().max_context_window_tokens;
    // agent.model may carry a [1m] suffix; MODEL_MAP[tier] would strip it.
    const maxCtx = effectiveContextWindow(this.agent.model, userCap);
    return Math.round(estimatedTokens / maxCtx * 100);
  }

  /**
   * After each run(), manage context pressure in two tiers:
   *  - ≥ AUTO_COMPACT_PERCENT (90): last-resort auto-compact (with confirmScope)
   *    so a runaway never hard-truncates.
   *  - [COMPACT_PREPARE_PERCENT, AUTO): offer "prepare & compact" ONCE (a stream
   *    event the UI surfaces as a calm suggestion + button) so the USER compacts
   *    at a good moment instead of the system silently doing it mid-task.
   * Guard flag prevents recursion since compact() calls run().
   */
  private async _autoCompactIfNeeded(): Promise<void> {
    if (this._isCompacting || !this.agent) return;
    const usagePercent = this.getContextUsagePercent();

    // Below the prepare point: nothing to do; arm the one-shot offer for the
    // next time the context fills up again.
    if (usagePercent < COMPACT_PREPARE_PERCENT) {
      this._compactionOffered = false;
      return;
    }

    // Prepare zone [80, 90): offer once, never auto-compact — the user (or a
    // fresh turn) triggers compactNow() at a moment that suits them.
    if (usagePercent < AUTO_COMPACT_PERCENT) {
      if (!this._compactionOffered) {
        this._compactionOffered = true;
        if (this.onStream) {
          void this.onStream({ type: 'compaction_offer', usagePercent, agent: this.agent.name });
        }
      }
      return;
    }

    // Safety net (≥90): the user ignored the offer and kept going — compact now
    // to avoid hard truncation.
    this._isCompacting = true;
    try {
      // confirmScope: this compaction fires mid-task (unprompted), so steer the
      // agent to restate the task and confirm scope on its next turn instead of
      // silently rebuilding from the lossy summary.
      const result = await this.compact(undefined, { confirmScope: true });
      if (result.success) {
        this._compactionOffered = false;
        // compact() already persisted the visible marker; here we also stream
        // the live context_compacted event (the SSE is active during auto-compaction).
        if (this.onStream) {
          void this.onStream({
            type: 'context_compacted',
            summary: result.summary,
            previousUsagePercent: usagePercent,
            agent: this.agent.name,
          });
        }
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

  /**
   * F-Eager-Persist: append any new messages from `agent.messages` into the
   * ThreadStore. Called from the Agent's `onMessageCheckpoint` hook after
   * every stable turn boundary. Idempotent — `getApiMessageCount` gives the
   * persisted API floor to slice `agent.messages` against, while new rows take
   * their seq from the total `getMessageCount` (so B-full display-only rows
   * can't misalign the delta). See eager-persist.ts.
   *
   * Safe to call concurrently (better-sqlite3 serialises writes within a
   * single process) and from the end-of-run persist block — if both fire
   * back-to-back, the second sees an updated floor and appends an empty delta.
   */
  private _persistMessages(): void {
    if (!this.agent) return;
    // Outcome is intentionally ignored — fire-and-forget contract; helper
    // catches its own errors and returns an outcome enum for tests only.
    persistAgentMessages({
      threadStore: this.engine.getThreadStore(),
      sessionId: this.sessionId,
      allMessages: this.agent.getMessages(),
    });
    // Stamp the durable boundary (run buffer high-water seq) into the run
    // registry so a reconnecting client replays from exactly here (Tier 2).
    // After persistAgentMessages so the seq can never claim more is durable
    // than actually was. Best-effort — never let a checkpoint hook break a run.
    if (this._onPersistCheckpoint) {
      try { this._onPersistCheckpoint(); } catch { /* checkpoint hook is additive */ }
    }
  }

  // ── Model / Effort / Thinking ──

  setModel(tier: ModelTier): string {
    const messages = this.saveMessages();
    this._model = tier;
    this._createAgent();
    this.loadMessages(messages);
    return getModelId(tier, getActiveProvider());
  }

  getModelTier(): ModelTier {
    return this._model;
  }

  /** Token/cost totals of the most recently completed run, or null if no run
   *  has finished. The HTTP API echoes this in the `done` SSE event so the
   *  live per-message footer survives a lost `turn_end` frame. */
  getLastRunUsage(): RunUsageSummary | null {
    return this._lastRunUsage;
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
    /** Named model profile — overrides provider to OpenAI-compatible for this session. */
    profile?: string | undefined;
  }): void {
    this.agentOverrides = overrides ?? {};
    // Resolve model profile override if specified
    if (overrides?.profile) {
      const profiles = this.engine.getUserConfig().model_profiles;
      const profile = profiles?.[overrides.profile];
      if (!profile) throw new Error(`Unknown model profile "${overrides.profile}". Available: ${Object.keys(profiles ?? {}).join(', ') || 'none'}.`);
      this._profileOverride = profile;
    } else {
      this._profileOverride = null;
    }
    const messages = this.saveMessages();
    this._createAgent();
    this.loadMessages(messages);
  }

  private _createAgent(): void {
    const engine = this.engine;
    const userConfig = engine.getUserConfig();
    const registry = engine.getRegistry();
    this._registryVersion = registry.version;
    // Snapshot the engine's LLM-client version at the same moment the Agent
    // captures engine.client — `run()` compares this against
    // engine.getConfigVersion() to detect a swap and trigger a rebuild.
    this._configVersionAtAgentBuild = engine.getConfigVersion();
    const pluginManager = engine.getPluginManager();
    const toolContext = engine.getToolContext();

    // Keep tool context in sync
    toolContext.tools = registry.getEntries();
    toolContext.streamHandler = this.onStream ?? null;

    const model = getModelId(this._model, getActiveProvider());
    const entries = registry.getEntries();
    const tools = pluginManager
      ? entries.map(entry => ({
          definition: entry.definition,
          requiresConfirmation: entry.requiresConfirmation,
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
    // Honesty-fallback for web-search availability — prevents the silent-
    // fabrication failure mode where the agent invents arxiv IDs / news /
    // prices instead of telling the user the capability is missing.
    //  - 'none'      → `web_research` not registered at all (no SearXNG
    //                  AND DDG fallback init also failed). Hard-refuse
    //                  with explicit "how to enable" guidance.
    //  - 'fallback'  → DDG HTML-scrape registered. Tool works but is
    //                  best-effort; warn the agent to caveat findings.
    //  - 'configured'→ SearXNG wired. No suffix needed.
    const webSearchStatus = engine.getWebSearchStatus();
    if (webSearchStatus === 'none') {
      basePrompt += NO_WEB_SEARCH_PROMPT_SUFFIX;
    } else if (webSearchStatus === 'fallback') {
      basePrompt += WEB_SEARCH_FALLBACK_PROMPT_SUFFIX;
    }
    // Anchor the model identity so a third-party adapter (Mistral, custom)
    // doesn't hallucinate "I am Claude Haiku" from training-data bias.
    const identityContext = modelIdentityContext(
      this._profileOverride?.provider ?? userConfig.provider,
      model,
    );
    const systemPrompt = (this.agentOverrides.systemPromptSuffix
      ? basePrompt + this.agentOverrides.systemPromptSuffix
      : basePrompt) + identityContext + currentDateContext();

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
      thinking: this._thinking,
      effort: this._effort,
      maxTokens: this._maxTokens,
      memory: engine.getMemory() ?? undefined,
      costGuard: this.agentOverrides.costGuard,
      onStream: streamHandler,
      // F-Eager-Persist (2026-05-18): Persist messages to the ThreadStore at
      // each stable point in the agent loop (after assistant reply, after
      // tool_results). Without this the end-of-run persist (line 506-526)
      // was the ONLY save point — a container restart / OOM kill mid-loop
      // lost every turn since the last completed run. Idempotent: each
      // checkpoint reads existingCount from SQLite and only appends the
      // delta, so duplicate fires are no-ops.
      onMessageCheckpoint: () => this._persistMessages(),
      promptUser: this._promptUser
        ? (q: string, opts?: string[], meta?: PromptMeta) => this._promptUser!(q, opts, meta)
        : undefined,
      promptTabs: this._promptTabs
        ? (qs: TabQuestion[], meta?: PromptMeta) => this._promptTabs!(qs, meta)
        : undefined,
      promptSecret: this._promptSecret
        ? (name: string, prompt: string, keyType?: string, meta?: PromptMeta) => this._promptSecret!(name, prompt, keyType, meta)
        : undefined,
      maxIterations: this.agentOverrides.maxIterations,
      continuationPrompt: this.agentOverrides.continuationPrompt,
      // Merge user-disabled tools (Settings → Integrations → Tool Toggles)
      // with any session-specific excludes. Server-side enforcement: the
      // Agent never sees disabled tools so a prompt-injected agent cannot
      // call them — stronger than a runtime "tool disabled" error.
      excludeTools: [
        ...(userConfig.disabled_tools ?? []),
        ...(this.agentOverrides.excludeTools ?? []),
      ],
      // User-preferred max context window — clamps the agent's trim budget
      // below the model's native window (LLM Advanced UI offers 200k/500k/1M
      // at `/app/settings/llm/advanced` post P3-PR-X).
      maxContextWindowTokens: userConfig.max_context_window_tokens,
      // Provider-aware key resolution via [[provider-keys]] — pre-1.5.2 this
      // read `userConfig.api_key` directly, which is empty for Mistral/Custom.
      apiKey: this._profileOverride?.api_key ?? resolveProviderApiKey({
        provider: this._profileOverride?.provider ?? userConfig.provider,
        secretStore: engine.getSecretStore(),
        userConfig,
      }),
      apiBaseURL: this._profileOverride?.api_base_url ?? userConfig.api_base_url,
      provider: this._profileOverride?.provider ?? userConfig.provider,
      gcpProjectId: userConfig.gcp_project_id,
      gcpRegion: userConfig.gcp_region,
      openaiModelId: this._profileOverride?.model_id ?? userConfig.openai_model_id,
      briefing: this._briefingConsumed ? undefined : this.briefing,
      autonomy: this.agentOverrides.autonomy,
      secretStore: engine.getSecretStore() ?? undefined,
      userId: engine.getUserId() ?? undefined,
      activeScopes: engine.getActiveScopes().length > 0 ? engine.getActiveScopes() : undefined,
      changesetManager: this._changesetManager ?? undefined,
      toolContext,
      sessionCounters: this._sessionCounters,
      // Phase 2: same blob-store reference across every Agent recreation so
      // `recall_tool_result` resolves handles minted by a prior `compact()`.
      toolResultBlobStore: this._toolResultBlobStore,
      // H-024 shadow mode: same tracker reference across Agent recreation so
      // the rolling 20-call window survives setModel / setEffort / spawn paths.
      toolCallTracker: this._toolCallTracker,
      userTimezone: this._userTimezone ?? undefined,
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
