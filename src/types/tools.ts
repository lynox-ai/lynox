// === 4.2 Tool Contract ===

import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

import type { IAgent } from './agent.js';
import type { CostSnapshot } from './modes.js';

export type ToolHandler<TInput = unknown> =
  (input: TInput, agent: IAgent) => Promise<string>;

export interface ToolEntry<TInput = unknown> {
  definition: BetaTool;
  handler:    ToolHandler<TInput>;
}

// === 4.3 Stream Event Union ===

import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
export type { BetaUsage as Usage };

export type StreamEvent =
  | { type: 'text';        text: string;                           agent: string }
  | { type: 'thinking';    thinking: string;                       agent: string }
  | { type: 'thinking_done';                                       agent: string }
  | { type: 'tool_call';   name: string; input: unknown;           agent: string }
  | { type: 'tool_result'; name: string; result: string;           agent: string }
  | { type: 'spawn';       agents: string[]; estimatedCostUSD?: number | undefined; agent: string }
  | { type: 'turn_end';    stop_reason: string; usage: BetaUsage;  agent: string }
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
