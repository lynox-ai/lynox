// === 4.2 Tool Contract ===

import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

import type { IAgent } from './agent.js';
import type { CostSnapshot } from './modes.js';

export type ToolHandler<TInput = unknown> =
  (input: TInput, agent: IAgent) => Promise<string>;

export interface ToolEntry<TInput = unknown> {
  definition: BetaTool;
  handler:    ToolHandler<TInput>;
  /**
   * When true, the tool handles its own user confirmation via
   * agent.promptUser() — the Permission Guard skips the generic warning
   * in interactive mode but still BLOCKS in autonomous mode.
   *
   * Use this for tools that show a meaningful preview to the user
   * (e.g. mail_send shows To/Subject/Body) instead of the guard's
   * generic "sends external mail" warning.
   */
  requiresConfirmation?: boolean | undefined;
  /**
   * Optional redactor for the tool input before it is captured in the
   * audit trail (channels.toolEnd → run_tool_calls.input_json). Tools
   * that handle sensitive payloads (e.g. mail bodies) return an
   * audit-safe shape with the sensitive fields removed/replaced.
   * Returning the input unchanged is equivalent to omitting the hook.
   */
  redactInputForAudit?: ((input: TInput) => unknown) | undefined;
  /**
   * Declares this tool as destructive. The Permission Guard warns in
   * interactive mode and BLOCKS in autonomous mode based on this flag.
   *
   * - `mode: 'data'`     → "destroys stored data" (e.g. data_store_drop)
   * - `mode: 'external'` → "modifies external data" (e.g. google_calendar create_event)
   *
   * For action-discriminated tools (e.g. google_drive: only "upload"/"share"
   * are destructive, "search"/"read" are safe), provide `check`. It returns
   * the action label for destructive inputs, or `null` for safe ones. Omit
   * `check` for always-destructive tools.
   *
   * Colocating this with the tool registration keeps the write-action
   * set next to the input schema — adding a new write action no longer
   * requires updating a separate enumerated list in the guard.
   */
  destructive?: {
    mode: 'data' | 'external';
    check?: (input: TInput) => string | null;
  } | undefined;
}

// === 4.3 Stream Event Union ===

import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
export type { BetaUsage as Usage };

export type StreamEvent =
  | { type: 'text';        text: string;                           agent: string; subAgent?: string | undefined }
  | { type: 'thinking';    thinking: string;                       agent: string; subAgent?: string | undefined }
  | { type: 'thinking_done';                                       agent: string; subAgent?: string | undefined }
  | { type: 'tool_call';   name: string; input: unknown;           agent: string; subAgent?: string | undefined }
  | { type: 'tool_progress'; tool: string; phase: string;          agent: string; subAgent?: string | undefined }
  | { type: 'tool_result'; name: string; result: string;           agent: string; isError?: boolean; subAgent?: string | undefined }
  | { type: 'spawn';       agents: string[]; estimatedCostUSD?: number | undefined; agent: string }
  | { type: 'spawn_progress'; elapsedS: number; running: string[];
      lastToolBySub: Record<string, string>; agent: string }
  | { type: 'spawn_child_done'; subAgent: string; ok: boolean; elapsedS: number; agent: string }
  | { type: 'turn_end';    stop_reason: string; usage: BetaUsage;  model?: string | undefined; agent: string }
  | { type: 'error';       message: string;                        agent: string }
  | { type: 'retry';       attempt: number; maxAttempts: number; delayMs: number; reason: string; agent: string }
  | { type: 'cost_warning';  snapshot: CostSnapshot;               agent: string }
  | { type: 'continuation';  iteration: number; max: number;       agent: string }

  | { type: 'pipeline_start'; pipelineId: string; name: string;
      steps: Array<{ id: string; task: string; inputFrom?: string[] | undefined }>; agent: string }
  | { type: 'pipeline_progress'; stepId: string; status: 'started' | 'completed' | 'skipped' | 'failed';
      detail?: string | undefined; durationMs?: number | undefined; elapsed?: number | undefined; agent: string }
  | { type: 'context_pressure'; droppedMessages: number; usagePercent: number; agent: string }
  | { type: 'context_budget'; systemTokens: number; toolTokens: number; messageTokens: number;
      totalTokens: number; maxTokens: number; usagePercent: number; agent: string }
  | { type: 'changeset_ready'; fileCount: number; agent: string }
  | { type: 'context_compacted'; summary: string; previousUsagePercent: number; agent: string };

export type StreamHandler = (event: StreamEvent) => void | Promise<void>;

// === 4.3b Run Event (serializable event log for async poll) ===

export interface RunEvent {
  id: number;
  type: 'thinking' | 'tool_call' | 'tool_result' | 'text_chunk' | 'turn_end' | 'error' | 'continuation';
  timestamp: number;
  data: Record<string, unknown>;
}
