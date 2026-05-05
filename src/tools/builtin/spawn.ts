import type { ToolEntry, SpawnSpec, IAgent, ModelTier, StreamHandler, IsolationConfig, IsolationLevel, CostGuardConfig, ModelProfile } from '../../types/index.js';
import { MODEL_MAP, getDefaultMaxTokens, getModelId } from '../../types/index.js';
import { getActiveProvider } from '../../core/llm-client.js';
import { Agent } from '../../core/agent.js';
import { loadConfig } from '../../core/config.js';
import { getPricing } from '../../core/pricing.js';
import { channels } from '../../core/observability.js';
import { getRole, getRoleNames, applyTierGate } from '../../core/roles.js';
import { resolveTools } from '../resolve-tools.js';

import { checkSessionBudget, resetSessionCost } from '../../core/session-budget.js';
import { escapeXml } from '../../core/data-boundary.js';
import { withCurrentTimePrefix } from '../../core/prompts.js';

const SPAWN_TIMEOUT = 10 * 60 * 1000;
const MAX_SPAWN_DEPTH = 5;
const SPAWN_EXCLUDED = new Set(['spawn_agent']);
const DEFAULT_SPAWN_BUDGET_USD = 5;

// Hard caps on caller-supplied values. Tool-input schemas aren't enforced
// at runtime, so the handler re-validates — without these caps a negative
// `max_turns` would flip the estimate negative and credit the session-budget
// counter via `checkSessionBudget`.
const MAX_SPAWN_AGENTS = 10;
const MAX_SPAWN_TURNS = 50;
const MAX_SPAWN_BUDGET_USD = 50;
const MAX_SPAWN_NAME_LENGTH = 64;
const MAX_SPAWN_TASK_LENGTH = 16_384;

/** Used as both estimator multiplier and runtime cap so the two can't drift. */
const DEFAULT_SPAWN_MAX_TURNS = 10;

/** Empirical p90 fill of a model's maxOutput per turn; overshoots are caught by the per-spawn cost guard. */
const SPAWN_OUTPUT_FILL_RATIO = 0.3;

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
 * Estimate the cost for a single spawn agent so `checkSessionBudget` can
 * refuse a fan-out that would blow the session ceiling. Models input as
 * ~4K tokens/turn (cache reduces this further after turn 1, not modelled)
 * and output as {@link SPAWN_OUTPUT_FILL_RATIO} × `model.maxOutput` per turn.
 */
function estimateSpawnCost(model: string, maxIterations: number): number {
  const pricing = getPricing(model);
  const expectedOutput = getDefaultMaxTokens(model) * SPAWN_OUTPUT_FILL_RATIO;
  const avgInput = 4000;
  // Defensive floor: a negative or NaN multiplier here would return a negative
  // estimate, which would credit the session-budget counter.
  const iters = Number.isFinite(maxIterations) && maxIterations > 0
    ? Math.floor(maxIterations)
    : 1;
  return iters * (
    (avgInput / 1_000_000) * pricing.input +
    (expectedOutput / 1_000_000) * pricing.output
  );
}

interface SpawnAgentInput {
  agents: SpawnSpec[];
}

