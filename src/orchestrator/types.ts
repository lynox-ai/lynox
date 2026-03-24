import type { ModelTier } from '../types/index.js';

export interface Manifest {
  manifest_version: '1.0' | '1.1';
  name: string;
  triggered_by: string;
  context: Record<string, unknown>;
  agents: ManifestStep[];
  gate_points: string[];
  on_failure: 'stop' | 'continue' | 'notify';
  execution?: 'sequential' | 'parallel' | undefined;
}

export interface ManifestStep {
  id: string;
  agent: string;
  runtime: 'agent' | 'mock' | 'inline' | 'pipeline';
  task?: string | undefined;
  model?: string | undefined;
  role?: string | undefined;
  effort?: import('../types/index.js').EffortLevel | undefined;
  input_from?: string[] | undefined;
  conditions?: ManifestCondition[] | undefined;
  timeout_ms?: number | undefined;
  output_schema?: Record<string, unknown> | undefined;
  tool_gates?: string[] | undefined;
  pre_approve?: Array<{
    tool: string;
    pattern: string;
    risk?: 'low' | 'medium' | 'high' | undefined;
  }> | undefined;
  pipeline?: string | import('../types/index.js').InlinePipelineStep[] | undefined;
}

export type ConditionOperator = 'lt' | 'gt' | 'eq' | 'neq' | 'gte' | 'lte' | 'exists' | 'not_exists' | 'contains';

export interface ManifestCondition {
  path: string;         // dot-notation into step context
  operator: ConditionOperator;
  value?: unknown;
}

export interface AgentDef {
  name: string;
  version: string;
  defaultTier: ModelTier;
  systemPrompt: string;
  tools?: AgentTool[] | undefined;
}

export interface AgentTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface AgentOutput {
  stepId: string;
  result: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  skipped: boolean;
  skipReason?: string | undefined;
  error?: string | undefined;
}

export interface RunState {
  runId: string;
  manifestName: string;
  startedAt: string;
  completedAt?: string | undefined;
  status: 'running' | 'completed' | 'failed' | 'rejected';
  globalContext: Record<string, unknown>;
  outputs: Map<string, AgentOutput>;
  error?: string | undefined;
}

export interface RunHooks {
  onStepStart?: ((stepId: string, agentName: string) => void) | undefined;
  onStepComplete?: ((output: AgentOutput) => void) | undefined;
  onStepSkipped?: ((stepId: string, reason: string) => void) | undefined;
  onStepRetrySkipped?: ((stepId: string) => void) | undefined;
  onGateSubmit?: ((stepId: string, approvalId: string) => void) | undefined;
  onGateDecision?: ((stepId: string, decision: GateDecision) => void) | undefined;
  onRunComplete?: ((state: RunState) => void) | undefined;
  onStepNotify?: ((stepId: string, error: Error) => void) | undefined;
  onError?: ((stepId: string, error: Error) => void) | undefined;
  onPhaseStart?: ((phaseIndex: number, stepIds: string[]) => void) | undefined;
  onPhaseComplete?: ((phaseIndex: number) => void) | undefined;
}

export interface GateAdapter {
  submit(params: GateSubmitParams): Promise<string>;
  waitForDecision(approvalId: string): Promise<GateDecision>;
}

export interface GateSubmitParams {
  manifestName: string;
  stepId: string;
  agentName: string;
  context: Record<string, unknown>;
  runId: string;
}

export type GateDecision =
  | { status: 'approved' }
  | { status: 'rejected'; reason?: string | undefined }
  | { status: 'timeout' };

export class GateRejectedError extends Error {
  constructor(public readonly stepId: string, reason?: string | undefined) {
    super(`Gate rejected step "${stepId}"${reason ? `: ${reason}` : ''}`);
    this.name = 'GateRejectedError';
  }
}

export class GateExpiredError extends Error {
  constructor(public readonly stepId: string) {
    super(`Gate timed out for step "${stepId}"`);
    this.name = 'GateExpiredError';
  }
}
