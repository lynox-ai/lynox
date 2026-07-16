// === 4.4 IAgent Interface ===

import type { ToolEntry, StreamHandler } from './tools.js';
import type { IMemory, MemoryScopeRef } from './memory.js';
import type { SecretStoreLike, IsolationConfig } from './security.js';
import type { AutonomyLevel } from './modes.js';
import type { AgentWarning } from './models.js';

export interface TabQuestion {
  question: string;
  header?: string | undefined;
  options?: string[] | undefined;
}

/**
 * Optional metadata threaded through prompt callbacks so the surfacing
 * layer (HTTP API SSE, MCP, CLI) can tag the prompt with the originating
 * pipeline step. Sub-agent spawners populate this when a pipeline step
 * triggers ask_user / ask_secret; the main-agent ask_user path leaves it
 * undefined.
 */
export interface PromptMeta {
  stepId?: string | undefined;
  stepTask?: string | undefined;
  /** Render the option pills as MULTI-select (toggle several, then an explicit
   *  Send) instead of single-select auto-send. The answer comes back as a
   *  JSON-encoded string[] of the chosen labels. Default false. */
  multiSelect?: boolean | undefined;
}

export type PromptUserFn = (question: string, options?: string[], meta?: PromptMeta) => Promise<string>;
export type PromptTabsFn = (questions: TabQuestion[], meta?: PromptMeta) => Promise<string[]>;

/** Four distinct outcomes for an ask_secret prompt:
 *  - 'saved'           : user submitted, vault accepted
 *  - 'canceled'        : user clicked cancel
 *  - 'managed_blocked' : managed-tier write-allowlist rejected the name (403)
 *  - 'vault_error'     : server-side vault write failed (NOT a user cancel)
 *
 * Distinguishing these lets the agent stop conflating server-side rejection
 * with user intent — previously 'managed_blocked' surfaced as 'canceled',
 * which trained the model to offer plaintext fallbacks. See PRD/feedback
 * 2026-05-18.
 */
export type SecretOutcome = 'saved' | 'canceled' | 'managed_blocked' | 'vault_error';
export type PromptSecretFn = (name: string, prompt: string, keyType?: string, meta?: PromptMeta) => Promise<SecretOutcome>;

/** One IMAP or SMTP endpoint, as shown in the connect-mail consent UI. */
export interface MailConnectServer {
  host: string;
  port: number;
  /** Implicit TLS (true) vs STARTTLS/plain upgrade (false). */
  secure: boolean;
}

/**
 * Staged mail-account data carried by a `connect_mail` prompt. This is the
 * UI/wire projection the in-chat consent step renders + forwards to
 * `POST /api/mail/accounts` — deliberately a flat DTO of primitives (NOT the
 * internal `MailAccountConfig`) so the IAgent layer stays free of mail-
 * integration imports. The PASSWORD is never part of this payload: the user
 * enters it in the consent field and it goes straight to the mail-account
 * route, never through the agent/model.
 */
export interface MailConnectPromptData {
  /** Account id the new mailbox is stored under (collision-checked at addAccount). */
  id: string;
  /** Human-friendly account label. */
  displayName: string;
  /** The email address being connected (also the IMAP/SMTP username). */
  address: string;
  /** Preset slug ('gmail' | 'icloud' | 'fastmail' | 'yahoo' | 'outlook' | 'custom'). */
  preset: string;
  /** Semantic account role (a `MailAccountType`, default 'personal'). */
  type: string;
  imap: MailConnectServer;
  smtp: MailConnectServer;
  /** Preset-specific URL where the user generates an app-password. Undefined for 'custom'. */
  appPasswordUrl?: string | undefined;
  /** True when the provider gates app-passwords behind 2FA enrolment — a UI hint. */
  requires2FA?: boolean | undefined;
}

/** Two outcomes for a connect_mail prompt:
 *  - 'connected' : user submitted, the mail-account route accepted the account
 *  - 'canceled'  : user dismissed the consent step (or it expired/aborted)
 *
 * No managed-block outcome exists here (unlike SecretOutcome): the mail-account
 * route is NOT walled by the infra-secret deny-list, so the managed wall that
 * blocks agent-driven `ask_secret` for MAIL_ACCOUNT_* names does not apply. */