// Control characters (incl. CR/LF) that could be used to spoof log lines or
// break terminal rendering when `name` is echoed in error messages, channel
// events, or the `## ${name}` markdown header.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function validateSpawnInput(input: SpawnAgentInput): void {
  if (!Array.isArray(input.agents) || input.agents.length === 0) {
    throw new Error('spawn_agent requires at least one agent in `agents`.');
  }
  if (input.agents.length > MAX_SPAWN_AGENTS) {
    throw new Error(
      `spawn_agent accepts at most ${MAX_SPAWN_AGENTS} agents per call (got ${input.agents.length}).`,
    );
  }
  for (const spec of input.agents) {
    if (typeof spec.name !== 'string' || spec.name.length === 0 || spec.name.length > MAX_SPAWN_NAME_LENGTH) {
      throw new Error(
        `spawn_agent: name must be a non-empty string up to ${MAX_SPAWN_NAME_LENGTH} chars.`,
      );
    }
    if (CONTROL_CHARS.test(spec.name)) {
      throw new Error('spawn_agent: name must not contain control characters.');
    }
    if (typeof spec.task !== 'string' || spec.task.length === 0 || spec.task.length > MAX_SPAWN_TASK_LENGTH) {
      throw new Error(
        `spawn_agent "${spec.name}": task must be a non-empty string up to ${MAX_SPAWN_TASK_LENGTH} chars.`,
      );
    }
    if (spec.max_turns !== undefined) {
      if (!Number.isInteger(spec.max_turns) || spec.max_turns < 1 || spec.max_turns > MAX_SPAWN_TURNS) {
        throw new Error(
          `spawn_agent "${spec.name}": max_turns must be an integer in [1, ${MAX_SPAWN_TURNS}] (got ${spec.max_turns}).`,
        );
      }
    }
    if (spec.max_budget_usd !== undefined) {
      if (!Number.isFinite(spec.max_budget_usd) || spec.max_budget_usd < 0 || spec.max_budget_usd > MAX_SPAWN_BUDGET_USD) {
        throw new Error(
          `spawn_agent "${spec.name}": max_budget_usd must be a number in [0, ${MAX_SPAWN_BUDGET_USD}] (got ${spec.max_budget_usd}).`,
        );
      }
    }
  }
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
    throw new Error(
      `Unknown role "${spec.role}". Available roles: ${getRoleNames().join(', ')}. ` +
      `If none of these fit, omit the "role" field and set model/effort/tools directly.`,
    );
  }

  // 4-tier resolution: spec fields > role defaults > user config > global default
  const userConfig = loadConfig();

  // Model profile override: if spec.profile is set, use OpenAI-compatible provider
  const profile: ModelProfile | undefined = spec.profile
    ? userConfig.model_profiles?.[spec.profile]
    : undefined;
  if (spec.profile && !profile) {
    throw new Error(`Unknown model profile "${spec.profile}". Available: ${Object.keys(userConfig.model_profiles ?? {}).join(', ') || 'none configured'}.`);
  }

  // Account-tier gate: explicit `spec.model` overrides are checked before
  // falling through to role defaults. Today only Opus is gated — non-Pro
  // tenants requesting Opus get a silent downgrade to Sonnet so role
  // defaults + budget caps stay predictable.
  const gatedOverride = applyTierGate(spec.model as ModelTier | undefined, userConfig.account_tier);
  const modelTier = (gatedOverride ?? resolved?.model ?? userConfig.default_tier ?? 'sonnet') as ModelTier;
  // Profile overrides model ID + provider; otherwise use Claude tier resolution
  const model = profile ? profile.model_id : getModelId(modelTier, getActiveProvider());
  const systemPrompt = spec.system_prompt;
  // OpenAI providers don't support thinking or effort
  const thinking = profile ? { type: 'disabled' as const } : spec.thinking;
  const effort = profile ? undefined : (spec.effort ?? resolved?.effort);
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
    maxIterations: maxIterations ?? DEFAULT_SPAWN_MAX_TURNS,
  };

  const childAgent = new Agent({
    name: spec.name,
    model,
    systemPrompt,
    tools,
    thinking,
    effort,
    maxTokens: spec.max_tokens ?? profile?.max_tokens,
    memory,
    onStream: parentOnStream ?? undefined,
    spawnDepth: childDepth,
    maxIterations,
    isolation: childIsolation,
    autonomy: parentAgent.autonomy,
    costGuard,
    // Profile overrides provider credentials
    apiKey: profile?.api_key ?? userConfig.api_key,
    apiBaseURL: profile?.api_base_url ?? userConfig.api_base_url,
    provider: profile?.provider ?? userConfig.provider,
    gcpProjectId: userConfig.gcp_project_id,
    gcpRegion: userConfig.gcp_region,
    openaiModelId: profile?.model_id,
    openaiAuth: profile?.auth,
  });

  // Track child for abort propagation
  activeChildAgents.add(childAgent);
  try {
    // Same per-turn time anchor as top-level chat / pipeline steps.
    const result = await childAgent.send(withCurrentTimePrefix(task));
    return { result, childRunId: childAgent.currentRunId };
  } finally {
    activeChildAgents.delete(childAgent);
  }
}

