import type { InlinePipelineStep, PipelineCostEstimate, StepCostEstimate } from '../types/index.js';
import { getBetasForProvider, getModelId, normalizeTier } from '../types/index.js';
import { createLLMClient, getActiveProvider } from './llm-client.js';
import { calculateCost } from './pricing.js';
import { resolveModel, undeclaredInlineStepTier } from '../orchestrator/runtime-adapter.js';
import { settleForcedTool, reportForcedToolMiss, reportForcedToolCutOff } from './llm-wire-rules.js';
import { abortedCallCost, partialMessageOf, reportAbortedCall } from './aborted-call.js';
import type { AbortedCallCost } from './aborted-call.js';

const PLAN_MAX_TOKENS = 4096;

export interface DagPlanResult {
  steps: InlinePipelineStep[];
  reasoning: string;
  estimatedCost: number;
  /** Actual USD cost of THIS pool-key planning call (from response.usage),
   *  for the managed in-run debit. 0 when usage was unavailable. */
  actualCostUsd: number;
}

const PLANNING_SYSTEM = `You are a DAG pipeline planner. Given a goal, decompose it into discrete steps that can run as independent sub-agents. Each step gets its own agent context — it has access ONLY to the tools you declare for it, not to your conversation.

Rules:
- Each step must have a clear, self-contained task description
- Use input_from to declare data dependencies between steps
- Steps without dependencies run in parallel automatically
- Prefer fewer, broader steps over many tiny ones (3-8 steps ideal)
- Each step's task should be specific enough that a sub-agent can execute it without additional context
- Declare in "tools" exactly the tools the step's task needs — nothing more. Available: http_request, web_research, read_file, write_file, bash, ask_user, data_store_query, data_store_insert, memory_recall, memory_store, memory_update, memory_list, recall. Declare bash ONLY when the task genuinely needs a shell — every bash use raises an approval dialog for the user.

IMPORTANT — you MUST set the "model" field on EVERY step. The tiers are provider-agnostic capability bands; choose the cheapest tier that can handle the task:
- "fast" (~$0.005/step): Read-only tasks, data extraction, validation, simple transformations, status checks where the result is returned as text output. USE THIS BY DEFAULT for tasks that do NOT write files.
- "balanced" (~$0.08/step): Any task that must write files with specific names, analysis, code review, multi-step reasoning, report writing. Use whenever the step produces file artifacts for downstream steps.
- "deep" (~$1.20/step): Complex architecture decisions, ambiguous requirements, large-scale refactoring. Use sparingly.

IMPORTANT: If a step must write files with exact filenames (e.g. for downstream steps to read), use "balanced" — the fast tier may ignore exact filename instructions.
Cost optimization is critical — always prefer the cheapest tier that can reliably complete the step.`;

const PROPOSE_DAG_TOOL = {
  name: 'propose_dag',
  description: 'Propose a DAG pipeline of steps to accomplish the given goal.',
  input_schema: {
    type: 'object' as const,
    properties: {
      steps: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            id: { type: 'string' as const, description: 'Unique step ID (e.g. "analyze", "implement", "test")' },
            task: { type: 'string' as const, description: 'Task description for the sub-agent' },
            model: { type: 'string' as const, enum: ['deep', 'balanced', 'fast'], description: 'Capability tier (omitted = fast)' },
            tools: { type: 'array' as const, items: { type: 'string' as const }, description: 'Exact tool names this step needs (see system prompt for the available set). Declare only what the task needs; bash only when a shell is genuinely required.' },
            input_from: { type: 'array' as const, items: { type: 'string' as const }, description: 'Step IDs whose output this step depends on' },
          },
          required: ['id', 'task', 'tools'],
        },
        description: 'List of pipeline steps',
      },
      reasoning: { type: 'string' as const, description: 'Brief explanation of the decomposition strategy' },
      estimated_cost_usd: { type: 'number' as const, description: 'Estimated total cost in USD' },
    },
    required: ['steps', 'reasoning', 'estimated_cost_usd'],
  },
};