export type MailConnectOutcome = 'connected' | 'canceled';
export type PromptMailConnectFn = (data: MailConnectPromptData, meta?: PromptMeta) => Promise<MailConnectOutcome>;

/**
 * Mutable per-Session state previously held as module-level globals in
 * the tools layer. Session owns the object and threads the same
 * reference into the main Agent + every spawned sub-agent, so one
 * conversation accumulates one budget + one approval set across all of
 * its agents.
 *
 * Each Session instance gets a fresh object — counters and approvals
 * reset between sessions instead of leaking for the lifetime of the
 * process. Name retains "Counters" for diff-cleanliness with step 2 of
 * the migration; fields beyond `httpRequests`/`writeBytes` carry richer
 * per-Session state.
 */
export interface SessionCounters {
  /** Number of http_request invocations charged to this Session. */
  httpRequests: number;
  /** Total bytes written by write_file in this Session. */
  writeBytes: number;
  /**
   * Cumulative USD cost spent by this Session's LLM runs + spawned
   * sub-agents + pipeline steps. Used by `checkSessionBudget()` to
   * refuse fan-outs that would breach the session cap (default $50,
   * configurable via `max_session_cost_usd`). Reset between sessions —
   * previously a module-level `sessionCostUSD` that accumulated for
   * the lifetime of the engine process.
   */
  costUSD: number;
  /**
   * Hostnames the user has approved for outbound writes (POST/PUT/PATCH)
   * within this Session. Approval does not carry between Sessions — a
   * new conversation re-prompts.
   */
  approvedOutboundDomains: Set<string>;
  /**
   * In-flight permission prompts keyed by hostname. Parallel
   * `http_request` tool_use blocks against the same host must share one
   * prompt — the PromptStore has a UNIQUE index per session_id WHERE
   * status='pending', so a second concurrent insertAskUser throws
   * PromptConflictError. Without a shared promise, calls 2..N of a
   * five-way parallel batch all fail with "Session already has a
   * pending prompt" before the user even sees the first prompt.
   */
  pendingOutboundPrompts: Map<string, Promise<boolean>>;
}

/**
 * Snapshot of an Agent's provider config — returned by `IAgent.getProviderConfig()`
 * for sub-agent inheritance in spawn.ts. Carries credentials, so callers must
 * pipe directly to AgentConfig and never log / serialize / send to telemetry.
 */
export interface ProviderConfigSnapshot {
  readonly provider: import('./models.js').LLMProvider;
  readonly apiKey: string | undefined;
  readonly apiBaseURL: string | undefined;
  readonly openaiModelId: string | undefined;
  readonly openaiAuth: 'static' | 'google-vertex' | undefined;
}