export const spawnAgentTool: ToolEntry<SpawnAgentInput> = {
  definition: {
    name: 'spawn_agent',
    description: 'Delegate tasks to specialist roles working in parallel. Choose a role via "role" (researcher, creator, operator, collector) to auto-configure model, effort, and allowed tools. If no role fits your task, omit "role" and configure model/effort/tools directly instead of picking a close-but-wrong role name — unrecognised roles error out.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        agents: {
          type: 'array',
          description: 'Array of agent specifications to spawn',
          minItems: 1,
          maxItems: MAX_SPAWN_AGENTS,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', minLength: 1, maxLength: MAX_SPAWN_NAME_LENGTH },
              task: { type: 'string', minLength: 1, maxLength: MAX_SPAWN_TASK_LENGTH },
              role: { type: 'string', enum: ['researcher', 'creator', 'operator', 'collector'], description: 'Role ID. Configures model, tools, and capabilities. Must be one of the four built-ins; omit the field entirely for a custom role.' },
              context: { type: 'string', description: 'Additional context prepended to the task.' },
              isolated_memory: { type: 'boolean', description: 'If true, agent has no access to parent memory.' },
              system_prompt: { type: 'string' },
              model: { type: 'string', enum: ['opus', 'sonnet', 'haiku'] },
              thinking: { type: 'object' },
              effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
              max_tokens: { type: 'number' },
              tools: { type: 'array', items: { type: 'string' } },
              max_turns: { type: 'number', minimum: 1, maximum: MAX_SPAWN_TURNS },
              max_budget_usd: { type: 'number', minimum: 0, maximum: MAX_SPAWN_BUDGET_USD },
              profile: { type: 'string', description: 'Named model profile for non-Claude provider (e.g. "mistral-eu", "gemini-research"). Configured in config.json.' },
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

    validateSpawnInput(input);

    const names = input.agents.map(a => a.name);
    const parentRunId = agent.currentRunId;

    // Pre-spawn cost estimation. Apply the same tier gate here as the
    // per-agent resolution in runSpawn, AND honor the role's default
    // model — otherwise Haiku-roled spawns (operator/collector) get
    // estimated at Sonnet rates, which over-allocates against the
    // session ceiling and blocks cheap batches.
    const cfg = loadConfig();
    const cfgTier = cfg.default_tier;
    const totalEstimate = input.agents.reduce((sum, spec) => {
      const gated = applyTierGate(spec.model as ModelTier | undefined, cfg.account_tier);
      const roleDefault = spec.role ? getRole(spec.role)?.model : undefined;
      const modelTier = (gated ?? roleDefault ?? cfgTier ?? 'sonnet') as ModelTier;
      const resolvedModel = MODEL_MAP[modelTier] ?? MODEL_MAP['sonnet'];
      const iters = spec.max_turns ?? DEFAULT_SPAWN_MAX_TURNS;
      return sum + estimateSpawnCost(resolvedModel, iters);
    }, 0);

    // Enforce global session cost ceiling (shared with pipeline steps)
    checkSessionBudget(totalEstimate);

    channels.spawnStart.publish({ agents: names, parent: agent.name, parentRunId, depth: childDepth });

    if (agent.onStream) {
      await agent.onStream({ type: 'spawn', agents: names, estimatedCostUSD: totalEstimate, agent: agent.name });
    }

    // Sub-agent progress state — visible to the UI via forwarded events.
    // Without this, parent's stream only sees spawn start + aggregated result
    // and the UI sits on "Arbeitet…" for minutes with no evidence of progress.
    const running = new Set(names);
    const lastToolBySub: Record<string, string> = {};
    const spawnStart = Date.now();

    const parentStream = agent.onStream;
    const makeChildStream = (subName: string): StreamHandler | null => {
      if (!parentStream) return null;
      return (event) => {
        // Forward only high-signal, low-frequency events. Text and thinking
        // token streams from children would flood the parent UI.
        if (event.type === 'tool_call') {
          lastToolBySub[subName] = event.name;
          return parentStream({ ...event, subAgent: subName });
        }
        if (event.type === 'tool_result') {
          return parentStream({ ...event, subAgent: subName });
        }
        if (event.type === 'error') {
          return parentStream(event);
        }
        // Swallow the rest — keeps the stream manageable.
        return undefined;
      };
    };

    // Heartbeat: while any child is running, emit a spawn_progress event every
    // 5s so the UI can show elapsed time + last tool per sub-agent + soft
    // timeout warning. Cleared in finally below.
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    if (parentStream) {
      heartbeat = setInterval(() => {
        if (running.size === 0) return;
        const elapsedS = Math.floor((Date.now() - spawnStart) / 1000);
        void parentStream({
          type: 'spawn_progress',
          elapsedS,
          running: [...running],
          lastToolBySub: { ...lastToolBySub },
          agent: agent.name,
        });
      }, 5000);
    }

    const results = await Promise.allSettled(
      input.agents.map(spec => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), SPAWN_TIMEOUT);
        const childStart = Date.now();

        return executeThinker(spec, agent, makeChildStream(spec.name), childDepth)
          .then(
            (value) => {
              running.delete(spec.name);
              if (parentStream) {
                void parentStream({
                  type: 'spawn_child_done',
                  subAgent: spec.name,
                  ok: true,
                  elapsedS: Math.floor((Date.now() - childStart) / 1000),
                  agent: agent.name,
                });
              }
              return value;
            },
            (err: unknown) => {
              running.delete(spec.name);
              if (parentStream) {
                void parentStream({
                  type: 'spawn_child_done',
                  subAgent: spec.name,
                  ok: false,
                  elapsedS: Math.floor((Date.now() - childStart) / 1000),
                  agent: agent.name,
                });
              }
              throw err;
            },
          )
          .finally(() => clearTimeout(timeout));
      }),
    );
    if (heartbeat) clearInterval(heartbeat);

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
