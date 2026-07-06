// === 4.6 AgentConfig ===

import type { AnthropicBeta } from '@anthropic-ai/sdk/resources/beta/beta.js';

import type { ModelTier, ThinkingMode, EffortLevel, LLMProvider, ModelProfile } from './models.js';
import type { ProviderKey } from './provider-registry.js';
import type { ToolEntry, StreamHandler } from './tools.js';
import type { TabQuestion, PromptUserFn, PromptTabsFn, PromptSecretFn, PromptMailConnectFn } from './agent.js';
import type { IMemory, MemoryScopeRef, LynoxContext } from './memory.js';
import type { IWorkerPool } from './worker.js';
import type { AutonomyLevel, PreApprovalSet, CostGuardConfig } from './modes.js';
import type { SecretStoreLike, IsolationConfig, NetworkPolicy } from './security.js';
import type { CapabilityContract } from './capability-contract.js';

export interface AgentConfig {
  name:             string;
  model:            string;
  systemPrompt?:    string | undefined;
  tools?:           ToolEntry[] | undefined;
  thinking?:        ThinkingMode | undefined;
  effort?:          EffortLevel | undefined;
  maxTokens?:       number | undefined;
  memory?:          IMemory | undefined;
  onStream?:        StreamHandler | undefined;
  workerPool?:      IWorkerPool | undefined;
  promptUser?:      PromptUserFn | undefined;
  promptTabs?:      PromptTabsFn | undefined;
  promptSecret?:    PromptSecretFn | undefined;
  promptMailConnect?: PromptMailConnectFn | undefined;
  maxIterations?:      number | undefined;
  continuationPrompt?: string | undefined;
  excludeTools?:       string[] | undefined;
  /**
   * User-preferred maximum context window in tokens — clamps the agent's
   * effective context window to `min(model_native, user_pref)`. Sourced from
   * the LLM-Advanced UI (200k / 500k / 1M radios — `/app/settings/llm/advanced`,
   * canonical home after PRD-IA-V2 P3-PR-X). When undefined the agent uses the
   * model's native window. Plumbed through to spawned sub-agents + pipeline
   * child agents so a single user preference applies tree-wide.
   */
  maxContextWindowTokens?: number | undefined;
  /**
   * Native context window DECLARED for a custom/BYOK/self-host model whose id
   * is not in the capability registry (a named `ModelProfile.context_window`,
   * or the self-host `openai_context_window` config field). Wins over the
   * id-based 200k fallback so trimming + UI usage reflect the real window.
   * Undefined for managed/Anthropic where the registry already knows the size.
   * Plumbed to sub-agents like `maxContextWindowTokens`.
   */
  nativeContextWindow?: number | undefined;
  apiKey?:             string | undefined;
  apiBaseURL?:         string | undefined;
  provider?:           LLMProvider | undefined;
  gcpProjectId?:       string | undefined;
  gcpRegion?:          string | undefined;
  currentRunId?:       string | undefined;
  spawnDepth?:         number | undefined;
  briefing?:           string | undefined;
  autonomy?:           AutonomyLevel | undefined;
  preApproval?:        PreApprovalSet | undefined;
  audit?:              PreApproveAuditLike | undefined;
  /**
   * Capability contract authorising headless outbound writes. RESERVED SEAM
   * (Slice A1): stored on the Agent + carried to the `isDangerous` enforcement
   * point beside `autonomy`/`preApproval`, but A1 attaches no logic —
   * `undefined` = the safe autonomous-deny default (PRD §4.2). Slice B enforces.
   */
  capabilityContract?: CapabilityContract | undefined;
  /** Knowledge context for system prompt. Truthy string = inject as Block 2. Falsy/undefined = no memory block. */
  knowledgeContext?:   string | undefined;
  secretStore?:        SecretStoreLike | undefined;
  userId?:             string | undefined;
  activeScopes?:       MemoryScopeRef[] | undefined;
  isolation?:          IsolationConfig | undefined;
  /** Per-agent cost guard config. Used by spawned agents to enforce budget limits. */
  costGuard?:          CostGuardConfig | undefined;
  /** Changeset manager for backup-before-write mode. When set, write_file skips permission prompt. */
  changesetManager?:   ChangesetManagerLike | undefined;
  /** Shared tool context — replaces closure-based module-level setters. */
  toolContext?:        import('../core/tool-context.js').ToolContext | undefined;
  /** Model ID for OpenAI-compatible providers (e.g. 'mistral-large-2512'). Used with provider: 'openai'. */
  openaiModelId?:      string | undefined;
  /** Auth mode for OpenAI provider. 'google-vertex' uses GOOGLE_APPLICATION_CREDENTIALS to generate OAuth tokens. */
  openaiAuth?:         'static' | 'google-vertex' | undefined;
  /** IANA timezone (e.g. 'Europe/Zurich') for the human user. Threaded through the per-turn `[Now: …]` marker so the model presents scheduled times in the user's wallclock, not UTC. */
  userTimezone?:       string | undefined;
  /**
   * Session-scoped counters (http_request count, write_file bytes). When the
   * Session creates its main Agent it allocates one object and passes the
   * same reference into every spawned sub-agent so the conversation
   * accumulates a single budget. Defaults to a fresh zero-counter object —
   * useful for ad-hoc agent construction outside a Session, less useful in
   * production where the Session should own the budget.
   */
  sessionCounters?:    import('./agent.js').SessionCounters | undefined;
  /**
   * Per-conversation blob store for large tool results evicted at the last
   * compaction (Phase 2 Context Hygiene). The Session allocates one and
   * threads the same reference into the main Agent + every sub-agent so the
   * `recall_tool_result` tool resolves handles regardless of which agent
   * issues the call. Undefined for ad-hoc Agents built outside a Session.
   */
  toolResultBlobStore?: import('../core/tool-result-blob-store.js').ToolResultBlobStore | undefined;
  /**
   * Eager-persist hook fired at every stable point in the agent loop (after
   * assistant message, after tool_results). Lets the Session checkpoint
   * messages to the ThreadStore mid-run so a container-restart or OOM kill
   * during a long run doesn't lose the in-memory message buffer. Without
   * this, persistence happened only at end-of-run — if the process died
   * mid-loop, all turns since the last completed run were unrecoverable
   * (2026-05-18 staging QA finding from rafael prod).
   *
   * Fire-and-forget — the hook should never throw or block the loop. Implementer
   * is responsible for its own error handling.
   */
  onMessageCheckpoint?: (() => void | Promise<void>) | undefined;
  /**
   * H-024 shadow mode: per-conversation `ToolCallTracker` for anomaly
   * observability. The Session owns one instance so the rolling 20-call
   * window survives Agent recreation (setModel / setEffort / _recreateAgent).
   * When set, the agent records each successful tool dispatch + calls
   * `checkAnomaly()` for channel-side-effect publishing — return value
   * intentionally discarded (shadow mode does NOT block dispatch or surface
   * a warning to the user). Enforcement-mode follow-up tracked for v1.7.3 /
   * v1.8.0 after we observe false-positive rate in production.
   */
  toolCallTracker?: import('../core/output-guard.js').ToolCallTracker | undefined;
}

