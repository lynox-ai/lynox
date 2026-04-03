import type { ToolEntry, SpawnSpec, IAgent, ModelTier, StreamHandler, IsolationConfig, IsolationLevel, CostGuardConfig } from '../../types/index.js';
import { MODEL_MAP, DEFAULT_MAX_TOKENS, getModelId } from '../../types/index.js';
import { getActiveProvider, isBedrockEuOnly } from '../../core/llm-client.js';
import { Agent } from '../../core/agent.js';
import { loadConfig } from '../../core/config.js';
import { getPricing } from '../../core/pricing.js';
import { channels } from '../../core/observability.js';
import { getRole, getRoleNames } from '../../core/roles.js';
import { resolveTools } from '../resolve-tools.js';

import { checkSessionBudget, resetSessionCost } from '../../core/session-budget.js';
import { escapeXml } from '../../core/data-boundary.js';

const SPAWN_TIMEOUT = 10 * 60 * 1000;
const MAX_SPAWN_DEPTH = 5;
const SPAWN_EXCLUDED = new Set(['spawn_agent']);
const DEFAULT_SPAWN_BUDGET_USD = 5;

/** Reset the session spawn cost counter (for testing). */
export function resetSessionSpawnCost(): void {
  resetSessionCost();
}

/** Active child agents — aborted when parent is interrupted. */
const activeChildAgents = new Set<Agent>();

/** Abort all running child agents (called from orchestrator abort). */
export function abortSpawnedAgents(): void {
  for (const child of activeChildAgents) {
    child.abort();
  }
}

/**
 * Estimate the maximum cost for a single spawn agent.
 * Conservative: assumes each iteration uses ~4K input + model's default max output tokens.
 */
function estimateSpawnCost(model: string, maxIterations: number): number {
  const pricing = getPricing(model);
  const maxOutput = DEFAULT_MAX_TOKENS[model] ?? 16_000;
  const avgInput = 4000; // conservative per-turn input estimate
  return maxIterations * (
    (avgInput / 1_000_000) * pricing.input +
    (maxOutput / 1_000_000) * pricing.output
  );
}

interface SpawnAgentInput {
  agents: SpawnSpec[];
}

async function executeThinker(
  spec: SpawnSpec,
  parentAgent: IAgent,
  parentOnStream: StreamHandler | null,
  childDepth: number,
): Promise<{ result: string; childRunId: string | undefined }> {
  // Load role if specified
  const resolved = spec.role ? getRole(spec.role) : undefined;
  if (spec.role && !resolved) {
    throw new Error(`Unknown role "${spec.role}". Available roles: ${getRoleNames().join(', ')}.`);
  }

  // 4-tier resolution: spec fields > role defaults > user config > global default
  const userConfig = loadConfig();
  const modelTier = (spec.model ?? resolved?.model ?? userConfig.default_tier ?? 'sonnet') as ModelTier;
  const model = getModelId(modelTier, getActiveProvider(), isBedrockEuOnly());
  const systemPrompt = spec.system_prompt;
  const thinking = spec.thinking;
  const effort = spec.effort ?? resolved?.effort;
  const maxIterations = spec.max_turns;

  // Tool scoping — map RoleConfig fields to resolveTools interface
  const roleProfile = resolved
    ? { allowedTools: resolved.allowTools ? [...resolved.allowTools] : undefined, deniedTools: resolved.denyTools ? [...resolved.denyTools] : undefined }
    : null;
  const tools = resolveTools(spec.tools, roleProfile, parentAgent.tools, SPAWN_EXCLUDED);

  // Context injection (XML-escaped to prevent tag injection)
  const task = spec.context
    ? `<context>${escapeXml(spec.context)}</context>\n\n${spec.task}`
    : spec.task;

  // Isolated memory
  const memory = spec.isolated_memory === true
    ? undefined
    : (parentAgent.memory ?? undefined);

  // Isolation propagation: parent's isolation flows to child, child can only be MORE restrictive
  let childIsolation: IsolationConfig | undefined;
  const parentIsolation = parentAgent.isolation;
  if (parentIsolation) {
    const levelOrder: Record<IsolationLevel, number> = {
      'shared': 0,
      'scoped': 1,
      'sandboxed': 2,
      'air-gapped': 3,
    };
    if (spec.isolation) {
      // Child's explicit isolation can only be MORE restrictive
      const effectiveLevel = levelOrder[spec.isolation.level] >= levelOrder[parentIsolation.level]
        ? spec.isolation.level
        : parentIsolation.level;
      childIsolation = { ...spec.isolation, level: effectiveLevel };
    } else {
      childIsolation = parentIsolation;
    }
  } else if (spec.isolation) {
    childIsolation = spec.isolation;
  }

  // Cost guard: use explicit budget from spec, or default
  const budgetUSD = spec.max_budget_usd ?? DEFAULT_SPAWN_BUDGET_USD;
  const costGuard: CostGuardConfig = {
    maxBudgetUSD: budgetUSD,
    maxIterations: maxIterations ?? 20,
  };

  const childAgent = new Agent({
    name: spec.name,
    model,
    systemPrompt,
    tools,
    thinking,
    effort,
    maxTokens: spec.max_tokens,
    memory,
    onStream: parentOnStream ?? undefined,
    spawnDepth: childDepth,
    maxIterations,
    isolation: childIsolation,
    autonomy: parentAgent.autonomy,
    costGuard,
    apiKey: userConfig.api_key,
    apiBaseURL: userConfig.api_base_url,
    provider: userConfig.provider,
    awsRegion: userConfig.aws_region,
    gcpRegion: userConfig.gcp_region,
    gcpProjectId: userConfig.gcp_project_id,
  });

  // Track child for abort propagation
  activeChildAgents.add(childAgent);
  try {
    const result = await childAgent.send(task);
    return { result, childRunId: childAgent.currentRunId };
  } finally {
    activeChildAgents.delete(childAgent);
  }
}

