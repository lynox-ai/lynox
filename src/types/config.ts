// === 4.6 AgentConfig & MCPServer ===

import type { AnthropicBeta } from '@anthropic-ai/sdk/resources/beta/beta.js';

import type { ModelTier, ThinkingMode, EffortLevel, LLMProvider, ModelProfile } from './models.js';
import type { ToolEntry, StreamHandler } from './tools.js';
import type { TabQuestion, PromptUserFn, PromptTabsFn, PromptSecretFn } from './agent.js';
import type { IMemory, MemoryScopeRef, LynoxContext } from './memory.js';
import type { IWorkerPool } from './worker.js';
import type { AutonomyLevel, PreApprovalSet, CostGuardConfig } from './modes.js';
import type { SecretStoreLike, IsolationConfig } from './security.js';

export interface AgentConfig {
  name:             string;
  model:            string;
  systemPrompt?:    string | undefined;
  tools?:           ToolEntry[] | undefined;
  mcpServers?:      MCPServer[] | undefined;
  thinking?:        ThinkingMode | undefined;
  effort?:          EffortLevel | undefined;
  maxTokens?:       number | undefined;
  memory?:          IMemory | undefined;
  onStream?:        StreamHandler | undefined;
  workerPool?:      IWorkerPool | undefined;
  promptUser?:      PromptUserFn | undefined;
  promptTabs?:      PromptTabsFn | undefined;
  promptSecret?:    PromptSecretFn | undefined;
  maxIterations?:      number | undefined;
  continuationPrompt?: string | undefined;
  excludeTools?:       string[] | undefined;
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
  /** Model ID for OpenAI-compatible providers (e.g. 'mistral-large-latest'). Used with provider: 'openai'. */
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

export interface MCPServer {
  type: 'url';
  url:  string;
  name: string;
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
  mcpServers?:     MCPServer[] | undefined;
  memory?:         boolean | undefined;
  promptUser?:     ((question: string, options?: string[]) => Promise<string>) | undefined;
  promptTabs?:     ((questions: TabQuestion[]) => Promise<string[]>) | undefined;
  promptSecret?:   ((name: string, prompt: string, keyType?: string) => Promise<boolean>) | undefined;
  context?:        LynoxContext | undefined;
  /** Default response language (e.g. 'de', 'en'). */
  language?:       string | undefined;
}

// === User Config ===

export interface LynoxUserConfig {
  api_key?: string | undefined;
  api_base_url?: string | undefined;
  /** LLM provider: 'anthropic' (default), 'vertex' (GCP), 'custom' (proxy), or 'openai' (Mistral/Gemini). */
  provider?: LLMProvider | undefined;
  /** GCP project ID for Vertex AI provider. */
  gcp_project_id?: string | undefined;
  /** GCP region for Vertex AI (e.g. 'europe-west4', 'us-east5'). */
  gcp_region?: string | undefined;
  default_tier?: ModelTier | undefined;
  /** Maximum allowed model tier. StepHints and pipeline steps requesting a higher tier are clamped. Managed hosting sets 'sonnet'. */
  max_tier?: ModelTier | undefined;
  /**
   * Account-level plan tier, independent of LLM model tier. Controls
   * capability gating rather than model selection: e.g. the `researcher`
   * role accepts an explicit `model: 'opus'` override only when
   * `account_tier === 'pro'`; other tiers silently downgrade to Sonnet.
   * Defaults to `'standard'` (Starter/Managed). Set to `'pro'` on
   * Managed-Pro instances via env `LYNOX_ACCOUNT_TIER=pro` or config.
   */
  account_tier?: 'standard' | 'pro' | undefined;
  thinking_mode?: 'adaptive' | 'disabled' | undefined;
  effort_level?: EffortLevel | undefined;
  max_session_cost_usd?: number | undefined;
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
  /** Enable changeset review mode: backup files before write, review post-run. Default: true for interactive CLI. */
  changeset_review?: boolean | undefined;
  /** Enable Haiku auto-classification for memory scope selection. Default: true when >1 scope active. */
  memory_auto_scope?: boolean | undefined;
  /** Show auto-greeting on interactive REPL start. Default: true */
  greeting?: boolean | undefined;
  /** Telegram bot token from @BotFather */
  telegram_bot_token?: string | undefined;
  /** Restrict Telegram bot to specific chat IDs */
  telegram_allowed_chat_ids?: number[] | undefined;
  /** API key for Tavily web search provider */
  search_api_key?: string | undefined;
  /** Web search provider: 'tavily' or 'searxng' */
  search_provider?: 'tavily' | 'searxng' | undefined;
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
  /** Enable Knowledge Graph for entity-aware memory. Default: true */
  knowledge_graph_enabled?: boolean | undefined;
  /** Embedding model for ONNX provider. Default: 'multilingual-e5-small' */
  embedding_model?: 'all-minilm-l6-v2' | 'multilingual-e5-small' | 'bge-m3' | undefined;
  /** Google OAuth scopes to request. Defaults to read-only. Add write scopes as needed. */
  google_oauth_scopes?: string[] | undefined;
  /** Block plain HTTP requests (except localhost). Default: false */
  enforce_https?: boolean | undefined;
  /** Bugsink DSN for opt-in error reporting. No data sent unless configured. */
  bugsink_dsn?: string | undefined;
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
  /** Persistent MCP server connections. Loaded on every Engine.init(). */
  mcp_servers?: Array<{ name: string; url: string }> | undefined;
  /** Whitelist of MCP tool names to expose. When set, only listed tools are registered. Default: all tools. */
  mcp_exposed_tools?: string[] | undefined;
  /** Experience level: controls output style. 'business' (default) = UI-focused, no CLI/env hints. 'developer' (experimental) = technical details, CLI commands, config snippets. */
  experience?: 'business' | 'developer' | undefined;
  /** Model ID for OpenAI-compatible providers (e.g. 'mistral-large-latest'). Required when provider is 'openai'. */
  openai_model_id?: string | undefined;
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

export type DataStoreSchemaType = 'string' | 'number' | 'date' | 'boolean' | 'json';

export interface DataStoreColumnDef {
  name: string;
  type: DataStoreSchemaType;
  unique?: boolean | undefined;
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