/** Minimal interface to avoid circular deps between agent and changeset module */
export interface ChangesetManagerLike {
  readonly active: boolean;
  backupBeforeWrite(filePath: string): void;
}

/** Minimal interface for PreApproveAudit to avoid circular deps */
export interface PreApproveAuditLike {
  recordCheck(event: {
    setId: string;
    patternIdx: number;
    toolName: string;
    matchString: string;
    pattern: string;
    decision: 'approved' | 'exhausted' | 'expired' | 'no_match';
    autonomyLevel?: string | undefined;
    runId?: string | undefined;
  }): void;
}

// === 4.7 Beta Headers ===

/** Beta flags used by lynox. Vertex AI + Anthropic Direct both support extended cache TTL. */
export const LYNOX_BETAS: AnthropicBeta[] = [
  'token-efficient-tools-2025-02-19',
  'extended-cache-ttl-2025-04-11',
];

/** Return the beta flags appropriate for the given LLM provider. */
export function getBetasForProvider(provider: LLMProvider): AnthropicBeta[] {
  if (provider === 'custom' || provider === 'openai') return [];
  return [...LYNOX_BETAS];
}

// === Additional types for stubs ===

export interface SpawnSpec {
  name:             string;
  task:             string;
  system_prompt?:   string | undefined;
  model?:           ModelTier | undefined;
  thinking?:        ThinkingMode | undefined;
  effort?:          EffortLevel | undefined;
  max_tokens?:      number | undefined;
  tools?:           string[] | undefined;
  max_turns?:       number | undefined;
  max_budget_usd?:  number | undefined;
  role?:            string | undefined;
  context?:         string | undefined;
  isolated_memory?: boolean | undefined;
  isolation?:        IsolationConfig | undefined;
  /** Named model profile for non-Claude provider (e.g. 'mistral-eu', 'gemini-research'). */
  profile?:         string | undefined;
}

