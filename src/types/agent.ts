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
  currentRunId?: string | undefined;
  currentThreadId?: string | undefined;
  readonly spawnDepth?: number | undefined;
  readonly secretStore?: SecretStoreLike | undefined;
  readonly userId?: string | undefined;
  readonly activeScopes?: MemoryScopeRef[] | undefined;
  readonly isolation?: IsolationConfig | undefined;
  readonly autonomy?: AutonomyLevel | undefined;
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