export const spawnAgentTool: ToolEntry<SpawnAgentInput> = {
  definition: {
    name: 'spawn_agent',
    description: 'Delegate tasks to specialist roles working in parallel. Choose a role via "role" (researcher, analyst, executor, operator, strategist, creator, collector, communicator) to auto-configure capabilities.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        agents: {
          type: 'array',
          description: 'Array of agent specifications to spawn',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              task: { type: 'string' },
              role: { type: 'string', description: 'Role ID (e.g. researcher, creator, operator, collector). Configures model, tools, and capabilities.' },
              context: { type: 'string', description: 'Additional context prepended to the task.' },
              isolated_memory: { type: 'boolean', description: 'If true, agent has no access to parent memory.' },
              system_prompt: { type: 'string' },
              model: { type: 'string', enum: ['opus', 'sonnet', 'haiku'] },
              thinking: { type: 'object' },
              effort: { type: 'string', enum: ['low', 'medium', 'high', 'max'] },
              max_tokens: { type: 'number' },
              tools: { type: 'array', items: { type: 'string' } },
              max_turns: { type: 'number' },
              max_budget_usd: { type: 'number' },
            },
            required: ['name', 'task'],
          },
        },
      },
      required: ['agents'],
    },
  },
  handler: async (input: SpawnAgentInput, agent: IAgent): Promise<string> => {
    const parentDepth = agent.spawnDepth ?? 0;
    const childDepth = parentDepth + 1;

    // Enforce max spawn depth
    if (childDepth > MAX_SPAWN_DEPTH) {
      throw new Error(
        `Max spawn depth (${MAX_SPAWN_DEPTH}) exceeded. Current depth: ${parentDepth}. Cannot spawn deeper.`,
      );
    }

    const names = input.agents.map(a => a.name);
    const parentRunId = agent.currentRunId;

    // Pre-spawn cost estimation
    const cfgTier = loadConfig().default_tier;
    const totalEstimate = input.agents.reduce((sum, spec) => {
      const modelTier = (spec.model ?? (spec.role ? undefined : cfgTier) ?? 'sonnet') as ModelTier | undefined;
      const resolvedModel = MODEL_MAP[modelTier ?? 'sonnet'] ?? MODEL_MAP['sonnet'];
      const iters = spec.max_turns ?? 20;
      return sum + estimateSpawnCost(resolvedModel, iters);
    }, 0);

    // Enforce global session cost ceiling (shared with pipeline steps)
    checkSessionBudget(totalEstimate);

    channels.spawnStart.publish({ agents: names, parent: agent.name, parentRunId, depth: childDepth });

    if (agent.onStream) {
      await agent.onStream({ type: 'spawn', agents: names, estimatedCostUSD: totalEstimate, agent: agent.name });
    }

    const results = await Promise.allSettled(
      input.agents.map(spec => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), SPAWN_TIMEOUT);

        return executeThinker(spec, agent, null, childDepth)
          .finally(() => clearTimeout(timeout));
      }),
    );

    // Cost already reserved in checkSessionBudget() above — no separate recordSessionCost needed

    const sections: string[] = [];
    const errors: Error[] = [];
    const childRunIds: Array<string | undefined> = [];

    for (let i = 0; i < results.length; i++) {
      const outcome = results[i]!;
      const spec = input.agents[i]!;

      if (outcome.status === 'fulfilled') {
        sections.push(`## ${spec.name}\n\n${outcome.value.result}`);
        childRunIds.push(outcome.value.childRunId);
      } else {
        const err = outcome.reason instanceof Error
          ? outcome.reason
          : new Error(String(outcome.reason));
        errors.push(err);
        sections.push(`## ${spec.name}\n\n**Error:** ${err.message}`);
        childRunIds.push(undefined);
      }
    }

    // Publish spawn end with genealogy data for orchestrator to record
    const spawnRecords = input.agents.map((spec, i) => ({
      childName: spec.name,
      childRunId: childRunIds[i],
    }));

    channels.spawnEnd.publish({
      agents: names,
      parent: agent.name,
      parentRunId,
      errors: errors.length,
      depth: childDepth,
      spawnRecords,
    });

    if (errors.length === input.agents.length) {
      const details = errors.map(e => `${e.message}${e.cause ? ` (cause: ${e.cause})` : ''}`).join('; ');
      throw new AggregateError(errors, `All sub-agents failed: ${details}`);
    }

    return sections.join('\n\n---\n\n');
  },
};