export interface LynoxConfig {
  model?:          ModelTier | undefined;
  systemPrompt?:   string | undefined;
  thinking?:       ThinkingMode | undefined;
  effort?:         EffortLevel | undefined;
  maxTokens?:      number | undefined;
  memory?:         boolean | undefined;
  promptUser?:     ((question: string, options?: string[]) => Promise<string>) | undefined;
  promptTabs?:     ((questions: TabQuestion[]) => Promise<string[]>) | undefined;
  promptSecret?:   PromptSecretFn | undefined;
  context?:        LynoxContext | undefined;
  /** Default response language (e.g. 'de', 'en'). */
  language?:       string | undefined;
}

// === User Config ===

/** One tier's provider+model assignment in a hybrid Tier-Set. */
export interface TierSlot {
  /** Provider key — a registry id (incl. the first-class 'mistral'). */
  provider: ProviderKey;
  /** Concrete model id to send for this tier. */
  model_id: string;
  /** Per-slot API key. Self-host/BYOK only; managed ignores it (CP supplies keys). */
  api_key?: string | undefined;
  /** Per-slot API base URL (e.g. an OpenAI-compatible endpoint). */
  api_base_url?: string | undefined;
}

/**
 * Per-tier provider+model assignment for hybrid routing. Partial — a tier with
 * no slot falls back to the base `provider`. Only consulted when
 * `routing_mode === 'hybrid'`.
 */
export type TierSet = Partial<Record<ModelTier, TierSlot>>;

/**
 * Runtime guard for a {@link TierSlot} — checks the required fields a downstream
 * resolver dereferences (`provider`, `model_id`). Used at the untrusted
 * `LYNOX_TIER_SET_JSON` env boundary so a malformed slot is dropped rather than
 * reaching client construction as `Bearer undefined`.
 */
export function isTierSlot(value: unknown): value is TierSlot {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['provider'] === 'string' && v['provider'].length > 0 &&
    typeof v['model_id'] === 'string' && v['model_id'].length > 0
  );
}