export interface IAgent {
  readonly name:   string;
  readonly model:  string;
  readonly memory: IMemory | null;
  readonly tools:  ToolEntry[];
  /** Filtered tool list honouring excludeTools — propagate this to sub-agents. */
  getAvailableTools(): ToolEntry[];
  /** Snapshot of the agent's excludeTools — propagate to sub-agents for defense-in-depth. */
  getExcludedToolNames(): readonly string[];
  /** User-preferred max context window — propagate to sub-agents so the cap applies tree-wide. */
  getMaxContextWindowTokens(): number | undefined;
  /** Declared native window for a custom/BYOK/self-host model — propagate to sub-agents so they trim against the real window, not the 200k id-fallback. */
  getNativeContextWindow(): number | undefined;
  /** Init-time warnings (e.g. thinking-flag dropped on Mistral). Engine surface for HTTP-API SSE toast events. Returns empty array when no warnings. */
  getWarnings(): readonly AgentWarning[];
  /**
   * Provider config snapshot for sub-agent inheritance (spawn.ts). Closes the
   * gap where managed-tier UI provider-switch wasn't reflected in `loadConfig()`.
   *
   * **DO NOT LOG** — returned `apiKey` is plaintext. Pipe only to AgentConfig
   * construction; never to telemetry, error-report, or stdout.
   */
  getProviderConfig(): ProviderConfigSnapshot;
  onStream:        StreamHandler | null;
  promptUser?: PromptUserFn | undefined;
  promptTabs?: PromptTabsFn | undefined;
  promptSecret?: PromptSecretFn | undefined;
  /** Raise an in-chat `connect_mail` consent prompt so the user enters the
   * mailbox app-password in a secure field that never enters the agent/model
   * context. Undefined when no interactive surface is available (autonomous
   * mode, headless). See {@link PromptMailConnectFn}. */
  promptMailConnect?: PromptMailConnectFn | undefined;
  currentRunId?: string | undefined;
  currentThreadId?: string | undefined;
  /** Wave 1.2: has this run seen wrapped untrusted content? Read by the memory tools
   *  (`sourceUntrusted` evidence) and by spawn to propagate a child's taint to a parent
   *  that shares its Memory. */
  readonly sawUntrustedData?: boolean | undefined;
  /** DK.1 (H4): has any EXTERNAL-content tool (bash/http/read_file/media/api_setup/mail/…)
   *  run this turn? Read by `remember` — ORed with {@link sawUntrustedData} to derive
   *  `sourceUntrusted`, since the content marker is allowlist-by-omission. */
  readonly sawExternalContentTool?: boolean | undefined;
  /** DK.1 F5: has THIS CONVERSATION (sticky across turns, not just this run) ingested untrusted
   *  content? Read by `remember`/`memory_block_edit`/`memory_retire` — ORed with the per-run
   *  signals so a deferred injected write ("remember … on your next reply") on a later clean turn
   *  still routes to pending_review instead of active+pinned. */
  readonly conversationSawUntrusted?: boolean | undefined;
  /** DK.1: whether the durable knowledge substrate is on for this agent — read by spawn so a
   *  child inherits the flag (else a sub-agent on an ON tenant would still run legacy extraction). */
  readonly durableMemoryEnabled?: boolean | undefined;
  /** Wave 1.2: mark this run as having seen untrusted content — used by spawn to
   *  propagate a shared-Memory child's taint onto the parent. */
  noteUntrustedData?(): void;
  readonly spawnDepth?: number | undefined;
  readonly secretStore?: SecretStoreLike | undefined;
  readonly userId?: string | undefined;
  readonly activeScopes?: MemoryScopeRef[] | undefined;
  readonly isolation?: IsolationConfig | undefined;
  readonly autonomy?: AutonomyLevel | undefined;
  /**
   * Capability contract governing this (headless) agent's outbound writes. Read
   * by the `http_request` tool's first-use-consent gate so a contract-granted
   * write is recognised as pre-declared consent. Undefined for in-session agents
   * (they have a live approver). See `types/capability-contract.ts`.
   */
  readonly capabilityContract?: import('./capability-contract.js').CapabilityContract | undefined;
  readonly toolContext: import('../core/tool-context.js').ToolContext;
  /**
   * Mutable session-scoped counters shared with sub-agents. See
   * {@link SessionCounters}.
   */
  readonly sessionCounters: SessionCounters;
  /**
   * Per-conversation store of large tool results evicted at the last
   * compaction. The `recall_tool_result` tool reads it to re-fetch a payload
   * by handle id. Owned by the Session; undefined for ad-hoc Agents built
   * outside a Session. See {@link import('../core/tool-result-blob-store.js').ToolResultBlobStore}.
   */
  readonly toolResultBlobStore?: import('../core/tool-result-blob-store.js').ToolResultBlobStore | undefined;
  /**
   * IANA timezone for the human user, propagated to sub-agents so scheduled
   * times render in the user's wallclock. Mutable (no `readonly`) so the host
   * Session can refresh it per /run without recreating the Agent; sub-agent
   * spawn paths read this live value when constructing child Agents.
   */
  userTimezone?: string | undefined;
}
