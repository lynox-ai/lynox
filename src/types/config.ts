// === 4.6 AgentConfig & MCPServer ===

import type { AnthropicBeta } from '@anthropic-ai/sdk/resources/beta/beta.js';

import type { ModelTier, ThinkingMode, EffortLevel } from './models.js';
import type { ToolEntry, StreamHandler } from './tools.js';
import type { TabQuestion } from './agent.js';
import type { IMemory, MemoryScopeRef, NodynContext } from './memory.js';
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
  promptUser?:      ((question: string, options?: string[]) => Promise<string>) | undefined;
  promptTabs?:      ((questions: TabQuestion[]) => Promise<string[]>) | undefined;
  maxIterations?:      number | undefined;
  continuationPrompt?: string | undefined;
  excludeTools?:       string[] | undefined;
  apiKey?:             string | undefined;
  apiBaseURL?:         string | undefined;
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

export const NODYN_BETAS: AnthropicBeta[] = [
  'token-efficient-tools-2025-02-19',
];

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
}

export interface NodynConfig {
  model?:          ModelTier | undefined;
  systemPrompt?:   string | undefined;
  thinking?:       ThinkingMode | undefined;
  effort?:         EffortLevel | undefined;
  maxTokens?:      number | undefined;
  mcpServers?:     MCPServer[] | undefined;
  memory?:         boolean | undefined;
  promptUser?:     ((question: string, options?: string[]) => Promise<string>) | undefined;
  promptTabs?:     ((questions: TabQuestion[]) => Promise<string[]>) | undefined;
  context?:        NodynContext | undefined;
}

// === User Config ===

export interface NodynUserConfig {
  api_key?: string | undefined;
  api_base_url?: string | undefined;
  default_tier?: ModelTier | undefined;
  thinking_mode?: 'adaptive' | 'disabled' | undefined;
  effort_level?: EffortLevel | undefined;
  max_session_cost_usd?: number | undefined;
  voyage_api_key?: string | undefined;
  embedding_provider?: 'voyage' | 'onnx' | 'local' | undefined;
  plugins?: Record<string, boolean> | undefined;
  agents_dir?: string | undefined;
  manifests_dir?: string | undefined;
  workspace_dir?: string | undefined;
  user_id?: string | undefined;
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
  /** API key for web search provider (Tavily or Brave) */
  search_api_key?: string | undefined;
  /** Web search provider: 'tavily' (default) or 'brave' */
  search_provider?: 'tavily' | 'brave' | undefined;
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
  /** Enable automatic memory extraction from responses. Default: true */
  memory_extraction?: boolean | undefined;
  /** Memory temporal decay half-life in days. Default: 90 */
  memory_half_life_days?: number | undefined;
  /** Pipeline step context truncation limit in chars. Default: 16000 */
  pipeline_context_limit?: number | undefined;
  /** Pipeline step result truncation limit in bytes. Default: 51200 */
  pipeline_step_result_limit?: number | undefined;
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
  /** Sentry DSN for opt-in error reporting. No data sent unless configured. */
  sentry_dsn?: string | undefined;
  /** Directory for backup storage. Default: ~/.nodyn/backups */
  backup_dir?: string | undefined;
  /** Cron schedule for automatic backups. Default: '0 3 * * *' (daily 3 AM). */
  backup_schedule?: string | undefined;
  /** Days to retain old backups. Default: 30. Set 0 to disable auto-deletion. */
  backup_retention_days?: number | undefined;
  /** Encrypt backups with vault key. Default: true when NODYN_VAULT_KEY is set. */
  backup_encrypt?: boolean | undefined;
  /** Upload backups to Google Drive. Default: true when Google auth is configured with drive.file scope. */
  backup_gdrive?: boolean | undefined;
  /** Persistent MCP server connections. Loaded on every Engine.init(). */
  mcp_servers?: Array<{ name: string; url: string }> | undefined;
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
  config: NodynUserConfig;
  log: (msg: string) => void;
}

export interface PluginHooks {
  onSessionStart?: (() => Promise<void>) | undefined;
  onRunComplete?: ((result: string) => Promise<void>) | undefined;
  onToolGate?: ((toolName: string, input: unknown) => Promise<boolean | undefined>) | undefined;
}

export type PluginExport = (ctx: PluginContext) => { tools?: ToolEntry[] | undefined; hooks?: PluginHooks | undefined };