export interface LynoxUserConfig {
  api_key?: string | undefined;
  api_base_url?: string | undefined;
  /** LLM provider: 'anthropic' (default), 'vertex' (GCP), 'custom' (proxy), or 'openai' (Mistral/Gemini). */
  provider?: LLMProvider | undefined;
  /**
   * Saved Custom-provider endpoints (LiteLLM-friendly). Each entry is a
   * bookmark — clicking "Use" in the UI swaps `api_base_url` to its url.
   * Pure UI state; the engine still reads `api_base_url` as before.
   */
  custom_endpoints?: ReadonlyArray<{ id: string; name: string; base_url: string }> | undefined;
  /**
   * Server-persisted disclosure acceptances for non-allowlisted custom
   * endpoints (host + ISO timestamp). Written by PUT /api/config when the
   * controller-responsibility gate accepts a custom endpoint; the engine's
   * reload/boot allowlist gate honours a host listed here (a durable record
   * of a prior explicit acceptance) so a saved custom endpoint reloads
   * cleanly. Replaces the old per-tab sessionStorage flag.
   */
  accepted_custom_endpoints?: ReadonlyArray<{ host: string; accepted_at: string }> | undefined;
  /** GCP project ID for Vertex AI provider. */
  gcp_project_id?: string | undefined;
  /** GCP region for Vertex AI (e.g. 'europe-west4', 'us-east5'). */
  gcp_region?: string | undefined;
  default_tier?: ModelTier | undefined;
  /** Maximum allowed model tier — the cost ceiling. Requests for a higher tier (StepHints, pipeline steps, run-options) are clamped via `clampTier`. Post-D8 this is the sole tier cap (the budget caps spend); managed + managed_pro set `'deep'`. */
  max_tier?: ModelTier | undefined;
  /**
   * Account-level plan tier, independent of LLM model tier. Post-D8
   * (2026-06) it NO LONGER gates model/tier selection — `applyTierGate`
   * (roles.ts) is a pass-through, so the `max_tier` clamp + the budget are
   * the only caps; every account can reach any allowed-provider model.
   * Retained as a vestigial capability label (the param is still threaded
   * for caller stability / forward-compat). Defaults to `'standard'`; set to
   * `'pro'` on Managed-Pro via env `LYNOX_ACCOUNT_TIER=pro` or config.
   */
  account_tier?: 'standard' | 'pro' | undefined;
  /**
   * Model routing mode. 'standard' (default) = one `provider` for all tiers.
   * 'hybrid' = each tier may use a different provider+model via `tier_set`.
   * A distinct axis from the legacy `llm_mode` (a retiring residency axis).
   */
  routing_mode?: 'standard' | 'hybrid' | undefined;
  /**
   * Hybrid Tier-Set: per-tier {provider, model_id, api_key?, api_base_url?}.
   * Only consulted when `routing_mode === 'hybrid'`; an unset tier falls back to
   * the base `provider`.
   */
  tier_set?: TierSet | undefined;
  /**
   * Whether the control plane supplies the LLM key (config mirror of
   * `cpSuppliesLLMKey` / billing-tier). Set from `LYNOX_BILLING_TIER`; the
   * managed tier_set allowlist (PR-3b) is gated on this.
   */
  cp_supplied?: boolean | undefined;
  thinking_mode?: 'adaptive' | 'disabled' | undefined;
  effort_level?: EffortLevel | undefined;
  /**
   * Which concrete Sonnet the `balanced` tier resolves to (opt-in Sonnet
   * variant selection). One of the served Sonnet ids — `'claude-sonnet-4-6'`
   * (default when unset) or `'claude-sonnet-5'`. An unrecognised value falls
   * back safely to Sonnet 4.6 at `resolveBalancedModel`. Loaded from config,
   * project config, or the `LYNOX_BALANCED_MODEL` env var.
   */
  balanced_model?: string | undefined;
  max_session_cost_usd?: number | undefined;
  /** Max chat runs executing concurrently across all threads (Tier-2 run
   *  executor). Bounds LLM-cost blast + run-buffer memory from many parallel
   *  headless runs. A fresh dispatch past this is refused with HTTP 429
   *  (`run_queue_full`). Defaults to 5. */
  max_concurrent_runs?: number | undefined;
  embedding_provider?: 'onnx' | 'local' | undefined;
  plugins?: Record<string, boolean> | undefined;
  agents_dir?: string | undefined;
  manifests_dir?: string | undefined;
  workspace_dir?: string | undefined;
  user_id?: string | undefined;
  display_name?: string | undefined;
  /** Default response language (e.g. 'de', 'en'). Overridden by user's language in conversation. */
  language?: string | undefined;
  organization_id?: string | undefined;
  client_id?: string | undefined;
  /** Enable changeset review mode: backup files before write, review post-run. Default: true for single-task CLI runs. */
  changeset_review?: boolean | undefined;
  /** Enable Haiku auto-classification for memory scope selection. Default: true when >1 scope active. */
  memory_auto_scope?: boolean | undefined;
  /** Show auto-greeting on session start (web UI / HTTP API). Default: true */
  greeting?: boolean | undefined;
  /** Deprecated 2026-05-24 — Tavily backend retired. Field retained as
   *  `string | undefined` for migration-import compatibility with older
   *  config.json snapshots; the engine no longer reads it. */
  search_api_key?: string | undefined;
  /** Deprecated 2026-05-24 — Tavily backend retired. Only `'searxng'` is
   *  meaningful; left in place for migration compatibility. */
  search_provider?: 'searxng' | undefined;
  /** SearXNG instance URL (e.g. http://localhost:8888). Default web search provider when configured. */
  searxng_url?: string | undefined;
  /** Google OAuth client ID (from GCP Console) */
  google_client_id?: string | undefined;
  /** Google OAuth client secret (from GCP Console) */
  google_client_secret?: string | undefined;
  /** Maximum daily spending cap (USD). Enforced across sessions via run history. */
  max_daily_cost_usd?: number | undefined;
  /** Maximum monthly spending cap (USD). Enforced across sessions via run history. */
  max_monthly_cost_usd?: number | undefined;
  /**
   * Preferred maximum context-window size in tokens. UI options: 200_000
   * (Standard), 500_000 (Extended), 1_000_000 (Maximum). The agent clamps
   * its message-history trim window to this hint when the underlying model
   * supports a larger native window than the user wants to pay for. Default:
   * provider/model's native context window (see types/models.ts).
   */
  max_context_window_tokens?: number | undefined;
  /**
   * L1 cost-aware compaction (PRD engine-context-cost). Absolute carried-token
   * budget at which compaction is OFFERED (auto-compaction at budget × 1.125);
   * the trigger fires on `min(this, % of the context window)`, so on a large
   * (e.g. 1M) window a thread compacts at this budget instead of ~800K —
   * bounding the cache-read floor that dominates heavy-thread cost. CP-tuned
   * (not in the managed-user allowlist). Default: 150_000 (`DEFAULT_COMPACTION_TOKEN_BUDGET`).
   */
  compaction_token_budget?: number | undefined;
  /** Max HTTP requests per hour (across sessions). */
  max_http_requests_per_hour?: number | undefined;
  /** Max HTTP requests per day (across sessions). */
  max_http_requests_per_day?: number | undefined;
  /** Max mail sends per hour, per tool (mail_send / mail_reply). Default 50. */
  max_mail_sends_per_hour?: number | undefined;
  /** Max mail sends per day, per tool (mail_send / mail_reply). Default 200. */
  max_mail_sends_per_day?: number | undefined;
  /** Per-recipient dedup window in seconds — same (recipients, subject) within this window is rejected. Default 60. */
  mail_dedup_window_sec?: number | undefined;
  /** Enable automatic memory extraction from responses. Default: true */
  memory_extraction?: boolean | undefined;
  /** Memory temporal decay half-life in days. Default: 90 */
  memory_half_life_days?: number | undefined;
  /** Pipeline step context truncation limit in chars. Default: 16000 */
  pipeline_context_limit?: number | undefined;
  /** Pipeline step result truncation limit in bytes. Default: 51200 */
  pipeline_step_result_limit?: number | undefined;
  /** Per-pipeline-run interactive prompt budget (ask_user / ask_secret). Default: 5 */
  pipeline_prompt_budget?: number | undefined;
  /** Memory extraction input truncation limit in chars. Default: 16000 */
  memory_extraction_limit?: number | undefined;
  /** HTTP response body size limit in bytes. Default: 100000 */
  http_response_limit?: number | undefined;
  /** Max chars for a single tool result before truncation. Default: 80000 */
  max_tool_result_chars?: number | undefined;
  /**
   * Phase 2 Context Hygiene: minimum tool-result payload size in chars for
   * eviction into the recall blob store at compaction. A result above this
   * size is preserved (recallable via `recall_tool_result`) instead of being
   * lost when `compact()` resets the message history. Default: 4096.
   */
  tool_result_blob_threshold_chars?: number | undefined;
  /**
   * Context-cost Slice 0: when true, the agent appends one per-turn context
   * composition snapshot to `~/.lynox/context-cost.jsonl` (best-effort). Gives
   * ground-truth context breakdown for the cost-cut investigation without a
   * thread export (which is rendered display text, not the billed context).
   * Default: false — zero overhead when unset.
   */
  context_cost_log?: boolean | undefined;
  /** Enable Knowledge Graph for entity-aware memory. Default: true */
  knowledge_graph_enabled?: boolean | undefined;
  /**
   * Foundation Rework v2 (S1b): mirror the agent's knowledge extraction into the
   * engine.db subject-graph (subjects + relationships + cooccurrences + a memory
   * provenance stub) ADDITIVELY, alongside the legacy agent-memory.db writes.
   * Default: false — prod stays legacy-only until the S2 data migration flips it.
   * Staging/local set `true` to populate + verify the new graph in place. The
   * legacy stores remain the read/retrieval authority through S1 regardless.
   * Requires `knowledge_graph_enabled` (the mirror feeds off KG extraction): on a
   * KG-disabled tenant, or one with no embedding provider, this flag is inert.
   */
  subject_graph_enabled?: boolean | undefined;
  /**
   * Foundation Rework v2 (S5b): re-point the memory RECALL reads (vector search +
   * graph-expand + the no-query recency list) from the legacy agent-memory.db onto
   * the engine.db subject-graph `memories`. Default: false — recall stays on the
   * legacy store until a per-tenant cutover. CO-GATED on `subject_graph_enabled`:
   * engine.db `memories` is only populated (dual-write + the s5-backfill) when the
   * mirror is on, so recall over an unpopulated store would under-return — the read
   * path treats this flag as inert unless `subject_graph_enabled` is also true. The
   * legacy store stays the WRITE authority (dual-write) through S5b'; a failed
   * engine.db read falls back to legacy per-read, so flipping this can never fail a
   * recall. Requires the s5-backfill to have run on the tenant first.
   */
  memory_graph_reads?: boolean | undefined;
  /** Embedding model for ONNX provider. Default: 'multilingual-e5-small' */
  embedding_model?: 'all-minilm-l6-v2' | 'multilingual-e5-small' | 'bge-m3' | undefined;
  /** Google OAuth scopes to request. Defaults to read-only. Add write scopes as needed. */
  google_oauth_scopes?: string[] | undefined;
  /** Block plain HTTP requests (except localhost). Default: false */
  enforce_https?: boolean | undefined;
  /**
   * Outbound egress policy for the agent's GENERAL-PURPOSE network tools:
   * `http_request`, the `api_setup` probe, and `web_research` (both the search
   * query AND the page/content fetch). Default 'allow-all' = today's behaviour,
   * unchanged. 'deny-all' = those tools cannot reach the network. 'allow-list' =
   * they may reach ONLY the hosts in `network_allowed_hosts`.
   *
   * SCOPE — this is NOT a full process air-gap. It gates the agent-driven HTTP
   * tool surface only. It does NOT gate: the LLM provider call (separate client),
   * mail IMAP/SMTP, push notifications, Google Workspace, voice transcribe/TTS,
   * backup upload, or error reporting — each is its own separately-configured
   * egress surface. A cross-integration air-gap is a separate control.
   *
   * The allow-list is AUTHORITATIVE: it is NOT auto-extended by configured API
   * profiles, because `api_setup` is agent-callable and auto-trusting profile
   * hosts would let the agent self-authorise egress and defeat the gate. An
   * operator who opts into allow-list lists the hosts they want reachable.
   *
   * Operator/CP security control — deliberately NOT in
   * `MANAGED_USER_WRITABLE_CONFIG` and not agent-writable (a tenant/agent must
   * not be able to widen its own egress).
   */
  network_policy?: NetworkPolicy | undefined;
  /**
   * Hosts reachable when `network_policy` is 'allow-list'. Exact hostnames plus
   * `*.example.com` wildcards (matches the apex + any subdomain). Ignored for
   * 'allow-all'/'deny-all'. See `applyNetworkPolicy` in tool-context.ts.
   */
  network_allowed_hosts?: string[] | undefined;
  /** Bugsink DSN for opt-in error reporting. No data sent unless configured. */
  bugsink_dsn?: string | undefined;
  /** Toggle for the error-reporting pipe. Default true when DSN is set. */
  bugsink_enabled?: boolean | undefined;
  /** Tool names disabled by the user in Settings. Hidden from the agent at session start (server-side enforcement). */
  disabled_tools?: string[] | undefined;
  /** Directory for backup storage. Default: ~/.lynox/backups */
  backup_dir?: string | undefined;
  /** Cron schedule for automatic backups. Default: '0 3 * * *' (daily 3 AM). */
  backup_schedule?: string | undefined;
  /** Days to retain old backups. Default: 30. Set 0 to disable auto-deletion. */
  backup_retention_days?: number | undefined;
  /** Encrypt backups with vault key. Default: true when LYNOX_VAULT_KEY is set. */
  backup_encrypt?: boolean | undefined;
  /** Upload backups to Google Drive. Default: true when Google auth is configured with drive.file scope. */
  backup_gdrive?: boolean | undefined;
  /** Experience level: controls output style. 'business' (default) = UI-focused, no CLI/env hints. 'developer' (experimental) = technical details, CLI commands, config snippets. */
  experience?: 'business' | 'developer' | undefined;
  /** Model ID for OpenAI-compatible providers (e.g. 'mistral-large-2512'). Required when provider is 'openai'. */
  openai_model_id?: string | undefined;
  /**
   * Native context window (tokens) for a self-host openai-compat model whose
   * id is not in the capability registry (e.g. a self-hosted Ministral on a
   * custom host). Without it the engine assumes the 200k fallback and trims
   * history / shows context usage against the wrong size. Ignored for managed
   * (registry-known) and Anthropic. Self-host / BYOK only — this field is not
   * in `MANAGED_USER_WRITABLE_CONFIG` (http-api.ts), so a managed tenant PUT to
   * it is rejected; managed Mistral is registry-known and never needs it.
   */
  openai_context_window?: number | undefined;
  /** Named model profiles for non-Claude providers (Mistral, Gemini, Grok, etc.). */
  model_profiles?: Record<string, ModelProfile> | undefined;
  /** Model profile to use for background tasks (WorkerLoop, Cron). Uses Claude if unset. */
  worker_profile?: string | undefined;
  /**
   * LLM mode for managed instances. 'standard' (default) uses Claude Sonnet 4.6 via Anthropic Direct.
   * 'eu-sovereign' switches the main LLM to Mistral Large 3 via the OpenAI adapter (Paris) — full
   * EU data sovereignty, no CLOUD Act exposure. Toggleable in the Web UI under Settings → LLM Mode.
   * Engine.init() reads this and overrides provider/api_key/api_base_url at runtime.
   */
  llm_mode?: 'standard' | 'eu-sovereign' | undefined;
  /**
   * Audio transcription provider.
   *   'mistral' → Mistral Voxtral Mini Transcribe v2 (requires MISTRAL_API_KEY)
   *   'whisper' → local whisper.cpp (requires whisper-cli + ggml models)
   *   'auto'    → Mistral if MISTRAL_API_KEY is set, else whisper.cpp
   * Env var `LYNOX_TRANSCRIBE_PROVIDER` overrides this.
   */
  transcription_provider?: 'mistral' | 'whisper' | 'auto' | undefined;
  /**
   * Text-to-speech provider.
   *   'mistral' → Mistral Voxtral TTS (requires MISTRAL_API_KEY)
   *   'auto'    → Mistral if MISTRAL_API_KEY is set, else none
   * Env var `LYNOX_TTS_PROVIDER` overrides this.
   */
  tts_provider?: 'mistral' | 'auto' | undefined;
  /**
   * TTS voice slug (e.g. 'en_paul_neutral'). When unset, the provider falls
   * back to its DEFAULT_VOICE. The Web UI populates the picker from the live
   * Mistral voices catalog (`GET /v1/audio/voices`) so new voices show up
   * without a code change.
   */
  tts_voice?: string | undefined;
}

