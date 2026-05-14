// === 4.4 IAgent Interface ===

import type { ToolEntry, StreamHandler } from './tools.js';
import type { IMemory, MemoryScopeRef } from './memory.js';
import type { SecretStoreLike, IsolationConfig } from './security.js';
import type { AutonomyLevel } from './modes.js';

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
}

export type PromptUserFn = (question: string, options?: string[], meta?: PromptMeta) => Promise<string>;
export type PromptTabsFn = (questions: TabQuestion[], meta?: PromptMeta) => Promise<string[]>;
export type PromptSecretFn = (name: string, prompt: string, keyType?: string, meta?: PromptMeta) => Promise<boolean>;

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

export interface IAgent {
  readonly name:   string;
  readonly model:  string;
  readonly memory: IMemory | null;
  readonly tools:  ToolEntry[];
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
   * IANA timezone for the human user, propagated to sub-agents so scheduled
   * times render in the user's wallclock. Mutable (no `readonly`) so the host
   * Session can refresh it per /run without recreating the Agent; sub-agent
   * spawn paths read this live value when constructing child Agents.
   */
  userTimezone?: string | undefined;
}
