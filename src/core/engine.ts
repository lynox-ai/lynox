import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { createLLMClient, initLLMProvider } from './llm-client.js';
import { resolveProviderApiKey, enrichTierSetCreds } from './llm/provider-keys.js';
import { evaluateEndpointBootGate, buildBootRefusalMessage, buildBootAcceptedWarning } from './llm/endpoint-allowlist.js';
import type {
  LynoxConfig,
  LynoxUserConfig,
  ToolEntry,
  BatchRequest,
  BatchResult,
  ModelTier,
  ContextSource,
} from '../types/index.js';
import { MODEL_MAP, getOpenAIModelMap, setOpenAIModelResolver, resolveBalancedModel, setBalancedModelResolver, clampTier, normalizeTier } from '../types/index.js';
import { setTierSetResolver } from './tier-resolver.js';
import type { Memory } from './memory.js';
import { BatchIndex } from './batch-index.js';
import { ToolRegistry } from '../tools/registry.js';
import { loadConfig, getLynoxDir } from './config.js';
import { readEnvAlias } from './env.js';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
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
  editFileTool,
  memoryStoreTool,
  memoryRecallTool,
  memoryDeleteTool,
  memoryUpdateTool,
  memoryListTool,
  memoryPromoteTool,
  spawnAgentTool,
  askUserTool,
  askSecretTool,
  batchFilesTool,
  httpRequestTool,
  runWorkflowTool,
  updateWorkflowTool,
  exportWorkflowTool,
  importWorkflowTool,
  diagnoseWorkflowTool,
  taskCreateTool,
  taskUpdateTool,
  taskListTool,
  planTaskTool,
  dataStoreCreateTool,
  dataStoreInsertTool,
  dataStoreQueryTool,
  dataStoreListTool,
  dataStoreDeleteTool,
  dataStoreDropTool,
  contactsSaveTool,
  contactsSearchTool,
  saveWorkflowTool,
  apiSetupTool,
  artifactSaveTool,
  artifactListTool,
  artifactDeleteTool,
  artifactHistoryTool,
  artifactRestoreTool,
  recallToolResultTool,
  setThreadContextTool,
  subjectsMergeTool,
  mediaProcessTool,
} from '../tools/builtin/index.js';
import type { ToolContext } from './tool-context.js';
import { createToolContext } from './tool-context.js';
import {
  configureBudgetAndRateLimits,
  generateInitBriefing,
  initSecrets,
  ensureVaultKey,
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
import { escalateToUser as runEscalation, type EscalateOpts } from './escalation.js';
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
const INTELLIGENCE_INTERVAL = 10; // Run KPIs every N runs

/**
 * Default the inbox classifier's LLM region from the user's main provider
 * choice. Env override `LYNOX_INBOX_LLM_REGION` always wins (explicit
 * override path for managed-EU tenants who want hard-pinning regardless
 * of UI). When the user picked Mistral in Settings (api.mistral.ai), the
 * classifier inherits 'eu' automatically — pre-this-fix the classifier
 * always defaulted to 'us' (Anthropic) regardless of the UI choice,
 * leaking mail snippets + reply-draft bodies to Anthropic-US.
 *
 * Hostname-strict match (URL().hostname === 'api.mistral.ai') — a naive
 * substring would let an attacker-controlled `api.mistral.ai.evil.com`
 * misclassify as EU residency.
 */
export function resolveInboxLlmRegion(opts: {
  envOverride: string | undefined;
  provider: import('../types/index.js').LLMProvider | undefined;
  apiBaseURL: string | undefined;
}): 'us' | 'eu' {
  if (opts.envOverride === 'eu') return 'eu';
  if (opts.envOverride === 'us') return 'us';
  if (opts.provider !== 'openai' || !opts.apiBaseURL) return 'us';
  let hostname: string;
  try {
    hostname = new URL(opts.apiBaseURL).hostname.toLowerCase();
  } catch {
    return 'us';
  }
  return hostname === 'api.mistral.ai' ? 'eu' : 'us';
}

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
  /**
   * Foundation Rework v2 (S0): the consolidated subject-graph store (engine.db).
   * Provisioned EMPTY alongside the legacy DBs — no store reads/writes it yet
   * (S1 re-points the read/write paths). Null when init fails (graceful degrade).
   */
  private engineDb: EngineDb | null = null;
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
  /**
   * Monotonic counter incremented every time the LLM client is rebuilt via
   * `_recreateClient` — covers `reloadUserConfig`, `reloadCredentials`,
   * `setApiKey`, and any other path that swaps the underlying client. Long-
   * lived Sessions snapshot this at Agent-build time and re-create their
   * Agent on the next `run()` if the engine's version has advanced. Without
   * it, a provider/credential change propagates to the engine but the
   * Session keeps an Agent bound to the stale key — empty assistant replies
   * + footer stays on the previous provider until logout (rafael 2026-05-27).
   */
  private _configVersion = 0;
  /** Tracks which web-search provider (if any) is wired into the registry.
   *  - 'configured' — SearXNG registered (sidecar or self-hosted URL), full quality.
   *  - 'fallback'   — embedded DuckDuckGo HTML-scrape fallback (best-effort).
   *  - 'none'       — no provider registered; `web_research` tool absent.
   *  Session reads this to append the right honesty-fallback prompt suffix
   *  so the agent doesn't silently fabricate search results when search
   *  is unavailable. */
  private _webSearchStatus: 'configured' | 'fallback' | 'none' = 'none';
  private _dataStore: DataStore | null = null;
  private _taskManager: import('./task-manager.js').TaskManager | null = null;
  private _hooks: LynoxHooks[] = [];
  private _toolContext: ToolContext;
  private _googleAuth: import('../integrations/google/google-auth.js').GoogleAuth | null = null;
  private _mailContext: import('../integrations/mail/context.js').MailContext | null = null;
  private _scheduledSendPoller: import('../integrations/mail/mail-scheduled-poller.js').ScheduledSendPoller | null = null;
  private _inboxRuntime: import('../integrations/inbox/bootstrap.js').InboxRuntime | null = null;
  private _mailStateDb: import('../integrations/mail/state.js').MailStateDb | null = null;
  private _inboxLlmRegion: 'us' | 'eu' | null = null;
  private _inboxRebootstrapInflight: Promise<void> | null = null;
  /**
   * H-012 follow-up — drain-window privacy guard. While the engine is
   * mid-rebootstrap on a cross-region provider switch (e.g. Anthropic-US
   * → Mistral-EU), `await old.shutdown()` can take seconds. New mail
   * arriving via the MailContext watcher during that window would
   * otherwise still fire into the OLD US runtime's hook closure —
   * GDPR Art. 44+ transfer if the user explicitly switched to EU
   * residency. Suspension flips on BEFORE the shutdown await and clears
   * AFTER the new runtime is wired (or in the `finally` on bootstrap
   * failure). Mail server keeps mails unread so the next polling cycle
   * picks them up via the NEW runtime.
   */
  private _inboxClassifierSuspended: boolean = false;
  private _lastBatchParentId: string | null = null;
  private runCount = 0;
  private _notificationRouter = new NotificationRouter();
  private _workerLoop: WorkerLoop | null = null;
  private _backupManager: import('./backup.js').BackupManager | null = null;
  private _apiStore: import('./api-store.js').ApiStore | null = null;
  private _artifactStore: import('./artifact-store.js').ArtifactStore | null = null;
  private _crm: import('./crm.js').CRM | null = null;
  private _subjectStore: import('./subject-store.js').SubjectStore | null = null;
  private _subjectFootprintReader: import('./subject-footprint-reader.js').SubjectFootprintReader | null = null;
  private _threadStore: import('./thread-store.js').ThreadStore | null = null;
  private _promptStore: import('./prompt-store.js').PromptStore | null = null;
  private _promptCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private _runRegistry: import('./run-registry.js').RunRegistry | null = null;
  private _runBufferManager: import('./run-buffer.js').RunBufferManager | null = null;
  private _runExecutor: import('./run-executor.js').RunExecutor | null = null;

  constructor(config: LynoxConfig) {
    this.userConfig = loadConfig();
    // Apply user config defaults if not already set in LynoxConfig. The
    // main-chat tier comes from `default_tier` (the "Main chat model" picker),
    // clamped to `max_tier` (G3) so a user pick can never exceed the CP cost
    // ceiling. normalizeTier accepts legacy brand names in an old config.json.
    if (!config.model) {
      config.model = clampTier(normalizeTier(this.userConfig.default_tier) ?? 'balanced', this.userConfig.max_tier);
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
    const resolvedModel = MODEL_MAP[config.model ?? 'balanced'];
    if (resolvedModel && resolvedModel.includes('haiku')) {
      config.thinking = undefined;
    }
    this.config = config;
    // Always create standard Anthropic client in constructor.
    // For non-Anthropic providers (vertex / openai-compat / Mistral) init()
    // rebuilds the client with the right SDK once user config is loaded.
    //
    // Defensive try/catch (added 2026-05-27 after meridian-demo crash-loop):
    // even though llm-client.ts is now lenient at boot, ANY future strict
    // boot-time check that fires here would crash-loop the container and
    // prevent BYOK customers from reaching SetupBanner. Belt + suspenders:
    // fall back to a placeholder Anthropic client if construction throws.
    try {
      this.client = createLLMClient({
        apiKey: this.userConfig.api_key,
        apiBaseURL: this.userConfig.api_base_url,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(`[engine] LLM client init failed: ${msg} — booting in browse-only mode until user configures via SetupBanner`);
      this.client = createLLMClient({ provider: 'anthropic', apiKey: '' });
    }

    this._toolContext = createToolContext(this.userConfig);
    // The Engine is the managed credit host: in-run tool helpers that spend the
    // pool key on a separate stream (rerank / plan_task / api_setup) debit their
    // marginal cost through it. No-op on self-host / BYOK (no hooks registered).
    this._toolContext.meteredHost = this;
  }

  getUserConfig(): LynoxUserConfig {
    return this.userConfig;
  }

  /** Reload config from disk, update cached reference, and recreate API client if credentials/provider changed. */
  async reloadUserConfig(): Promise<void> {
    const oldKey = this.userConfig.api_key;
    const oldBase = this.userConfig.api_base_url;
    const oldProvider = this.userConfig.provider;
    // Snapshot Bugsink active-state under the OLD config before swapping —
    // see `_reconcileBugsink` for why both sides matter.
    const oldDsn = process.env['LYNOX_BUGSINK_DSN'] ?? this.userConfig.bugsink_dsn;
    const oldBugsinkActive = !!oldDsn && this.userConfig.bugsink_enabled !== false;
    // Validate-before-commit: install the candidate, run the endpoint gate, and
    // roll back to the prior config if it refuses — a rejected `api_base_url`
    // must NOT leave the engine holding the poisoned config (the gate reads
    // `this.userConfig`, so we assign first, then restore on throw).
    const candidateConfig = loadConfig();
    const prevConfig = this.userConfig;
    this.userConfig = candidateConfig;
    // Wave 5d BYOK liability gate — defense-in-depth: re-evaluate the
    // allowlist BEFORE the LLM client is recreated against the new config.
    // The HTTP PUT /api/config handler pre-checks via `evaluateEndpointBootGate`
    // so it can 400 without exception-as-control-flow, but if any other
    // mutation path (config.json edit + SIGHUP, vault rotation, future admin
    // tooling) installs a non-allowlisted `api_base_url`, this gate still
    // catches it before the client swap. Throws on `refuse`; caller catches.
    try {
      this._enforceEndpointAllowlist();
    } catch (e) {
      this.userConfig = prevConfig;
      throw e;
    }
    const newProvider = this.userConfig.provider;
    // Re-sync the provider resolvers (openai tier-map + the hybrid tier_set) on
    // EVERY reload — a routing_mode/tier_set-only change carries no credential
    // delta but must still take effect. Idempotent; safe to call always; runs
    // before the client swap below.
    this._configureOpenAIResolver();
    // G1: `config.model` (the main-chat tier) is assigned from `default_tier`
    // in the ctor ONLY — re-sync it here so a runtime "Main chat model" change
    // (PUT /api/config { default_tier }) takes effect WITHOUT a process restart.
    // Clamped to `max_tier` (G3) so a user pick can't exceed the CP cost ceiling.
    // New sessions pick this up via `session._model`; open sessions keep their
    // persisted per-thread tier (no cache-prefix churn).
    this.config.model = clampTier(normalizeTier(this.userConfig.default_tier) ?? 'balanced', this.userConfig.max_tier);
    // Recreate API client if credentials or provider changed
    if (this.userConfig.api_key !== oldKey || this.userConfig.api_base_url !== oldBase || newProvider !== oldProvider) {
      // Provider switch: load new SDK if needed
      if (newProvider && newProvider !== oldProvider) {
        await initLLMProvider(newProvider);
      }
      this._recreateClient();
    }
    // Tear down / bring up Bugsink on toggle transition. Without this, the
    // GDPR opt-out the Settings → Privacy toggle promises wouldn't hold —
    // Sentry would keep flushing breadcrumbs + the uncaughtException handler
    // would survive until process restart.
    await this._reconcileBugsink(oldBugsinkActive);
  }

  /**
   * Force-refresh the LLM client + openai tier resolver from the live config
   * + vault. Used by `/api/secrets/:slot` writes where only the vault changed
   * — `reloadUserConfig` skips `_recreateClient` because no config.json field
   * differs, so without this path the engine's `this.client` (used by KG
   * init + batch) would keep a stale key after a BYOK rotation.
   */
  async reloadCredentials(): Promise<void> {
    // Validate-before-commit (symmetric with `reloadUserConfig`): install the
    // candidate, gate it, roll back on refuse so a rejected endpoint never
    // survives in `this.userConfig`.
    const candidateConfig = loadConfig();
    const prevConfig = this.userConfig;
    this.userConfig = candidateConfig;
    // Wave 5d BYOK liability gate — defense-in-depth re-check (symmetric with
    // `reloadUserConfig` and the engine-boot gate). A vault rotation that
    // changes the resolved provider's base_url, or any code-path that lands
    // a non-allowlisted endpoint into `loadConfig()` output without going
    // through PUT /api/config, must still be blocked before the new LLM
    // client is built. Throws on `refuse`; caller catches.
    try {
      this._enforceEndpointAllowlist();
    } catch (e) {
      this.userConfig = prevConfig;
      throw e;
    }
    if (this.userConfig.provider && this.userConfig.provider !== 'anthropic') {
      await initLLMProvider(this.userConfig.provider);
    }
    this._configureOpenAIResolver();
    this._recreateClient();
  }

  /** Toggle Bugsink based on the new config — extracted so `_initBootstrap` and `reloadUserConfig` share the bring-up path. */
  private async _initBugsink(): Promise<void> {
    const errorDsn = process.env['LYNOX_BUGSINK_DSN'] ?? this.userConfig.bugsink_dsn;
    const bugsinkEnabled = this.userConfig.bugsink_enabled !== false;
    if (!errorDsn || !bugsinkEnabled) return;
    try {
      const { initErrorReporting, installGlobalHandlers } = await import('./error-reporting.js');
      const errorReportingActive = await initErrorReporting(errorDsn);
      if (errorReportingActive) {
        installGlobalHandlers();
        // Subscribe to tool:end channel for automatic breadcrumbs
        const { channels: obsChannels } = await import('./observability.js');
        const { addToolBreadcrumb } = await import('./error-reporting.js');
        obsChannels.toolEnd.subscribe((msg: unknown) => {
          const data = msg as { name?: string; success?: boolean; duration?: number } | undefined;
          if (data?.name) {
            addToolBreadcrumb(String(data.name), Boolean(data.success), typeof data.duration === 'number' ? data.duration : 0);
          }
        });
      }
    } catch {
      // Bugsink init failed — non-critical, continue without it
    }
  }

  /** Compare desired Bugsink state against the prior active state and reconcile. */
  private async _reconcileBugsink(oldActive: boolean): Promise<void> {
    const newDsn = process.env['LYNOX_BUGSINK_DSN'] ?? this.userConfig.bugsink_dsn;
    const newActive = !!newDsn && this.userConfig.bugsink_enabled !== false;
    if (oldActive === newActive) return;
    if (newActive) {
      await this._initBugsink();
    } else {
      const { shutdownErrorReporting } = await import('./error-reporting.js');
      await shutdownErrorReporting();
    }
  }

  /** Update API key at runtime (e.g. after saving via web UI) and recreate the client. */
  setApiKey(key: string): void {
    this.userConfig.api_key = key;
    this._recreateClient();
  }

  private _recreateClient(): void {
    // Provider-aware key resolution: openai → MISTRAL_API_KEY slot, custom
    // → CUSTOM_API_KEY, anthropic → ANTHROPIC_API_KEY (+ legacy config.api_key
    // fallback). Vertex returns undefined — its auth is GCP OAuth.
    //
    // The pre-1.5.2 code always read the ANTHROPIC_API_KEY slot regardless
    // of provider, so a Mistral switch on a host without an Anthropic env
    // fallback authenticated the OpenAI adapter with an empty / wrong key
    // (rafael-prod incident 2026-05-18).
    const apiKey = resolveProviderApiKey({
      provider: this.userConfig.provider,
      // The endpoint decides the slot. Without it, every `provider:'openai'`
      // endpoint (Mistral, Groq, Together, a local Ollama) would draw from the
      // same vault slot — i.e. a Mistral key would be bearer-tokened to Groq.
      apiBaseURL: this.userConfig.api_base_url,
      secretStore: this.secretStore,
      userConfig: this.userConfig,
    });
    // Mirror the resolved Anthropic key into process.env so secondary SDK
    // instances (llm-helper's `callForStructuredJson` for the api_setup
    // docs_url bootstrap, etc.) pick it up. Only for Anthropic — for
    // openai/custom the adapter consumes the key directly via constructor,
    // and we must NOT leak a Mistral/custom key into ANTHROPIC_API_KEY.
    if (apiKey && this.userConfig.provider === 'anthropic') {
      process.env['ANTHROPIC_API_KEY'] = apiKey;
    }
    // Vertex AI: resolve GCP credentials from env > vault > config
    const gcpProjectId = process.env['GCP_PROJECT_ID']
      ?? process.env['ANTHROPIC_VERTEX_PROJECT_ID']
      ?? this.secretStore?.resolve('GCP_PROJECT_ID')
      ?? this.userConfig.gcp_project_id;
    const gcpRegion = process.env['CLOUD_ML_REGION']
      ?? this.userConfig.gcp_region;
    this.client = createLLMClient({
      provider: this.userConfig.provider,
      apiKey,
      apiBaseURL: this.userConfig.api_base_url,
      gcpProjectId,
      gcpRegion,
      openaiModelId: this.userConfig.openai_model_id,
    });
    // Mirror of the registry-version pattern (see Session._registryVersion).
    // Long-lived Sessions check this at run() to decide whether their cached
    // Agent (which captured apiKey/baseURL/provider at construction) is stale.
    this._configVersion++;
    this._propagateProviderSwitch(apiKey);
  }

  /**
   * Snapshot of the LLM-client version Sessions compare against to detect
   * a credential/provider swap that happened after their Agent was built.
   * See `_configVersion` for the full rationale.
   */
  getConfigVersion(): number {
    return this._configVersion;
  }

  /**
   * Push the freshly created LLM client into Memory + KnowledgeLayer + the
   * unified-inbox classifier so any client recreation (UI provider-switch,
   * BYOK key rotation, vault reload) propagates instead of leaving stale
   * clients on the old provider — a GDPR / EU-residency leak path: Memory
   * consolidation + KG entity-extraction + HyDE retrieval + inbox classifier
   * all embed user content in LLM prompts.
   *
   * Inbox path (H-012): when the effective region (resolveInboxLlmRegion of
   * the new provider) differs from the bound region, the runtime is torn
   * down and re-bootstrapped — InboxRuntime closes over a region-pinned
   * LLMCaller at bootstrap time, so swapping the inner client in place is
   * not possible. The rebootstrap is async + fire-and-forget; tests +
   * shutdown await `_inboxRebootstrapInflight` for determinism.
   *
   * Setters are null-guarded for the pre-init case (early reloadCredentials
   * before `_initMemoryAndKnowledge` / `_initIntegrations`).
   */
  private _propagateProviderSwitch(apiKey: string | undefined): void {
    if (this.memory) {
      this.memory.setClient({
        apiKey,
        apiBaseURL: this.userConfig.api_base_url,
        provider: this.userConfig.provider,
        openaiModelId: this.userConfig.openai_model_id,
      });
    }
    if (this.knowledgeLayer) {
      this.knowledgeLayer.setAnthropicClient(this.client);
    }
    // Inbox classifier — gated on `_inboxRuntime` so the pre-`_initIntegrations`
    // path (constructor's _recreateClient via _initContextAndIdentity) is a
    // no-op. Once initialised, defer to the async helper so the await chain
    // doesn't leak into this sync method's signature.
    if (this._inboxRuntime) {
      this._inboxRebootstrapInflight = this
        ._rebootstrapInboxOnProviderSwitch()
        .finally(() => { this._inboxRebootstrapInflight = null; });
    }
  }

  /**
   * Rebuild the inbox classifier runtime when a UI provider-switch crosses
   * the us/eu region boundary. Idempotent + region-gated: a same-region
   * rotation (BYOK refresh, Anthropic→Anthropic) short-circuits to avoid
   * the queue.drain() + reminder-poller restart cost. When the region
   * crosses, the old runtime is drained via `shutdown()` and a fresh one
   * is bootstrapped against the same MailStateDb + the current secret /
   * env config.
   *
   * Best-effort: any failure (mistral key missing post-switch, bootstrap
   * exception, etc.) is logged and leaves the engine without an inbox
   * runtime rather than crashing the whole engine — matching the
   * `_initIntegrations` posture for the cold-boot path.
   */
  private async _rebootstrapInboxOnProviderSwitch(): Promise<void> {
    if (!this._inboxRuntime || !this._mailStateDb) return;
    const newRegion = resolveInboxLlmRegion({
      envOverride: process.env['LYNOX_INBOX_LLM_REGION'],
      provider: this.userConfig.provider,
      apiBaseURL: this.userConfig.api_base_url,
    });
    if (newRegion === this._inboxLlmRegion) return;
    // Privacy guard: suspend classification BEFORE we touch the old
    // runtime so any mail that lands during `await old.shutdown()` is
    // not fired into the US-bound closure. The wrapper installed below
    // (and in `_initIntegrations`) honors this flag — mail stays unread
    // on the server and gets picked up by the next polling cycle via
    // the NEW EU-bound runtime.
    this._inboxClassifierSuspended = true;
    try {
      const old = this._inboxRuntime;
      // Detach the live runtime first so any concurrent mail arrival
      // doesn't see a half-disposed instance.
      this._inboxRuntime = null;
      try { await old.shutdown(); } catch { /* best-effort drain */ }
      // Re-wire the MailContext hook (only present when a vault exists)
      // — without this, the watcher would keep firing into the disposed
      // runtime's hook closure. exactOptionalPropertyTypes forbids `=
      // undefined`, so `delete` is the correct idiom here.
      if (this._mailContext) {
        delete this._mailContext.hooks.onInboundMail;
        delete this._mailContext.hooks.onAccountAdded;
      }
      const { bootstrapInbox } = await import('../integrations/inbox/bootstrap.js');
      const rawMode = process.env['LYNOX_INBOX_SENSITIVE_MODE'];
      const sensitiveMode = rawMode === 'mask' || rawMode === 'allow' ? rawMode : 'skip';
      const mistralApiKey = this.secretStore?.resolve('LYNOX_INBOX_MISTRAL_API_KEY')
        ?? this.secretStore?.resolve('MISTRAL_API_KEY')
        ?? process.env['LYNOX_INBOX_MISTRAL_API_KEY']
        ?? process.env['MISTRAL_API_KEY']
        ?? undefined;
      const folderBlacklistRaw = process.env['LYNOX_INBOX_FOLDER_BLACKLIST'] ?? '';
      const folderBlacklist = new Set(
        folderBlacklistRaw.split(',').map((s) => s.trim()).filter(Boolean),
      );
      const disabledAccountsRaw = process.env['LYNOX_INBOX_DISABLED_ACCOUNTS'] ?? '';
      const disabledAccounts = new Set(
        disabledAccountsRaw.split(',').map((s) => s.trim()).filter(Boolean),
      );
      const bootOpts: Parameters<typeof bootstrapInbox>[0] = {
        mailStateDb: this._mailStateDb,
        anthropicClient: this.client,
        crm: this._crm,
        sensitiveMode,
        llmRegion: newRegion,
        requireUsAck: process.env['LYNOX_INBOX_REQUIRE_PRIVACY_ACK'] === '1',
        privacyAck: process.env['LYNOX_INBOX_PRIVACY_ACK'] === '1',
      };
      if (mistralApiKey !== undefined) bootOpts.mistralApiKey = mistralApiKey;
      if (folderBlacklist.size > 0) bootOpts.folderBlacklist = folderBlacklist;
      if (disabledAccounts.size > 0) bootOpts.disabledAccounts = disabledAccounts;
      bootOpts.notificationRouter = this._notificationRouter;
      const runHistoryForInbox = this.getRunHistory();
      if (runHistoryForInbox) bootOpts.runHistory = runHistoryForInbox;
      // Managed credit gate + debit for classifier pool-key spend (no-op self-host).
      bootOpts.meteredHost = this;
      const runtime = bootstrapInbox(bootOpts);
      if (this._mailContext) {
        // Suspension-aware wrapper: while `_inboxClassifierSuspended` is
        // true (e.g. during a future drain window) the hook short-
        // circuits without touching the runtime closure. Preserves the
        // `Promise<void>` return type the MailContext awaits.
        this._mailContext.hooks.onInboundMail = async (accountId, envelope) => {
          if (this._inboxClassifierSuspended) return;
          // Discard the hook's outcome — the MailContext contract is
          // Promise<void>; only the inbox-internal cold-start path reads it.
          await runtime.hook(accountId, envelope);
        };
        this._mailContext.hooks.onAccountAdded = runtime.onAccountAdded;
        // Mark an inbox item `replied` when the user answers it in chat.
        this._mailContext.hooks.onOutboundSent = runtime.onOutboundReconcile;
      }
      this._inboxRuntime = runtime;
      this._inboxLlmRegion = newRegion;
    } catch (err) {
      // Same posture as the cold-boot path — surface but don't crash.
      console.error(
        '[lynox] Inbox classifier rebootstrap on provider-switch failed — '
        + 'classifier disabled until next restart:',
        err,
      );
    } finally {
      // Always clear: a mid-flight bootstrap failure must not leave the
      // engine with suspension stuck on (mail would silently pile up).
      this._inboxClassifierSuspended = false;
    }
  }

  async init(): Promise<this> {
    await this._initBootstrap();
    await this._initPersistence();
    await this._initContextAndIdentity();
    await this._initKnowledge();
    await this._initCoreTools();
    await this._initIntegrations();
    await this._initPipelineAndBackup();
    return this;
  }

  /** Debug logging, LLM provider SDK, Bugsink error reporting. Extracted from `init()` so each phase reads as a discrete bring-up step instead of one 622 LoC method. */
  private async _initBootstrap(): Promise<void> {
    // Activate debug logging early (before any channel publishing)
    initDebugSubscriber();

    // Wave 5d BYOK liability gate: when the active config (env-driven boot
    // path included) points the LLM at a host outside lynox's vetted
    // sub-processor list, refuse to start unless the operator explicitly
    // accepts controller responsibility via LYNOX_CUSTOM_ENDPOINT_ACCEPTED.
    // Implementation note: we treat *any* configured `api_base_url` as the
    // surface to police (covers ANTHROPIC_BASE_URL env, eu-sovereign Mistral
    // override, BYOK custom providers). Allowlisted endpoints (the Mistral
    // host bound by the eu-sovereign toggle, localhost, RFC1918 LAN, the
    // curated provider set) pass silently.
    this._enforceEndpointAllowlist();

    // Initialize LLM provider SDK if using vertex/custom/openai
    const provider = this.userConfig.provider;
    if (provider && provider !== 'anthropic') {
      await initLLMProvider(provider);
      if (provider === 'vertex') {
        // Recreate client after Vertex SDK is loaded
        this._recreateClient();
      }
    }
    // Register the openai tier→model resolver. Without this, code paths that
    // resolve a `ModelTier` via `getModelId(tier, 'openai')` emit Anthropic
    // IDs that downstream endpoints (Mistral, OpenAI, …) reject.
    this._configureOpenAIResolver();

    // Initialize Bugsink error reporting. Gated by:
    //   - bugsink_enabled config flag (UI toggle; default unset = legacy
    //     DSN-only behaviour, opt-in on self-host)
    //   - LYNOX_BUGSINK_DSN env var OR config.bugsink_dsn (sink endpoint)
    // Managed deployments pre-configure the DSN; the toggle still honours
    // GDPR Art. 21 opt-out for managed users.
    await this._initBugsink();
  }

  /**
   * Wave 5d BYOK liability gate — shared between engine boot AND runtime
   * config-reload paths (`reloadUserConfig` / `reloadCredentials`).
   *
   * Refuses to proceed when `userConfig.api_base_url` points at a host outside
   * lynox's vetted sub-processor allowlist UNLESS the operator has set
   * `LYNOX_CUSTOM_ENDPOINT_ACCEPTED=true`. When the flag is set we emit a
   * one-time stderr warning carrying the host + the canonical disclosure text
   * so the acceptance leaves an audit trail.
   *
   * No-ops when the config has no `api_base_url` — that's the standard
   * Anthropic-via-default-host case (covered by the lynox DPA without
   * disclosure capture).
   *
   * Self-host vs Managed scope:
   *  - Self-host (BYOK / unmanaged): the operator IS the controller so this
   *    gate captures their acceptance of the third-party-processor relationship.
   *  - Managed: the control plane only injects allowlisted hosts
   *    (api.anthropic.com / api.mistral.ai under the eu-sovereign toggle), so
   *    the gate evaluates to `allowlisted` and the warning never fires for
   *    paying managed tenants.
   *
   * Defense-in-depth: also invoked from `reloadUserConfig` + `reloadCredentials`
   * to plug the bypass surface where a non-UI mutation path (config.json edit
   * + SIGHUP, vault rotation, future admin tooling) could install a
   * non-allowlisted `api_base_url` without re-evaluating the gate. The HTTP
   * `PUT /api/config` handler additionally pre-checks via `evaluateEndpointBootGate`
   * so it can return a clean 400 without exception-as-control-flow — but if
   * any future caller bypasses that pre-check, this gate still catches it
   * before the LLM client is rebuilt.
   *
   * Both call-sites (init + reload) handle the throw differently:
   *  - init(): the throw bubbles out of `_initBootstrap` and aborts startup;
   *    `cli/start.ts` converts init() rejections to a non-zero exit code.
   *  - reload paths: the throw bubbles to whoever called the reload (HTTP
   *    handler, admin API, SIGHUP path) which is expected to catch + surface
   *    a controlled response without crashing the engine process.
   *
   * Decision logic + message wording live in `llm/endpoint-allowlist.ts` so
   * `endpoint-boot-gate.test.ts` can pin the contract without instantiating
   * an Engine.
   */
  /**
   * True if `baseUrl`'s host has a server-persisted disclosure acceptance in
   * the user config (`accepted_custom_endpoints`). Such a host was explicitly
   * accepted through the PUT /api/config gate (the sole path that can ADD an
   * entry — it requires `confirm_custom_endpoint`), so it counts as accepted
   * at reload/boot too, NOT only when the `LYNOX_CUSTOM_ENDPOINT_ACCEPTED`
   * env flag is set. This is what makes a UI/API custom-endpoint save reload
   * cleanly instead of throwing; the gate that guards ADDING a host is
   * unchanged, so this cannot be used to bypass acceptance.
   */
  private _isPersistedAcceptedEndpoint(baseUrl: string | undefined): boolean {
    if (!baseUrl) return false;
    const accepted = this.userConfig.accepted_custom_endpoints;
    if (!accepted || accepted.length === 0) return false;
    try {
      const host = new URL(baseUrl).hostname;
      return accepted.some((e) => e.host === host);
    } catch {
      return false;
    }
  }

  private _enforceEndpointAllowlist(): void {
    const baseUrl = this.userConfig.api_base_url;
    const acceptedFlag = this._isPersistedAcceptedEndpoint(baseUrl)
      ? 'true'
      : process.env['LYNOX_CUSTOM_ENDPOINT_ACCEPTED'];
    const decision = evaluateEndpointBootGate(baseUrl, acceptedFlag);
    if (decision === 'skip' || decision === 'allowlisted') return;
    if (decision === 'refuse') {
      const msg = buildBootRefusalMessage(baseUrl ?? '');
      process.stderr.write(msg + '\n');
      // Throw rather than process.exit(1) so test harnesses can intercept
      // the boot refusal without slaughtering the test runner; production
      // bootstrappers (cli/start.ts) already convert init() rejections to
      // a non-zero exit. Reload-path callers catch this and convert it
      // into a 400 response (see http-api.ts PUT /api/config).
      throw new Error(msg);
    }
    // decision === 'accepted'
    process.stderr.write(buildBootAcceptedWarning(baseUrl ?? '') + '\n');
  }

  /**
   * Bring the global openai-compat tier→model resolver in sync with the
   * active user config. Called from `_initBootstrap` and `reloadUserConfig`
   * so a UI-toggled provider switch (e.g. standard ↔ eu-sovereign) takes
   * effect without a process restart.
   */
  private _configureOpenAIResolver(): void {
    const map = this.userConfig.provider === 'openai'
      ? getOpenAIModelMap(this.userConfig.api_base_url)
      : null;
    const fallback = this.userConfig.provider === 'openai'
      ? this.userConfig.openai_model_id ?? null
      : null;
    setOpenAIModelResolver({ map, fallbackModelId: fallback });
    // Sync the config-aware `balanced` Sonnet override (default Sonnet 4.6 →
    // opt-in Sonnet 5). resolveBalancedModel returns a validated served Sonnet
    // id (or the 4.6 default), so an unset/invalid config is a no-op. Same
    // bootstrap+reload seam so a UI/CP flip takes effect without a restart.
    setBalancedModelResolver(resolveBalancedModel(this.userConfig));
    // Sync the hybrid Tier-Set resolver too, so a routing_mode/tier_set change
    // takes effect at bootstrap + reload without a restart (same hook). For
    // hybrid we enrich each slot with its provider's vault key at this seam so
    // a cross-provider slot authenticates WITHOUT the key ever being persisted
    // to config.json (keys stay in the vault).
    const tierSet = this.userConfig.routing_mode === 'hybrid' && this.userConfig.tier_set
      ? this._enrichTierSetCreds(this.userConfig.tier_set)
      : this.userConfig.tier_set;
    setTierSetResolver({
      routingMode: this.userConfig.routing_mode,
      tierSet,
    });
  }

  /**
   * Resolve per-slot credentials for a hybrid Tier-Set from the vault (env >
   * vault), in-memory only. A SAME-provider slot is left untouched so
   * `clientForTierSnapshot` keeps reusing the ambient client + its key
   * (byte-parity). A CROSS-provider slot with no explicit key gets the target
   * provider's vault key injected (e.g. a `fast→Mistral` slot picks up
   * `MISTRAL_API_KEY`), so the UI never has to store API keys in config.json —
   * it persists only `{provider, model_id, api_base_url}` and the key lives in
   * the vault under its canonical per-provider slot.
   */
  private _enrichTierSetCreds(
    tierSet: import('../types/index.js').TierSet,
  ): import('../types/index.js').TierSet {
    const base = this.userConfig.provider ?? 'anthropic';
    return enrichTierSetCreds(tierSet, base, (provider, apiBaseURL) =>
      resolveProviderApiKey({ provider, apiBaseURL, secretStore: this.secretStore, userConfig: this.userConfig }),
    );
  }

  /** RunHistory, ThreadStore, PromptStore, SecurityAudit, persistent budget + HTTP rate limits. Extracted from `init()` so each phase reads as a discrete bring-up step instead of one 622 LoC method. */
  private async _initPersistence(): Promise<void> {

    // Load the vault key into the env BEFORE constructing the persistence stores.
    // RunHistory + EngineDb derive their at-rest encryption key once, at
    // construction; initSecrets (which used to be the first caller) runs AFTER
    // this phase, so on self-hosted (key in ~/.lynox/vault.key, not exported)
    // both stores would otherwise capture no key and write plaintext. Idempotent.
    ensureVaultKey();

    // Initialize run history (optional — fails gracefully)
    try {
      this.runHistory = new RunHistory();
      this._toolContext.runHistory = this.runHistory;
    } catch (err) {
      process.stderr.write(`[lynox] RunHistory init failed: ${err instanceof Error ? err.message : String(err)} — history, threads, and tasks will be unavailable\n`);
      this.runHistory = null;
    }

    // Foundation Rework v2: open the consolidated engine.db store alongside the
    // legacy DBs. A failure here must not break engine BOOT (chat/browse still
    // run) — but post-S3f engine.db is the SOLE authority for the verb layer
    // (trigger + workflow definitions), so on failure that automation surface is
    // unavailable (verb reads degrade to empty, writes throw — see setVerbGraph
    // wiring below). The subject-graph reads it also backs stay flag-gated.
    try {
      this.engineDb = new EngineDb();
    } catch (err) {
      process.stderr.write(`[lynox] EngineDb init failed: ${err instanceof Error ? err.message : String(err)} — subject-graph store unavailable\n`);
      this.engineDb = null;
    }

    // Foundation Rework v2 (S3f): wire the engine.db verb-layer stores onto
    // RunHistory (built above, before engine.db — hence a setter, not a ctor arg).
    // engine.db is now the SOLE authority for trigger + workflow definitions (the
    // legacy history.db path was dropped in mig v44). If engine.db failed to open,
    // the stores stay null: verb READS degrade to empty/undefined (a read
    // under-fires the money-path, the safe direction) while verb WRITES throw a
    // clear "engine.db unavailable" error rather than silently no-op'ing into
    // false success. The automation surface is honestly unavailable, not a silent
    // black hole. Tasks still mirror additively (legacy-authoritative until S4).
    if (this.runHistory && this.engineDb) {
      // Wrap the wiring like the EngineDb/RunHistory inits above: a throw while
      // constructing the stores must not break engine boot. On failure the stores
      // stay inert (setVerbGraph never reassigns _workflowStore, so it stays null).
      try {
        // S4a: pass the subject-graph flag so the task read-cutover + the mirror's
        // assignee→subject resolution activate only when the tenant is flag-ON.
        this.runHistory.setVerbGraph(this.engineDb, this.userConfig.subject_graph_enabled === true);
      } catch (err) {
        process.stderr.write(`[lynox] verb-graph wiring failed: ${err instanceof Error ? err.message : String(err)} — verb stores inert\n`);
      }

      // B1 self-heal — copy the legacy history.db verb DEFINITIONS (saved workflows +
      // triggers + tasks) into engine.db. mig v44 is now non-destructive (the legacy
      // rows stay dormant), so on a v1.22.0→v2.0.0 upgrade this boot copy is the ONLY
      // thing that carries the pre-cutover automation surface forward — reads were cut
      // to engine.db (S3f trigger/workflow, S4a tasks), which is still empty on the
      // upgrade boot. Gated exactly-once by the engine.db marker so a definition
      // DELETED after the upgrade is never resurrected from the still-present legacy
      // rows; it also re-runs after an engine.db recreate (self-heal). A failure must
      // NOT break boot — the marker stays 0 and the next boot retries.
      if (!this.engineDb.isVerbBackfillDone()) {
        try {
          const { VerbGraphBackfill } = await import('./verb-graph-backfill.js');
          const counts = new VerbGraphBackfill(this.engineDb, this.runHistory.getDb())
            .run({ resolveAssignee: this.userConfig.subject_graph_enabled === true });
          this.engineDb.markVerbBackfillDone();
          if (counts.workflows + counts.triggers + counts.tasks > 0) {
            process.stderr.write(
              `[lynox] verb-graph backfill: migrated ${counts.workflows} workflow(s), ` +
              `${counts.triggers} trigger(s), ${counts.tasks} task(s) legacy→engine.db\n`,
            );
          }
        } catch (err) {
          process.stderr.write(`[lynox] verb-graph backfill failed: ${err instanceof Error ? err.message : String(err)} — legacy verb defs NOT migrated; retry next boot\n`);
        }
      }

      // Move 1 (PRD §4.1): forward-migrate every stored workflow-definition blob
      // to the current content-schema version. Runs AFTER the verb backfill so
      // legacy defs just copied from history.db are migrated too. Unlike the
      // backfill this needs NO exactly-once marker — it is per-blob version-gated
      // (the version stamp lives inside each blob), so a re-run is a cheap no-op
      // scan and it self-heals after an engine.db recreate. A failure must NOT
      // break boot; the next boot retries (idempotent).
      try {
        const migrated = this.runHistory.migrateWorkflowContentSchema();
        if (migrated.migrated > 0) {
          process.stderr.write(`[lynox] workflow content-schema: migrated ${migrated.migrated}/${migrated.scanned} definition(s)\n`);
        }
      } catch (err) {
        process.stderr.write(`[lynox] workflow content-schema migration failed: ${err instanceof Error ? err.message : String(err)} — retry next boot\n`);
      }
    }

    // Initialize thread store (shares DB connection with RunHistory)
    if (this.runHistory) {
      try {
        const { ThreadStore } = await import('./thread-store.js');
        this._threadStore = new ThreadStore(this.runHistory.getDb());
      } catch (err) {
        process.stderr.write(`[lynox] ThreadStore init failed: ${err instanceof Error ? err.message : String(err)}\n`);
        this._threadStore = null;
      }
    }

    // Provenance recovery backfill (arc:model-selector P1, DEF-0095). The v47
    // `model_tier_source` column starts every pre-column thread at 'unknown'; this
    // one-shot pass labels a thread whose tier differs from the instance default as
    // a likely deliberate pick ('user'), recovering the real historical picks the
    // composer made before the column existed. It CANNOT be migration SQL — it needs
    // the per-instance `default_tier` (clamped like config.model at :362) + legacy
    // brand-name normalisation. Gated exactly-once by a history.db marker
    // (flag-independent — unlike the verb backfill it never touches engine.db). A
    // failure must NOT break boot: the marker stays 0 and the next boot retries.
    if (this.runHistory && !this.runHistory.isModelProvenanceBackfillDone()) {
      try {
        const defaultTier = clampTier(normalizeTier(this.userConfig.default_tier) ?? 'balanced', this.userConfig.max_tier);
        const labelled = this.runHistory.backfillModelTierSourceFromDefault(defaultTier);
        this.runHistory.markModelProvenanceBackfillDone();
        if (labelled > 0) {
          process.stderr.write(`[lynox] model-provenance backfill: labelled ${labelled} pre-column thread(s) as 'user'\n`);
        }
      } catch (err) {
        process.stderr.write(`[lynox] model-provenance backfill failed: ${err instanceof Error ? err.message : String(err)} — retry next boot\n`);
      }
    }

    // Initialize prompt store (shares DB connection with RunHistory)
    if (this.runHistory) {
      try {
        const { PromptStore } = await import('./prompt-store.js');
        this._promptStore = new PromptStore(this.runHistory.getDb());
        // Expire any prompts left pending from a previous engine run
        this._promptStore.expireAll();
        // Periodic cleanup every 5 minutes
        this._promptCleanupTimer = setInterval(() => {
          this._promptStore?.expireOld();
        }, 5 * 60_000);
      } catch (err) {
        process.stderr.write(`[lynox] PromptStore init failed: ${err instanceof Error ? err.message : String(err)}\n`);
        this._promptStore = null;
      }
    }

    // Initialize run registry (shares DB connection with RunHistory). On a clean
    // boot, any run still marked live in a previous process was killed by the
    // restart — sweep it to 'interrupted' so the client shows a banner + Retry
    // instead of going blind (no cross-restart resume).
    if (this.runHistory) {
      try {
        const { RunRegistry } = await import('./run-registry.js');
        this._runRegistry = new RunRegistry(this.runHistory.getDb());
        const swept = this._runRegistry.sweepInterrupted();
        if (swept > 0) process.stderr.write(`[lynox] run-registry: swept ${swept} interrupted run(s) from a previous process\n`);
      } catch (err) {
        process.stderr.write(`[lynox] RunRegistry init failed: ${err instanceof Error ? err.message : String(err)}\n`);
        this._runRegistry = null;
      }
      // Cost-history counterpart to the run-registry sweep above: flip any
      // orphaned 'running' rows in the runs table to 'failed' so their partial
      // spend counts and they stop showing as perpetually in-flight. Separate
      // try — a failure here must not blank out the registry sweep or boot.
      try {
        const sweptRuns = this.runHistory.sweepStuckRuns();
        if (sweptRuns > 0) process.stderr.write(`[lynox] run-history: swept ${sweptRuns} orphaned running run(s) to failed\n`);
      } catch (err) {
        process.stderr.write(`[lynox] run-history sweep failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    // Initialize the resumable run-event buffer manager (pure in-memory, no DB).
    // Bridges the live gap between eager-persist checkpoints and "now" so a
    // reconnecting client can replay-then-tail in-flight activity (Tier 2).
    try {
      const { RunBufferManager } = await import('./run-buffer.js');
      this._runBufferManager = new RunBufferManager();
    } catch (err) {
      process.stderr.write(`[lynox] RunBufferManager init failed: ${err instanceof Error ? err.message : String(err)}\n`);
      this._runBufferManager = null;
    }

    // Initialize the run executor — the engine-owned concurrency cap + abort
    // registry for chat runs (Tier 2). Bounds how many runs execute at once
    // (cost/memory blast) and lets a run be aborted by id from any connection
    // (DELETE /api/runs/:runId). Execution itself stays in the HTTP handler
    // (headless after disconnect, PR-C); this is the global accounting seam.
    try {
      const { RunExecutor, DEFAULT_MAX_CONCURRENT_RUNS } = await import('./run-executor.js');
      const cap = this.userConfig.max_concurrent_runs;
      this._runExecutor = new RunExecutor(
        typeof cap === 'number' && cap > 0 ? cap : DEFAULT_MAX_CONCURRENT_RUNS,
      );
    } catch (err) {
      process.stderr.write(`[lynox] RunExecutor init failed: ${err instanceof Error ? err.message : String(err)}\n`);
      this._runExecutor = null;
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
      configureBudgetAndRateLimits(this.runHistory, this.userConfig, this._toolContext);
    }
  }

  /** Context resolution, workspace, briefing, secrets, API client recreate, user ID + scopes. Extracted from `init()` so each phase reads as a discrete bring-up step instead of one 622 LoC method. */
  private async _initContextAndIdentity(): Promise<void> {

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

    // Recreate API client now that secrets are available (vault may hold ANTHROPIC_API_KEY)
    this._recreateClient();

    // Resolve user ID and active scopes
    const scopeResult = initScopes(this.userConfig, this.context, this.runHistory, this.memory);
    this.userId = scopeResult.userId;
    this.activeScopes = scopeResult.scopes;
    if (scopeResult.briefingPart) {
      this.briefing = this.briefing ? `${this.briefing}\n\n${scopeResult.briefingPart}` : scopeResult.briefingPart;
    }
  }

  /** Memory, embedding provider, knowledge graph, DataStore↔KG bridge, KPI briefing injection, memory:store subscriber. Extracted from `init()` so each phase reads as a discrete bring-up step instead of one 622 LoC method. */
  private async _initKnowledge(): Promise<void> {

    // Initialize memory
    this.memory = await initMemoryInstance(
      this.config, this.userConfig, this.activeScopes,
      this.context?.id, this.secretStore,
    );
    // Route the per-turn auto-extraction pool-key spend through the managed gate
    // + debit (same onBeforeRun/onAfterRun lifecycle as the KG extractor and
    // chat/voice). No-op on self-host.
    this.memory?.setMeteredHost(this);

    // Initialize embedding provider + knowledge graph
    this.embeddingProvider = initEmbeddingProvider(this.userConfig, this.runHistory);
    this.knowledgeLayer = await initKnowledgeLayer(this.userConfig, this.embeddingProvider, this.client, this.runHistory, this.engineDb);
    this._toolContext.knowledgeLayer = this.knowledgeLayer;
    // Route pool-key KG-extraction spend through the managed gate + debit (same
    // onBeforeRun/onAfterRun lifecycle as chat/voice). No-op on self-host.
    this.knowledgeLayer?.setMeteredHost(this);

    // Initialize DataStore ↔ Knowledge Graph Bridge
    if (this.knowledgeLayer && this._dataStore) {
      this.dataStoreBridge = initDataStoreBridge(this.knowledgeLayer, this._dataStore);
    }

    // Inject KPI context into briefing (now that KnowledgeLayer is available)
    if (this.knowledgeLayer) {
      try {
        const perfParts: string[] = [];
        const metrics = this.knowledgeLayer.getMetrics();
        if (metrics.length > 0) {
          const kpiLines = metrics
            .filter(m => !m.metricName.startsWith('tool_usage.'))
            .map(m => `${m.metricName}: ${typeof m.value === 'number' && m.value < 1 ? (m.value * 100).toFixed(0) + '%' : String(Math.round(m.value))}`)
            .slice(0, 5);
          if (kpiLines.length > 0) perfParts.push(`KPIs: ${kpiLines.join(', ')}`);
        }
        if (perfParts.length > 0) {
          const perfBlock = `<agent_performance>\n${perfParts.join('\n')}\n</agent_performance>`;
          this.briefing = this.briefing ? `${this.briefing}\n\n${perfBlock}` : perfBlock;
        }
      } catch { /* non-critical */ }
    }

    // Subscribe to memory:store for automatic knowledge graph storage
    setupMemoryStoreSubscription(
      this.knowledgeLayer, this.embeddingProvider, this.runHistory,
      this.context?.id ?? '',
    );
  }

  /** API profile loading, builtin tool registration, TaskManager wiring, DataStore + ArtifactStore. Extracted from `init()` so each phase reads as a discrete bring-up step instead of one 622 LoC method. */
  private async _initCoreTools(): Promise<void> {

    try {
      const { ApiStore } = await import('./api-store.js');
      this._apiStore = new ApiStore();
      const apisDir = join(getLynoxDir(), 'apis');
      let loaded: number;
      if (this.engineDb) {
        // S4b single-authority: engine.db `connections` is the source of truth
        // for api profiles. Import the legacy flat-JSON profiles once (idempotent,
        // sentinel-guarded), project them into the in-memory store, and wire the
        // ConnectionStore so future save/remove persist to engine.db (the flat
        // JSON files remain on disk as a rollback backup).
        const { ConnectionStore } = await import('./connection-store.js');
        const connStore = new ConnectionStore(this.engineDb);
        this._apiStore.importFromDirectoryIfNeeded(apisDir, connStore);
        loaded = this._apiStore.loadFromConnections(connStore);
        this._apiStore.setConnectionStore(connStore);
      } else {
        // Degraded (engine.db unavailable): fall back to the flat-JSON directory,
        // exactly as before S4b.
        loaded = this._apiStore.loadFromDirectory(apisDir);
      }
      // Wire the in-memory store into tool context unconditionally — otherwise
      // a fresh install (zero profiles) leaves toolContext.apiStore undefined, so
      // api_setup `create` persists the new profile but can't register it in
      // memory, and GET /api/api-profiles keeps returning [] until the next
      // engine restart re-projects it.
      this._toolContext.apiStore = this._apiStore;
      if (loaded > 0) {
        const apiContext = this._apiStore.formatForSystemPrompt();
        this.briefing = this.briefing ? `${this.briefing}\n\n${apiContext}` : apiContext;
      }
      // Inject the curated "bootstrap-suggestion" catalog regardless of how
      // many user-bootstrapped profiles are already loaded. On a fresh
      // install (loaded === 0) this is the only API context the agent has;
      // after the user has wired some APIs it sits alongside, showing what
      // else they can wire on demand. The catalog is suggestions only —
      // real profiles are produced at bootstrap time by `api_setup` so the
      // endpoint schema comes from live docs, not the model's training set.
      // Opt-out: LYNOX_SKIP_SUGGESTED_APIS=1.
      const suggestedContext = this._apiStore.formatSuggestedApisForSystemPrompt();
      if (suggestedContext) {
        this.briefing = this.briefing ? `${this.briefing}\n\n${suggestedContext}` : suggestedContext;
      }
    } catch {
      this._apiStore = null;
    }

    // Register builtin tools
    this.registry
      .register(bashTool)
      .register(readFileTool)
      .register(writeFileTool)
      .register(editFileTool)
      .register(memoryStoreTool)
      .register(memoryRecallTool)
      .register(memoryDeleteTool)
      .register(memoryUpdateTool)
      .register(memoryListTool)
      .register(memoryPromoteTool)
      .register(spawnAgentTool)
      .register(askUserTool)
      .register(askSecretTool)
      .register(batchFilesTool)
      .register(httpRequestTool)
      .register(apiSetupTool)
      .register(taskCreateTool)
      .register(taskUpdateTool)
      .register(taskListTool)
      .register(planTaskTool)
      .register(recallToolResultTool)
      .register(mediaProcessTool);

    // Wire task manager if run history is available
    if (this.runHistory) {
      const { TaskManager, setPipelineModeLookup } = await import('./task-manager.js');
      this._taskManager = new TaskManager(this.runHistory);
      this._toolContext.taskManager = this._taskManager;
      // Wire the pipeline-mode lookup so TaskManager can refuse to schedule
      // interactive pipelines. Lazy-imported to avoid a tools→core cycle.
      // Fail-closed: if the import or wiring fails, install a lookup that
      // marks every pipeline as 'interactive' so the scheduler refuses
      // them all rather than silently letting interactive pipelines onto
      // the cron.
      const runHistoryRef = this.runHistory;
      try {
        const { getPipeline } = await import('../tools/builtin/pipeline.js');
        setPipelineModeLookup((pipelineId: string) => {
          const planned = getPipeline(pipelineId, runHistoryRef);
          return planned?.mode ?? null;
        });
      } catch (err) {
        console.error('[engine] Failed to wire pipeline-mode lookup; refusing all scheduled pipelines:', err);
        setPipelineModeLookup(() => 'interactive');
      }
    }

    // Initialize DataStore (best-effort — never fail init)
    try {
      this._dataStore = new DataStore();
      this._toolContext.dataStore = this._dataStore;
      // Drop empty CRM-shaped collections (`contacts` / `deals` / `interactions`
      // …) that older agent sessions left behind. They duplicate the dedicated
      // CRM tab in the UI and confuse users. Non-empty ones are preserved.
      const droppedOverlaps = this._dataStore.dropEmptyCrmOverlaps();
      if (droppedOverlaps.length > 0) {
        process.stderr.write(`[lynox] DataStore: dropped ${String(droppedOverlaps.length)} empty CRM-overlap collection(s): ${droppedOverlaps.join(', ')}\n`);
      }
      const collections = this._dataStore.listCollections();
      if (collections.length > 0) {
        this.registerDataStoreTools();
        const lines = collections.map(c =>
          `${c.name} (${c.scopeType}${c.scopeId ? ':' + c.scopeId : ''}) — ${c.recordCount} records, updated ${c.updatedAt.slice(0, 10)}`
        );
        const dataBlock = `<data_collections>\n${lines.join('\n')}\n</data_collections>`;
        this.briefing = this.briefing ? `${this.briefing}\n\n${dataBlock}` : dataBlock;
      }
    } catch (err) {
      process.stderr.write(`[lynox] DataStore init failed: ${err instanceof Error ? err.message : String(err)}\n`);
      this._dataStore = null;
    }

    // Initialize ArtifactStore (best-effort)
    try {
      const { ArtifactStore } = await import('./artifact-store.js');
      this._artifactStore = new ArtifactStore();
      this._toolContext.artifactStore = this._artifactStore;
      this.registry
        .register(artifactSaveTool)
        .register(artifactListTool)
        .register(artifactDeleteTool)
        .register(artifactHistoryTool)
        .register(artifactRestoreTool);
    } catch (err) {
      process.stderr.write(`[lynox] ArtifactStore init failed: ${err instanceof Error ? err.message : String(err)}\n`);
      this._artifactStore = null;
    }
  }

  /** Web search provider, Google Workspace, Mail (IMAP/SMTP + OAuth-Gmail), Inbox classifier (Phase 1a). Extracted from `init()` so each phase reads as a discrete bring-up step instead of one 622 LoC method. */
  private async _initIntegrations(): Promise<void> {

    // Web search tool (conditional)
    // Provider priority: SearXNG (sidecar or self-hosted URL) > DDG HTML-scrape fallback.
    // Tavily was removed 2026-05-24 — the UI hadn't surfaced it for months,
    // and keeping a dead env-var path was misleading. SearXNG is the only
    // supported full-quality backend; DDG is the no-config honesty fallback.
    const searxngUrl = process.env['SEARXNG_URL'] ?? this.userConfig.searxng_url;
    // Default to 'none' — flipped to 'configured' / 'fallback' below
    // depending on which provider lands in the registry. Session reads
    // this via `getWebSearchStatus()` to append the honesty-fallback or
    // fallback-quality prompt suffix so the agent never silently
    // fabricates search results when search is unavailable.
    this._webSearchStatus = 'none';
    if (searxngUrl) {
      try {
        const { SearXNGProvider, createWebSearchTool } = await import('../integrations/search/index.js');
        const searxng = new SearXNGProvider(searxngUrl);
        let healthy = await searxng.healthCheck();
        if (!healthy) {
          // SearXNG may still be starting (Docker Compose race) — retry with backoff
          for (const delay of [3000, 5000, 10000]) {
            await new Promise(r => setTimeout(r, delay));
            healthy = await searxng.healthCheck();
            if (healthy) break;
          }
        }
        if (healthy) {
          this.registry.register(createWebSearchTool(searxng));
          this._webSearchStatus = 'configured';
        } else {
          process.stderr.write(`[lynox] SearXNG not reachable at ${searxngUrl} — falling back to DuckDuckGo HTML scrape. Check if SearXNG is running.\n`);
        }
      } catch (err) {
        process.stderr.write(`[lynox] SearXNG init failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    // Embedded DuckDuckGo HTML-scrape fallback. Wired ONLY when SearXNG
    // didn't land — fixes the "agent silently fabricates arxiv IDs"
    // failure mode by giving the model a real (if best-effort) search
    // backend instead of nothing. The agent gets a separate
    // `WEB_SEARCH_FALLBACK_PROMPT_SUFFIX` so it knows to caveat results
    // and recommend SearXNG for high-stakes research.
    if (this._webSearchStatus === 'none') {
      try {
        const { DuckDuckGoProvider, createWebSearchTool } = await import('../integrations/search/index.js');
        this.registry.register(createWebSearchTool(new DuckDuckGoProvider()));
        this._webSearchStatus = 'fallback';
        process.stderr.write('[lynox] No SearXNG configured — using DuckDuckGo HTML-scrape fallback (best-effort). Set SEARXNG_URL or run via `docker compose up` for higher-quality results.\n');
      } catch (err) {
        process.stderr.write(`[lynox] DuckDuckGo fallback init failed: ${err instanceof Error ? err.message : String(err)}\n`);
        process.stderr.write('[lynox] No web search configured. Use docker-compose for built-in SearXNG, or set SEARXNG_URL.\n');
      }
    }

    // Google Workspace tools (conditional — requires client ID + secret)
    const googleClientId = this.secretStore?.resolve('GOOGLE_CLIENT_ID')
      ?? process.env['GOOGLE_CLIENT_ID']
      ?? this.userConfig.google_client_id;
    const googleClientSecret = this.secretStore?.resolve('GOOGLE_CLIENT_SECRET')
      ?? process.env['GOOGLE_CLIENT_SECRET']
      ?? this.userConfig.google_client_secret;
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

    // Provider-agnostic Mail integration (IMAP/SMTP + OAuth-Gmail).
    // Always initialised when a vault is available — the state DB is cheap
    // and supports zero accounts. Tools are registered when the context has
    // a vault to bind credentials to. reloadMail() is the runtime path for
    // account add/remove after startup.
    //
    // googleAuth is passed through so OAuth-Gmail accounts coexist with IMAP
    // in the same registry. MailContext.init() runs a boot migration that
    // creates a Gmail row when the user has an existing OAuth connection.
    let mailStateDb: import('../integrations/mail/state.js').MailStateDb | null = null;
    try {
      const { MailContext } = await import('../integrations/mail/context.js');
      const { MailStateDb } = await import('../integrations/mail/state.js');
      // MailStateDb is vault-independent — it just opens the SQLite file.
      // Created outside the vault guard so the inbox bootstrap below can
      // share the connection even when no vault is configured (e.g. CI,
      // test fixtures, browse-only mode).
      mailStateDb = new MailStateDb();
      // Retain on the engine so `_propagateProviderSwitch` can re-bootstrap
      // the inbox classifier without re-opening the SQLite file (and racing
      // the live MailContext that still holds the original connection).
      this._mailStateDb = mailStateDb;
      if (this.secretVault) {
        const mailCtx = new MailContext(mailStateDb, this.secretVault, undefined, {}, this._googleAuth);
        await mailCtx.init();
        for (const tool of mailCtx.tools()) {
          this.registry.register(tool);
        }
        this._mailContext = mailCtx;
        // v14 Send Later — start the scheduled-send poller so queued
        // mails fire at their scheduled time. Wired here (after MailContext
        // init so the registry is populated) and stopped on engine shutdown
        // via the mail-context lifecycle.
        const { startScheduledSendPoller } = await import('../integrations/mail/mail-scheduled-poller.js');
        const scheduledPoller = startScheduledSendPoller({
          state: mailStateDb,
          registry: mailCtx.registry,
        });
        this._scheduledSendPoller = scheduledPoller;
      }
    } catch {
      // Mail init failed — non-critical, continue without it
    }

    // PRD-UNIFIED-INBOX Phase 1a — wire the classifier hook on top of the
    // mail state DB (the MailContext is optional; without a vault we still
    // bootstrap the inbox so classification works as soon as a vault lands).
    // Gated on the `unified-inbox` feature flag so the foundation can ride
    // along in shipped binaries without surfacing until the UI lands in
    // Phase 1b.
    if (mailStateDb && isFeatureEnabled('unified-inbox')) {
      try {
        const { bootstrapInbox } = await import('../integrations/inbox/bootstrap.js');
        // Sensitive-content handling: skip / mask / allow. Default is
        // 'skip' — sensitive mails (OTP, secrets, IBAN, card) never
        // reach the LLM. Switch to 'mask' on EU/trusted providers to
        // get classification on a redacted copy; 'allow' opts out
        // entirely (only safe with a strict DPA / self-hosted LLM).
        const rawMode = process.env['LYNOX_INBOX_SENSITIVE_MODE'];
        const sensitiveMode = rawMode === 'mask' || rawMode === 'allow' ? rawMode : 'skip';
        // EU residency: default the inbox classifier provider from the
        // user's chosen main provider. When the user picked Mistral in
        // Settings (`userConfig.provider === 'openai'` against
        // api.mistral.ai), the classifier inherits that choice and uses
        // Mistral (EU-resident) automatically — no env var required.
        //
        // `LYNOX_INBOX_LLM_REGION` remains an explicit override (e.g.
        // managed-EU tenants who want hard-pinning regardless of the UI
        // choice, or self-hosted Anthropic users who set `LYNOX_INBOX_LLM_REGION=eu`
        // to route just the classifier through Mistral while their chat
        // stays on Anthropic).
        //
        // Bug rationale: pre-this-fix the classifier always defaulted to
        // 'us' (Anthropic-Haiku) regardless of `userConfig.provider`, so
        // a user who switched to Mistral in Settings for EU-residency was
        // STILL leaking mail snippets + draft bodies to Anthropic-US.
        const llmRegion = resolveInboxLlmRegion({
          envOverride: process.env['LYNOX_INBOX_LLM_REGION'],
          provider: this.userConfig.provider,
          apiBaseURL: this.userConfig.api_base_url,
        });
        // Track the bound region so `_propagateProviderSwitch` can detect
        // a region transition (us<->eu) on a UI provider-switch and rebuild
        // the runtime — without this, switching the main provider to Mistral
        // would leave the classifier on Anthropic-US (the H-012 leak).
        this._inboxLlmRegion = llmRegion;
        const mistralApiKey = this.secretStore?.resolve('LYNOX_INBOX_MISTRAL_API_KEY')
          ?? this.secretStore?.resolve('MISTRAL_API_KEY')
          ?? process.env['LYNOX_INBOX_MISTRAL_API_KEY']
          ?? process.env['MISTRAL_API_KEY']
          ?? undefined;
        // Folder blacklist: comma-separated env, case-insensitive match.
        // Use case: "Banking, Privat, Healthcare" — those folders' mails
        // never reach the inbox classifier path at all.
        const folderBlacklistRaw = process.env['LYNOX_INBOX_FOLDER_BLACKLIST'] ?? '';
        const folderBlacklist = new Set(
          folderBlacklistRaw.split(',').map((s) => s.trim()).filter(Boolean),
        );
        // Per-account opt-out: comma-separated mail_account ids.
        const disabledAccountsRaw = process.env['LYNOX_INBOX_DISABLED_ACCOUNTS'] ?? '';
        const disabledAccounts = new Set(
          disabledAccountsRaw.split(',').map((s) => s.trim()).filter(Boolean),
        );
        const bootOpts: Parameters<typeof bootstrapInbox>[0] = {
          mailStateDb,
          anthropicClient: this.client,
          crm: this._crm,
          sensitiveMode,
          llmRegion,
          requireUsAck: process.env['LYNOX_INBOX_REQUIRE_PRIVACY_ACK'] === '1',
          privacyAck: process.env['LYNOX_INBOX_PRIVACY_ACK'] === '1',
        };
        if (mistralApiKey !== undefined) bootOpts.mistralApiKey = mistralApiKey;
        if (folderBlacklist.size > 0) bootOpts.folderBlacklist = folderBlacklist;
        if (disabledAccounts.size > 0) bootOpts.disabledAccounts = disabledAccounts;
        // Wire the notification router so the reminder poller can fire
        // push when notify_on_unsnooze items wake up.
        bootOpts.notificationRouter = this._notificationRouter;
        // Bridge classifier spend into RunHistory so "$X today" reflects it.
        // Without this the classifier costs real money that never shows up
        // in the dashboard.
        const runHistoryForInbox = this.getRunHistory();
        if (runHistoryForInbox) bootOpts.runHistory = runHistoryForInbox;
        // Managed credit gate + debit for classifier pool-key spend (no-op self-host).
        bootOpts.meteredHost = this;
        const runtime = bootstrapInbox(bootOpts);
        // If a MailContext exists, wire the inbox hook into its hooks so
        // the watcher fires it per envelope. When no vault is configured
        // the MailContext is null — the runtime is still alive and the
        // hook can be invoked manually by other inbound-channel adapters.
        if (this._mailContext) {
          // Suspension-aware wrapper — symmetric with the rebootstrap
          // path. The flag is only set during cross-region rebootstrap;
          // on the cold-boot path it is permanently false, so the
          // wrapper is a zero-cost passthrough until the first switch.
          this._mailContext.hooks.onInboundMail = async (accountId, envelope) => {
            if (this._inboxClassifierSuspended) return;
            // Discard the hook's outcome — the MailContext contract is
            // Promise<void>; only the inbox-internal cold-start path reads it.
            await runtime.hook(accountId, envelope);
          };
          // Auto-trigger backfill on account-connect. The adapter gates
          // re-runs via `state.hasAnyItemForAccount`, so a re-credential
          // does not pull provider.list() again.
          this._mailContext.hooks.onAccountAdded = runtime.onAccountAdded;
          // Mark an inbox item `replied` when the user answers it in chat.
          this._mailContext.hooks.onOutboundSent = runtime.onOutboundReconcile;
          // Notify the user when a tracked mail follow-up's reminder falls due.
          // The hook is DECLARED (MailContext.checkDueFollowups fires it every
          // watcher tick, after marking the row reminded) but was never ASSIGNED —
          // the MailContext is built with `{}` hooks — so due follow-ups advanced
          // pending→reminded silently and the user was never told. This hook is
          // independent of the inbox runtime (it notifies directly), so it is set
          // ONCE here and survives a cross-region rebootstrap, which only re-wires
          // the runtime-bound hooks. checkDueFollowups marks-reminded BEFORE the
          // hook, so a slow/failed notify can't double-remind on the next tick.
          this._mailContext.hooks.onFollowupDue = async (followup) => {
            await this._notificationRouter.notify({
              title: 'Follow-up fällig',
              body: followup.reason
                ? `${followup.reason} (an ${followup.recipient})`
                : `Antwort ausstehend von ${followup.recipient}`,
              priority: 'normal',
            });
          };
        }
        this._inboxRuntime = runtime;
      } catch (err) {
        // Surface the failure so a silently-disabled feature does not
        // become a debugging black hole. Mail integration still works.
        console.error('[lynox] Inbox bootstrap failed — feature disabled:', err);
      }
    }

  }

  /** Pipeline tools, MCP servers, plugins, CRM, backup manager, version-change auto-backup, Google Drive uploader, plugin session start, managed-hosting hook, orchestrator lifecycle hooks. Extracted from `init()` so each phase reads as a discrete bring-up step instead of one 622 LoC method. */
  private async _initPipelineAndBackup(): Promise<void> {

    // Pipeline tools registered conditionally
    this._pipelinesEnabled = false;

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
        // Foundation Rework v2 (S1c): hand the CRM the engine.db handle + flag so
        // a saved contact is additively mirrored into the subject-graph. Inert in
        // prod (flag OFF) and when engine.db failed to open (graceful degrade).
        this._crm = new CRM(this._dataStore, {
          engineDb: this.engineDb ?? undefined,
          subjectGraphEnabled: this.userConfig.subject_graph_enabled === true,
        });
        this._crm.ensureSchema();

        // One-time cleanup: remove contacts auto-created from KG entities
        // (NER false positives polluted the contacts list with non-contact words)
        this._crm.purgeKnowledgeGraphContacts();

        // Expose the CRM to tool handlers (contacts_save / contacts_search)
        // so they write into the correct global CRM scope + schema instead of
        // the agent's context-scoped data_store default. Register the two
        // contact tools now that the CRM is live (mirrors the artifact tools
        // registering after ArtifactStore init).
        this._toolContext.crm = this._crm;
        this.registry
          .register(contactsSaveTool)
          .register(contactsSearchTool);
      } catch {
        this._crm = null;
      }
    }

    // Foundation Rework v2 — Context-Hierarchy Scoping (Slice A2). Expose the
    // subject-graph + live thread stores to tool handlers and register the
    // `set_thread_context` tool — ONLY when the subject-graph flag is on. Off in
    // prod today → the tool + stores are absent from the agent surface entirely
    // (zero new standing attack surface when the flag is off). SubjectStore is a
    // thin per-call wrapper over engine.db (same pattern as CRM/KnowledgeLayer).
    if (this.userConfig.subject_graph_enabled === true && this.engineDb && this._threadStore) {
      try {
        const { SubjectStore, makeSubjectColumnBridge } = await import('./subject-store.js');
        const subjectStore = new SubjectStore(this.engineDb);
        this._subjectStore = subjectStore;
        this._toolContext.subjectStore = subjectStore;
        this._toolContext.threadStore = this._threadStore;
        this.registry.register(setThreadContextTool);
        this.registry.register(subjectsMergeTool);
        // Record-on-spine (R1 write + R1.5 query): wire the subject-column bridge
        // so `subject`-typed DataStore columns resolve a row's name → a real
        // subject_id on insert (the SAME findOrCreate dedup that feeds the graph),
        // filter by name, and display names instead of UUIDs. Wired ONLY inside
        // this flag-gated block — when the flag is off the bridge stays null and
        // subject columns degrade to plain strings (zero new coupling on the
        // legacy path).
        this._dataStore?.setSubjectBridge(makeSubjectColumnBridge(subjectStore));

        // Record-on-spine R2b: the id-keyed on-demand subject-footprint reader.
        // Composes the stores that each hold a soft-ref to a subject — records
        // (datastore.db, R2a index + occurred_at), memories/tasks (engine.db), and
        // the LIVE thread anchor (`this._threadStore` = history.db, so the read stays
        // S2-flip-correct). Thin per-call wrappers over the shared engine.db handle,
        // constructed fresh here (same pattern as SubjectStore above). Not folded into
        // per-turn retrieve() — an on-demand projection only.
        if (this._dataStore && this.engineDb) {
          const { SubjectFootprintReader } = await import('./subject-footprint-reader.js');
          const { MemoryGraphStore } = await import('./memory-graph-store.js');
          const { TaskStore } = await import('./task-store.js');
          this._subjectFootprintReader = new SubjectFootprintReader(
            subjectStore,
            this._dataStore,
            new MemoryGraphStore(this.engineDb),
            this._threadStore,
            new TaskStore(this.engineDb),
          );
        }
      } catch (err) {
        process.stderr.write(`[lynox] context-scoping tool wiring failed: ${err instanceof Error ? err.message : String(err)}\n`);
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

    // Register managed hosting usage hook (env-gated — only on managed instances)
    // Fatal: if the billing-tier env is set but the hook fails, engine must not
    // start (otherwise the managed customer uses Mistral for free without usage
    // tracking). Canonical LYNOX_BILLING_TIER, legacy LYNOX_MANAGED_MODE.
    if (readEnvAlias('LYNOX_BILLING_TIER')) {
      const { createManagedHook } = await import('./managed-hook.js');
      this.registerHooks(createManagedHook());
    }

    // Fire orchestrator lifecycle hooks (for Pro extensions)
    for (const hook of this._hooks) {
      if (hook.onInit) {
        await hook.onInit(this).catch(() => { /* best-effort */ });
      }
    }
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
      .register(runWorkflowTool)
      .register(updateWorkflowTool)
      .register(exportWorkflowTool)
      .register(importWorkflowTool)
      .register(diagnoseWorkflowTool)
      .register(saveWorkflowTool);
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
      .register(dataStoreDeleteTool)
      .register(dataStoreDropTool);
  }

  addTool<T>(entry: ToolEntry<T>): void {
    this.registry.register(entry);
  }

  /** Register a tool without recreating agents */
  registerTool<T>(entry: ToolEntry<T>): void {
    this.registry.register(entry);
  }

  // ── Getters ──

  getRegistry(): ToolRegistry { return this.registry; }
  getMemory(): Memory | null { return this.memory; }
  getRunHistory(): RunHistory | null { return this.runHistory; }
  getEngineDb(): EngineDb | null { return this.engineDb; }
  getContext(): LynoxContext | null { return this.context; }
  getBriefing(): string | undefined { return this.briefing; }
  getActiveScopes(): MemoryScopeRef[] { return this.activeScopes; }
  getUserId(): string | null { return this.userId; }
  getEmbeddingProvider(): EmbeddingProvider | null { return this.embeddingProvider; }
  getKnowledgeLayer(): KnowledgeLayer | null { return this.knowledgeLayer; }
  getToolContext(): ToolContext { return this._toolContext; }
  getSecretStore(): SecretStore | null { return this.secretStore; }
  getThreadStore(): import('./thread-store.js').ThreadStore | null { return this._threadStore; }

  /** The subject-graph store, or null when `subject_graph_enabled` is off. Present for
   *  the R2b read surface (subjects list → footprint); reads only on the HTTP path. */
  getSubjectStore(): import('./subject-store.js').SubjectStore | null { return this._subjectStore; }

  /**
   * Record-on-spine R2b: the id-keyed, on-demand subject-footprint read (records +
   * threads timeline + adjacent memories/tasks). Returns null when the subject-graph
   * flag is off (reader unwired) OR the id is stale/purged. On-demand only — never on
   * the per-turn retrieve() hot path. The consuming read-only UI surface lands as the
   * follow-on sub-slice.
   */
  getSubjectFootprint(
    subjectId: string,
    opts?: { limit?: number | undefined },
  ): import('./subject-footprint-reader.js').SubjectFootprint | null {
    return this._subjectFootprintReader?.getFootprint(subjectId, opts) ?? null;
  }

  getGoogleAuth(): import('../integrations/google/google-auth.js').GoogleAuth | null { return this._googleAuth; }
  getMailContext(): import('../integrations/mail/context.js').MailContext | null { return this._mailContext; }
  getInboxRuntime(): import('../integrations/inbox/bootstrap.js').InboxRuntime | null { return this._inboxRuntime; }

  /**
   * Slice B3 — the reusable **Agent→User escalation primitive**: open (or BUMP)
   * an UNREAD chat thread seeded with `body` as context, and fire a push that
   * merely POINTS at it (the wakeup, not the content). One thread per `key`
   * (e.g. a task id), bumped on repeat (a flaky daily cron → one thread with
   * history, not N threads). The thread is a normal resumable chat thread — the
   * user opens it and replies; Slice C adds the fix/retry tools that act on the
   * reply. Returns the thread id, or null when there is no ThreadStore (a
   * headless setup) — in which case it degrades to a bare push so the user is
   * still notified. Generic by design so the post-sprint Triggers primitive
   * docks here with no second pour.
   */
  escalateToUser(opts: EscalateOpts): { threadId: string } | null {
    return runEscalation(this.getThreadStore(), this.getNotificationRouter(), opts);
  }

  /** Re-initialize Google Workspace integration after credentials change. */
  async reloadGoogle(): Promise<boolean> {
    const clientId = this.secretStore?.resolve('GOOGLE_CLIENT_ID')
      ?? process.env['GOOGLE_CLIENT_ID']
      ?? this.userConfig.google_client_id;
    const clientSecret = this.secretStore?.resolve('GOOGLE_CLIENT_SECRET')
      ?? process.env['GOOGLE_CLIENT_SECRET']
      ?? this.userConfig.google_client_secret;
    if (!clientId || !clientSecret) {
      this._googleAuth = null;
      return false;
    }
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
  getApiConfig(): { apiKey?: string | undefined; apiBaseURL?: string | undefined; provider?: import('../types/index.js').LLMProvider | undefined; gcpProjectId?: string | undefined; gcpRegion?: string | undefined; openaiModelId?: string | undefined } {
    return {
      apiKey: this.userConfig.api_key,
      apiBaseURL: this.userConfig.api_base_url,
      provider: this.userConfig.provider,
      gcpProjectId: this.userConfig.gcp_project_id,
      gcpRegion: this.userConfig.gcp_region,
      openaiModelId: this.userConfig.openai_model_id,
    };
  }
  getBatchIndex(): BatchIndex { return this.batchIndex; }
  getLastBatchParentId(): string | null { return this._lastBatchParentId; }
  getHooks(): LynoxHooks[] { return this._hooks; }
  getPipelinesEnabled(): boolean { return this._pipelinesEnabled; }
  getDataStoreEnabled(): boolean { return this._dataStoreEnabled; }
  /** Status of the registered web-search provider:
   *  - 'configured' — SearXNG wired up (sidecar or self-hosted URL), full quality.
   *  - 'fallback'   — embedded DuckDuckGo HTML-scrape (best-effort, no key).
   *  - 'none'       — `web_research` tool not registered; agent will be
   *                   told to refuse search and ask for SEARXNG_URL.
   *  Drives the honesty-fallback / fallback-quality prompt suffixes. */
  getWebSearchStatus(): 'configured' | 'fallback' | 'none' { return this._webSearchStatus; }
  getNotificationRouter(): NotificationRouter { return this._notificationRouter; }
  getWorkerLoop(): WorkerLoop | null { return this._workerLoop; }
  getBackupManager(): import('./backup.js').BackupManager | null { return this._backupManager; }
  getApiStore(): import('./api-store.js').ApiStore | null { return this._apiStore; }
  getArtifactStore(): import('./artifact-store.js').ArtifactStore | null { return this._artifactStore; }
  getCRM(): import('./crm.js').CRM | null { return this._crm; }
  getPromptStore(): import('./prompt-store.js').PromptStore | null { return this._promptStore; }
  getRunRegistry(): import('./run-registry.js').RunRegistry | null { return this._runRegistry; }
  getRunBufferManager(): import('./run-buffer.js').RunBufferManager | null { return this._runBufferManager; }
  getRunExecutor(): import('./run-executor.js').RunExecutor | null { return this._runExecutor; }
  getSecurityAudit(): import('./security-audit.js').SecurityAudit | null { return this.securityAudit; }

  /** Returns true if CRM tables (contacts/deals) contain actual records. */
  hasCrmData(): boolean {
    if (!this._dataStore) return false;
    try {
      const contacts = this._dataStore.getCollectionInfo('contacts');
      const deals = this._dataStore.getCollectionInfo('deals');
      return (contacts?.recordCount ?? 0) > 0 || (deals?.recordCount ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /** Start the background worker loop. Call from long-lived server modes (HTTP API). */
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
        modelTier: this.config.model ?? 'deep',
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

  /** Called by Session after each run. Triggers auto-GC and intelligence when thresholds reached. */
  incrementRunCount(): void {
    this.runCount++;

    // Pattern detection + KPI computation (every 10 runs)
    if (this.runCount % INTELLIGENCE_INTERVAL === 0 && this.knowledgeLayer) {
      try { this.knowledgeLayer.runIntelligence(); } catch { /* non-critical */ }
    }

    // GC (every 50 runs)
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

    // Drain in-flight inbox classifier jobs so a late shutdown does not
    // leave half-processed mails. drain() resolves immediately on an empty
    // queue and within seconds otherwise (per-job timeout 30s).
    // First await any in-flight rebootstrap (e.g. shutdown racing a
    // provider-switch) so we don't dispose a runtime that is about to be
    // replaced and then forgotten.
    if (this._inboxRebootstrapInflight) {
      try { await this._inboxRebootstrapInflight; } catch { /* best-effort */ }
    }
    if (this._inboxRuntime) {
      try { await this._inboxRuntime.shutdown(); } catch { /* best-effort */ }
      this._inboxRuntime = null;
    }
    this._mailStateDb = null;
    this._inboxLlmRegion = null;

    // Stop the scheduled-send poller — bounded interval, no in-flight
    // work to drain (sendMail awaits per-row inside the tick).
    if (this._scheduledSendPoller) {
      this._scheduledSendPoller.stop();
      this._scheduledSendPoller = null;
    }

    // Stop prompt cleanup timer
    if (this._promptCleanupTimer) {
      clearInterval(this._promptCleanupTimer);
      this._promptCleanupTimer = null;
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
    if (this.engineDb) {
      try { this.engineDb.close(); } catch { /* ignore */ }
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
    // Flush Bugsink events before shutdown
    try {
      const { shutdownErrorReporting } = await import('./error-reporting.js');
      await shutdownErrorReporting();
    } catch {
      // best-effort
    }
    await shutdownDebugSubscriber();
  }
}
