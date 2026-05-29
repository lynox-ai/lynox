import type { InlinePipelineStep, PipelineCostEstimate, StepCostEstimate } from '../types/index.js';
import { getBetasForProvider, getModelId, normalizeTier } from '../types/index.js';
import { createLLMClient, getActiveProvider, isCustomProvider } from './llm-client.js';
import { resolveModel } from '../orchestrator/runtime-adapter.js';

export interface DagPlanResult {
  steps: InlinePipelineStep[];
  reasoning: string;
  estimatedCost: number;
}

const PLANNING_SYSTEM = `You are a DAG pipeline planner. Given a goal, decompose it into discrete steps that can run as independent sub-agents. Each step gets its own agent context — it has access to tools (bash, read_file, write_file, etc.) but not to your conversation.

Rules:
- Each step must have a clear, self-contained task description
- Use input_from to declare data dependencies between steps
- Steps without dependencies run in parallel automatically
- Prefer fewer, broader steps over many tiny ones (3-8 steps ideal)
- Each step's task should be specific enough that a sub-agent can execute it without additional context

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
            model: { type: 'string' as const, enum: ['deep', 'balanced', 'fast'], description: 'Capability tier (default: balanced)' },
            input_from: { type: 'array' as const, items: { type: 'string' as const }, description: 'Step IDs whose output this step depends on' },
          },
          required: ['id', 'task'],
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
  },
): Promise<DagPlanResult | null> {
  try {
    const client = createLLMClient({
      apiKey: options?.apiKey,
      apiBaseURL: options?.apiBaseURL,
      provider: options?.provider,
      openaiModelId: options?.openaiModelId,
    });

    const model = options?.model ?? getModelId('fast', getActiveProvider());
    const maxSteps = options?.maxSteps ?? 15;

    let systemText = PLANNING_SYSTEM;
    if (options?.projectContext) {
      systemText += `\n\nProject context: ${options.projectContext}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: 4096,
          ...(isCustomProvider() ? {} : { betas: getBetasForProvider(getActiveProvider()) }),
          system: systemText,
          tool_choice: { type: 'tool', name: 'propose_dag' },
          tools: [PROPOSE_DAG_TOOL],
          messages: [{ role: 'user', content: `Plan a pipeline for this goal: ${goal}` }],
        },
        { signal: controller.signal },
      );
      const response = await stream.finalMessage();

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
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
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
    const model = resolveModel(step.model, 'balanced');
    const tier = step.model ?? 'balanced';
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
