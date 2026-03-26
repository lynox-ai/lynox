// === Pipeline ===

import type { ModelTier } from './models.js';

export interface InlinePipelineStep {
  id: string;
  task: string;
  model?: ModelTier | undefined;
  /** Role for agent specialization. Used by YAML manifests — not exposed to LLM. */
  role?: string | undefined;
  input_from?: string[] | undefined;
  timeout_ms?: number | undefined;
}

export interface PipelineStepResult {
  stepId: string;
  result: string;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  skipped: boolean;
  skipReason?: string | undefined;
  error?: string | undefined;
}

export interface PipelineResult {
  pipelineId: string;
  name: string;
  status: 'completed' | 'failed' | 'rejected';
  steps: PipelineStepResult[];
  totalDurationMs: number;
  totalCostUsd: number;
}

export interface PlannedPipeline {
  id: string;
  name: string;
  goal: string;
  steps: InlinePipelineStep[];
  reasoning: string;
  estimatedCost: number;
  createdAt: string;
  executed: boolean;
}

// === Process Capture ===

export type ProcessParameterSource = 'user_input' | 'relative_date' | 'context';

export interface ProcessParameter {
  name: string;
  description: string;
  type: 'string' | 'number' | 'date';
  defaultValue?: unknown;
  source: ProcessParameterSource;
}

export interface ProcessStep {
  order: number;
  tool: string;
  description: string;
  inputTemplate: Record<string, unknown>;
  dependsOn?: number[] | undefined;
}

export interface ProcessRecord {
  id: string;
  name: string;
  description: string;
  sourceRunId: string;
  steps: ProcessStep[];
  parameters: ProcessParameter[];
  createdAt: string;
  promotedToPipelineId?: string | undefined;
}

// === Task Management ===

export type TaskStatus = 'open' | 'in_progress' | 'completed';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';

export type TaskAssignee = 'user' | 'lynox' | string;

export type TaskType = 'manual' | 'scheduled' | 'watch';
export type TaskRunStatus = 'success' | 'failed' | 'timeout';

export interface TaskRecord {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: string | null;      // 'user', 'lynox', or custom name
  scope_type: string;
  scope_id: string;
  due_date: string | null;
  tags: string | null;           // JSON array
  parent_task_id: string | null; // one-level subtasks
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  schedule_cron?: string | undefined;
  next_run_at?: string | undefined;
  last_run_at?: string | undefined;
  last_run_result?: string | undefined;
  last_run_status?: string | undefined;
  task_type?: string | undefined;
  watch_config?: string | undefined;
  max_retries?: number | undefined;
  retry_count?: number | undefined;
  notification_channel?: string | undefined;
  pipeline_id?: string | undefined;
}