// === DataStore ===

export type DataStoreSchemaType = 'string' | 'number' | 'date' | 'boolean' | 'json' | 'subject';

/**
 * Subject kinds a `subject`-typed DataStore column may link its rows to. Limited
 * to the NAME-DEDUPED kinds because a subject column resolves rows by NAME —
 * `engagement` (composite identity) and `other` (unstructured) are excluded, as
 * they would mint a fresh subject per insert. MUST stay in sync with
 * `NAME_DEDUPED_SUBJECT_KINDS` in `core/subject-store.ts` (the runtime source of
 * truth); duplicated here only to keep `src/types` a leaf with no import back
 * into `core`. A drift-guard test (`subject-store.test.ts`) asserts they match.
 */
export type DataStoreSubjectKind =
  | 'person' | 'organization' | 'product' | 'service';

/**
 * Optional semantic role for a column. The sole role today is `occurred_at`: it
 * marks WHICH `date` column records when the row's event actually happened (an
 * invoice's issue date, an appointment's time) — as opposed to `_created_at`
 * (insert time). At most one column per collection may carry it, and only a
 * `date` column. Stored + validated now; the per-subject timeline read (R2b)
 * consumes it to order records by occurrence. Deliberately a single optional
 * literal, NOT a general column-role system — widen the union only when a second
 * role earns its way in (anti-manie).
 */