export async function planDAG(
  goal: string,
  options?: {
    model?: string | undefined;
    apiKey?: string | undefined;
    apiBaseURL?: string | undefined;
    provider?: import('../types/index.js').LLMProvider | undefined;
    openaiModelId?: string | undefined;
    maxSteps?: number | undefined;
    projectContext?: string | undefined;
    /**
     * Called once with the USD cost of the planning reply, as soon as it arrives — also when
     * the reply yields no plan (`null`). Book the spend here rather than from the result: a
     * reply that plans nothing was paid for all the same.
     */
    onSpend?: ((costUsd: number) => void) | undefined;
    /**
     * Called once when the planning call is aborted (its timeout, or `signal`) before the reply arrives,
     * with bounds for what it cost. The upper bound is for budget caps; it is not a spend to
     * debit to the tenant (aborted-call.ts).
     */
    onAbortedSpend?: ((cost: AbortedCallCost) => void) | undefined;
    /**
     * The calling tool's signal (`currentCallSignal`): a stop of the run, or the tool's time
     * limit where it has one. It aborts the planning call like the planner's own timeout does, but where the
     * timeout yields `null` (no plan), this one throws an `AbortError`, so the caller ends
     * as stopped instead of carrying on without a plan.
     */
    signal?: AbortSignal | undefined;
  },
): Promise<DagPlanResult | null> {
  const callSignal = options?.signal;
  // A function, not a narrowed property: the signal changes while the call runs.
  const stopped = (): boolean => callSignal?.aborted === true;
  // A run stopped before the call starts no call: nothing is sent, so nothing is booked.
  if (stopped()) throw planStopped();
  try {
    // Derive ONE provider and use it for client + model + betas. The pre-fix
    // code built the client from options.provider but resolved the model and
    // betas from the GLOBAL getActiveProvider(), so a per-call provider that
    // differed from the global (managed runtime provider-switch — plan-task.ts
    // passes the fresh snapshot provider per H-011) sent an Anthropic model id
    // to a Mistral client. Mirror process-capture.ts.
    const provider = options?.provider ?? getActiveProvider();
    const isOpenAICompat = provider === 'custom' || provider === 'openai';
    const client = createLLMClient({
      apiKey: options?.apiKey,
      apiBaseURL: options?.apiBaseURL,
      provider,
      openaiModelId: options?.openaiModelId,
    });

    const model = options?.model ?? getModelId('fast', provider);
    const maxSteps = options?.maxSteps ?? 15;

    let systemText = PLANNING_SYSTEM;
    if (options?.projectContext) {
      systemText += `\n\nProject context: ${options.projectContext}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const signal = callSignal === undefined ? controller.signal : AbortSignal.any([controller.signal, callSignal]);
    // Set once the request is out. No await follows the reply, so the timeout cannot land
    // after it: an abort seen in the catch is always one before the reply.
    let inFlight: { request: unknown; stream: unknown } | undefined;

    try {
      const request = {
        system: systemText,
        tools: [PROPOSE_DAG_TOOL],
        messages: [{ role: 'user' as const, content: `Plan a pipeline for this goal: ${goal}` }],
      };
      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: PLAN_MAX_TOKENS,
          ...(isOpenAICompat ? {} : { betas: getBetasForProvider(provider) }),
          ...request,
          tool_choice: { type: 'tool', name: 'propose_dag' },
        },
        { signal },
      );
      inFlight = { request, stream };
      const { message: response, missed } = await settleForcedTool(stream.finalMessage());

      // Actual pool-key spend of this planning call, for the managed in-run
      // debit at the call site. Normalize the SDK's null cache fields.
      const u = response.usage;
      const actualCostUsd = u
        ? calculateCost(model, {
            input_tokens: u.input_tokens,
            output_tokens: u.output_tokens,
            cache_creation_input_tokens: u.cache_creation_input_tokens ?? undefined,
            cache_read_input_tokens: u.cache_read_input_tokens ?? undefined,
          })
        : 0;
      options?.onSpend?.(actualCostUsd);
      reportForcedToolMiss('dag-planner', missed);
      reportForcedToolCutOff('dag-planner', model, response);

      clearTimeout(timeout);

      const toolUse = response.content.find(b => b.type === 'tool_use');
      if (!toolUse || toolUse.type !== 'tool_use') return null;

      const input = toolUse.input as {
        steps?: unknown[];
        reasoning?: string;
        estimated_cost_usd?: number;
      };

      if (!Array.isArray(input.steps)) return null;

      const steps: InlinePipelineStep[] = [];
      for (const raw of input.steps) {
        if (!raw || typeof raw !== 'object') continue;
        const s = raw as Record<string, unknown>;
        if (typeof s['id'] !== 'string' || typeof s['task'] !== 'string') continue;

        const step: InlinePipelineStep = {
          id: s['id'],
          task: s['task'],
        };

        if (typeof s['model'] === 'string') {
          // normalizeTier accepts both the current names and the legacy
          // Anthropic-brand names, so an LLM that emits an old tier name still
          // resolves correctly.
          const tier = normalizeTier(s['model']);
          if (tier) step.model = tier;
        }

        // Lenient parse: a missing/invalid tools array degrades to undeclared —
        // the runtime then grants the default pool minus bash, never more. An
        // explicit EMPTY array is kept as a declaration ("this step needs no
        // tools") and grants nothing.
        if (Array.isArray(s['tools']) && s['tools'].every((x: unknown) => typeof x === 'string')) {
          step.tools = s['tools'] as string[];
        }

        if (Array.isArray(s['input_from']) && s['input_from'].every((x: unknown) => typeof x === 'string')) {
          step.input_from = s['input_from'] as string[];
        }

        steps.push(step);
      }

      // Enforce max steps limit
      const trimmed = steps.slice(0, maxSteps);

      return {
        steps: trimmed,
        reasoning: typeof input.reasoning === 'string' ? input.reasoning : '',
        estimatedCost: typeof input.estimated_cost_usd === 'number' ? input.estimated_cost_usd : 0,
        actualCostUsd,
      };
    } catch (err) {
      if (inFlight && signal.aborted) {
        const cost = abortedCallCost({ model, maxTokens: PLAN_MAX_TOKENS, request: inFlight.request, partial: partialMessageOf(inFlight.stream) });
        reportAbortedCall('dag-planner', model, cost);
        options?.onAbortedSpend?.(cost);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // Every failure of the planning call means "no plan", except a stop of the calling tool.
    if (stopped()) throw planStopped();
    return null;
  }
}

function planStopped(): DOMException {
  return new DOMException('plan_task was stopped before a plan was made', 'AbortError');
}

// Simple per-step cost lookup based on typical model pricing
const COST_PER_STEP: Record<string, number> = {
  deep: 1.20,
  balanced: 0.08,
  fast: 0.005,
};

/**
 * Cost estimate based on step count and model tier.
 * Uses historical averages from past pipeline runs when available,
 * falls back to fixed per-step rates otherwise.
 */
export function estimatePipelineCost(
  steps: InlinePipelineStep[],
  historicalAvgByTier?: Record<string, number>,
): PipelineCostEstimate {
  const stepEstimates: StepCostEstimate[] = steps.map(step => {
    // F1: an undeclared step runs `fast` — the estimate must price the tier
    // that will actually run, or the plan preview overstates by ~16× per step.
    const fallbackTier = undeclaredInlineStepTier(step);
    const model = resolveModel(step.model, fallbackTier);
    const tier = step.model ?? fallbackTier;
    const estimatedCostUsd = historicalAvgByTier?.[tier] ?? COST_PER_STEP[tier] ?? 0.08;
    return {
      stepId: step.id,
      model,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedCostUsd,
    };
  });

  return {
    steps: stepEstimates,
    totalCostUsd: stepEstimates.reduce((sum, s) => sum + s.estimatedCostUsd, 0),
  };
}
