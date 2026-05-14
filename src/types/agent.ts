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
 * Mutable per-Session counters that previously lived as module-level state
 * (`sessionHttpRequestCount` in tools/builtin/http.ts, `sessionWriteBytes`
 * in tools/builtin/fs.ts). Session owns the object and threads the same
 * reference into the main Agent + every spawned sub-agent, so a single
 * conversation accumulates one budget across all its agents.
 *
 * Each Session instance gets a fresh object — counters reset between
 * sessions instead of growing for the lifetime of the process.
 */
export interface SessionCounters {
  /** Number of http_request invocations charged to this Session. */
  httpRequests: number;
  /** Total bytes written by write_file in this Session. */
  writeBytes: number;
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