export type DataStoreColumnRole = 'occurred_at';

export interface DataStoreColumnDef {
  name: string;
  type: DataStoreSchemaType;
  unique?: boolean | undefined;
  /**
   * For a `subject`-typed column ONLY: which subject kind to find-or-create the
   * linked subject as. The kind is part of the dedup IDENTITY — a `vendor`
   * column resolved as `person` would never merge with the real `organization`
   * subject (permanent spine pollution) — so `data_store_create` REQUIRES it on
   * any `subject` column. Ignored for every other column type.
   */
  subjectKind?: DataStoreSubjectKind | undefined;
  /**
   * Marks a `date` column as the record's OCCURRENCE time (when the event
   * happened) rather than `_created_at` (when it was inserted). At most one per
   * collection. Consumed by the per-subject timeline read; ignored otherwise.
   */
  role?: DataStoreColumnRole | undefined;
}

export interface DataStoreCollectionInfo {
  name: string;
  scopeType: string;
  scopeId: string;
  columns: DataStoreColumnDef[];
  uniqueKey: string[] | null;
  recordCount: number;
  createdAt: string;
  updatedAt: string;
}

export type DataStoreAggFn = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'count_distinct';

export interface DataStoreMetric {
  field: string;
  fn: DataStoreAggFn;
  alias?: string | undefined;
}

