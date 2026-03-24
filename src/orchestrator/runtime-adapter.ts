import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { Agent } from '../core/agent.js';
import { MODEL_MAP } from '../types/index.js';
import type { IAgent, ToolEntry, NodynUserConfig, ModelTier, StreamEvent, PreApprovalSet, InlinePipelineStep, Role } from '../types/index.js';
import type { ManifestStep, AgentDef, AgentTool, GateAdapter, Manifest } from './types.js';
import { loadRole, warnModelMismatch } from '../core/roles.js';
import { resolveTools } from '../tools/resolve-tools.js';

const INLINE_EXCLUDED_TOOLS = new Set(['spawn_agent', 'run_pipeline']);

// Core tools sufficient for most pipeline steps — avoids loading ~20 tool definitions (~3000 tokens/turn)
const INLINE_CORE_TOOLS = new Set(['bash', 'read_file', 'write_file', 'http', 'ask_user']);

/** Active pipeline step agents — aborted on ESC interrupt. */
const activePipelineAgents = new Set<Agent>();

/** Abort all running pipeline step agents. */
export function abortPipelineAgents(): void {
  for (const a of activePipelineAgents) {
    a.abort();
  }
}

interface GateMeta {
  manifestName: string;
  stepId: string;
  agentName: string;
  runId: string;
}

/**
 * Wrap a ToolEntry handler with gate approval logic.
 * Zero changes to Agent — tool_gates handled entirely here.
 */
export function wrapWithGate(tool: ToolEntry, gateAdapter: GateAdapter, meta: GateMeta): ToolEntry {
  return {
    definition: tool.definition,
    handler: async (input: unknown, agent: IAgent): Promise<string> => {
      const approvalId = await gateAdapter.submit({
        ...meta,
        context: { tool: tool.definition.name, input },
      });
      const decision = await gateAdapter.waitForDecision(approvalId);
      if (decision.status === 'rejected') {
        const reason = decision.status === 'rejected' ? (decision as { reason?: string }).reason : undefined;
        throw new Error(`Tool "${tool.definition.name}" rejected by gate${reason ? `: ${reason}` : ''}`);
      }
      if (decision.status === 'timeout') {
        throw new Error(`Tool "${tool.definition.name}" gate timed out`);
      }
      return tool.handler(input, agent);
    },
  };
}

/**
 * Convert AgentTool[] (from agent definition modules) to ToolEntry[].
 */
export function convertAgentTools(tools: AgentTool[]): ToolEntry[] {
  return tools.map(t => ({
    definition: {
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    } as BetaTool,
    handler: async (input: unknown): Promise<string> => {
      const result = await t.execute(input as Record<string, unknown>);
      return typeof result === 'string' ? result : JSON.stringify(result);
    },
  }));
}

/**
 * Model resolution: step.model overrides agentDef.defaultTier.
 * If step.model is a ModelTier key, map it. Otherwise use as full model ID.
 */
export function resolveModel(stepModel: string | undefined, defaultTier: ModelTier): string {
  if (!stepModel) return MODEL_MAP[defaultTier];
  return stepModel in MODEL_MAP ? MODEL_MAP[stepModel as ModelTier] : stepModel;
}

/**
 * Spawn a real agent for a manifest step and capture token usage.
 */