export interface DataStoreAggregation {
  groupBy?: string[] | undefined;
  metrics: DataStoreMetric[];
}

export interface DataStoreSort {
  field: string;
  order: 'asc' | 'desc';
}

// === Plugin System ===

export interface PluginContext {
  projectDir: string;
  config: LynoxUserConfig;
  log: (msg: string) => void;
}

export interface PluginHooks {
  onSessionStart?: (() => Promise<void>) | undefined;
  onRunComplete?: ((result: string) => Promise<void>) | undefined;
  onToolGate?: ((toolName: string, input: unknown) => Promise<boolean | undefined>) | undefined;
}

export type PluginExport = (ctx: PluginContext) => { tools?: ToolEntry[] | undefined; hooks?: PluginHooks | undefined };

// ── Capability-gating types (PRD-SETTINGS-REFACTOR Principle 6) ──

/** Lock entry for a setting that is read-only on the current tier.
 *  `upgrade_cta` points to a tier-upgrade path (rare — usually only
 *  shown for self-host → managed migration). `contact_cta` points to
 *  a quota-change channel (typical for managed → support@). */
export interface CapabilityLock {
  reason: 'managed-tier' | 'env-override' | 'capability-missing';
  upgrade_cta?: { href: string; label: string } | undefined;
  contact_cta?: { href: string; label: string } | undefined;
}

/**
 * Map of locked setting → lock metadata. Empty on self-host / BYOK.
 *
 * `provider`: legacy hard-lock — set when the operator pinned a provider via
 *   `~/.lynox/config.json` and the UI must refuse all switches. NOT set on
 *   default Managed any more (P3-FOLLOWUP-HOTFIX, 2026-05-17); Managed now
 *   carries the narrower `custom_provider_endpoints` lock so curated
 *   providers (Anthropic, Mistral) stay switchable.
 * `custom_provider_endpoints`: free-text base_url tiles disabled (Managed).
 *   Mirror in code: catalog entries with `requires_base_url === true`.
 */
export type CapabilityLocks = Partial<Record<'provider' | 'custom_provider_endpoints' | 'limits' | 'custom_endpoints' | 'context_window' | 'thinking_effort', CapabilityLock>>;