export async function spawnViaAgent(
  step: ManifestStep,
  agentDef: AgentDef,
  stepContext: Record<string, unknown>,
  config: NodynUserConfig,
  gateAdapter: GateAdapter | undefined,
  runId: string,
  preApproval?: PreApprovalSet | undefined,
  autonomy?: import('../types/index.js').AutonomyLevel | undefined,
): Promise<{ result: string; tokensIn: number; tokensOut: number; durationMs: number }> {
  let tokensIn = 0;
  let tokensOut = 0;
  const startTime = Date.now();

  const model = resolveModel(step.model, agentDef.defaultTier);

  let tools = convertAgentTools(agentDef.tools ?? []);

  // Wrap tool_gates entries with approval logic
  if (gateAdapter && step.tool_gates?.length) {
    const meta: GateMeta = {
      manifestName: stepContext['_manifestName'] as string ?? '',
      stepId: step.id,
      agentName: step.agent,
      runId,
    };
    tools = tools.map(t =>
      step.tool_gates!.includes(t.definition.name) ? wrapWithGate(t, gateAdapter, meta) : t,
    );
  }

  const agent = new Agent({
    name: step.agent,
    model,
    systemPrompt: agentDef.systemPrompt,
    tools,
    thinking: { type: 'adaptive' },
    effort: config.effort_level ?? 'medium',
    maxIterations: 10,
    costGuard: { maxBudgetUSD: model.includes('opus') ? 10 : 2, maxIterations: 10 },
    apiKey: config.api_key,
    apiBaseURL: config.api_base_url,
    preApproval,
    autonomy,
    onStream: (event: StreamEvent) => {
      if (event.type === 'turn_end') {
        tokensIn += event.usage.input_tokens;
        tokensOut += event.usage.output_tokens;
      }
    },
  });

  activePipelineAgents.add(agent);
  const timeoutMs = step.timeout_ms ?? 1_800_000;
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    agent.abort();
  }, timeoutMs);
  try {
    const result = await agent.send(JSON.stringify(stepContext));
    if (timedOut) {
      throw new Error(`Step "${step.id}" timed out after ${timeoutMs}ms`);
    }
    return { result, tokensIn, tokensOut, durationMs: Date.now() - startTime };
  } finally {
    clearTimeout(timeoutId);
    activePipelineAgents.delete(agent);
  }
}

/**
 * Spawn an inline agent from a task description (no disk agent def needed).
 * Inherits parent tools minus recursion-prone ones.
 */
export async function spawnInline(
  step: ManifestStep,
  stepContext: Record<string, unknown>,
  config: NodynUserConfig,
  parentTools: ToolEntry[],
  preApproval?: PreApprovalSet | undefined,
  autonomy?: import('../types/index.js').AutonomyLevel | undefined,
): Promise<{ result: string; tokensIn: number; tokensOut: number; durationMs: number }> {
  let tokensIn = 0;
  let tokensOut = 0;
  const startTime = Date.now();

  // Load role if specified
  let resolved: Role | null = null;
  if (step.role) {
    resolved = loadRole(step.role);
    if (!resolved) throw new Error(`Unknown role "${step.role}" on step "${step.id}". Use /roles list.`);
  }

  // Model mismatch warning
  if (step.model && resolved) {
    const warning = warnModelMismatch(resolved, step.model as ModelTier);
    if (warning) {
      // istanbul ignore next
      if (typeof process !== 'undefined') process.stderr?.write?.(`[warning] ${warning}\n`);
    }
  }

  // 4-tier resolution: step > role > user config > defaults
  const configTier = config.default_tier;
  const modelTier = (step.model ?? resolved?.model ?? configTier ?? 'sonnet') as ModelTier;
  const model = resolveModel(modelTier, 'sonnet');
  const systemPrompt = resolved?.systemPrompt
    ?? 'You are a focused task agent. Complete the task precisely. Return structured output when possible.';
  // Use minimal tool set for inline steps unless profile specifies custom tools
  const filteredParent = resolved?.allowedTools ? parentTools : parentTools.filter(t => INLINE_CORE_TOOLS.has(t.definition.name));
  const tools = resolveTools(undefined, resolved, filteredParent, INLINE_EXCLUDED_TOOLS);
  // Pipeline steps: Haiku gets explicit thinking budget (improves tool-call reliability)
  // Agent constructor will map adaptive→disabled for Haiku, so we set explicit budget here
  const isHaikuStep = model.includes('haiku');
  const defaultThinking = isHaikuStep
    ? { type: 'enabled' as const, budget_tokens: 4096 }
    : { type: 'adaptive' as const };
  const thinking = resolved?.thinking ?? defaultThinking;
  const effort = step.effort ?? resolved?.effort ?? config.effort_level ?? 'medium';
  const maxIter = resolved?.maxIterations ?? 10;

  const agent = new Agent({
    name: step.id,
    model,
    systemPrompt,
    tools,
    thinking,
    effort,
    apiKey: config.api_key,
    apiBaseURL: config.api_base_url,
    preApproval,
    autonomy,
    maxIterations: maxIter,
    costGuard: { maxBudgetUSD: modelTier === 'opus' ? 10 : 2, maxIterations: maxIter },
    onStream: (event: StreamEvent) => {
      if (event.type === 'turn_end') {
        tokensIn += event.usage.input_tokens;
        tokensOut += event.usage.output_tokens;
      }
    },
  });

  activePipelineAgents.add(agent);
  const timeoutMs = step.timeout_ms ?? 1_800_000;
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    agent.abort();
  }, timeoutMs);

  try {
    const result = await agent.send(JSON.stringify({ task: step.task, context: stepContext }));
    if (timedOut) {
      throw new Error(`Step "${step.id}" timed out after ${timeoutMs}ms`);
    }
    return { result, tokensIn, tokensOut, durationMs: Date.now() - startTime };
  } finally {
    clearTimeout(timeoutId);
    activePipelineAgents.delete(agent);
  }
}

/**
 * Return a configurable mock response — no API calls, for testing.
 */
export async function spawnMock(
  step: ManifestStep,
  responses: Map<string, string>,
): Promise<{ result: string; tokensIn: number; tokensOut: number; durationMs: number }> {
  return {
    result: responses.get(step.agent) ?? `mock:${step.agent}`,
    tokensIn: 10,
    tokensOut: 20,
    durationMs: 1,
  };
}

/**
 * Spawn a sub-pipeline from a step with runtime='pipeline'.
 * Supports inline step arrays.
 */
export async function spawnPipeline(
  step: ManifestStep,
  stepContext: Record<string, unknown>,
  config: NodynUserConfig,
  parentTools: ToolEntry[],
  depth: number,
): Promise<{ result: string; tokensIn: number; tokensOut: number; durationMs: number }> {
  const { runManifest } = await import('./runner.js');

  const MAX_DEPTH = 3;
  if (depth + 1 > MAX_DEPTH) {
    throw new Error(`Pipeline nesting exceeds max depth (${MAX_DEPTH})`);
  }

  if (!Array.isArray(step.pipeline)) {
    throw new Error(`Step "${step.id}" has runtime "pipeline" but no valid pipeline field`);
  }
  const steps: InlinePipelineStep[] = step.pipeline;

  const subManifest: Manifest = {
    manifest_version: '1.1',
    name: `${step.id}-sub`,
    triggered_by: 'pipeline-composition',
    context: stepContext,
    agents: steps.map(s => ({
      id: s.id,
      agent: s.id,
      runtime: 'inline' as const,
      task: s.task,
      model: s.model,
      role: s.role,
      input_from: s.input_from,
      timeout_ms: s.timeout_ms,
    })),
    gate_points: [],
    on_failure: 'stop',
    execution: 'parallel',
  };

  const startTime = Date.now();
  const state = await runManifest(subManifest, config, {
    parentTools,
    depth: depth + 1,
  });

  // Aggregate results
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  const stepResults: Record<string, unknown> = {};

  for (const [id, output] of state.outputs) {
    totalTokensIn += output.tokensIn;
    totalTokensOut += output.tokensOut;
    stepResults[id] = {
      result: output.result,
      costUsd: output.costUsd,
      skipped: output.skipped,
      error: output.error,
    };
  }

  return {
    result: JSON.stringify({ status: state.status, steps: stepResults }),
    tokensIn: totalTokensIn,
    tokensOut: totalTokensOut,
    durationMs: Date.now() - startTime,
  };
}
