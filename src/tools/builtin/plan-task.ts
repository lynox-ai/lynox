import { randomUUID } from 'node:crypto';
import type { ToolEntry, IAgent, InlinePipelineStep, PlannedPipeline, ModelTier, ThinkingHint, EffortLevel } from '../../types/index.js';
import { estimatePipelineCost, planDAG } from '../../core/dag-planner.js';
import { storePipeline, getPipeline } from './pipeline.js';
import { inferPipelineMode } from '../../orchestrator/human-in-the-loop.js';
import { assertPlannedPipelineIsValid } from '../../orchestrator/validate.js';
import type { RunHistory } from '../../core/run-history.js';

// Config accessed via agent.toolContext.userConfig

type PhaseAssignee = 'agent' | 'user';

interface PlanPhase {
  name: string;
  steps: string[];
  model?: ModelTier | undefined;
  thinking?: ThinkingHint | undefined;
  effort?: EffortLevel | undefined;
  verification?: string | undefined;
  depends_on?: string[] | undefined;
  assignee?: PhaseAssignee | undefined;
}

interface PlanContext {
  summary: string;
  findings?: string[] | undefined;
}

interface PlanTaskInput {
  summary: string;
  /** Phased plan — the primary input format */
  phases?: PlanPhase[] | undefined;
  /** Exploration context — what was discovered before planning */
  context?: PlanContext | undefined;
  /** Legacy flat steps — still supported for simple plans */
  steps?: string[] | undefined;
}

// --- Slug + pipeline conversion ---

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    || 'step';
}

/** Truncate a slug at the last word boundary (hyphen) within maxLen */
function truncateSlug(slug: string, maxLen: number): string {
  if (slug.length <= maxLen) return slug;
  const cut = slug.lastIndexOf('-', maxLen);
  return cut > 10 ? slug.slice(0, cut) : slug.slice(0, maxLen);
}

/** Convert agent-assigned plan phases to pipeline steps with dependency graph */
export function phasesToPipelineSteps(phases: PlanPhase[]): InlinePipelineStep[] {
  // Build per-index ID mapping (supports duplicate phase names)
  const usedIds = new Set<string>();
  const ids: string[] = [];

  for (const phase of phases) {
    let id = slugify(phase.name);
    if (usedIds.has(id)) {
      let counter = 2;
      while (usedIds.has(`${id}-${counter}`)) counter++;
      id = `${id}-${counter}`;
    }
    usedIds.add(id);
    ids.push(id);
  }

  // Build name→id lookup (first occurrence wins for depends_on resolution)
  const nameToId = new Map<string, string>();
  for (let i = 0; i < phases.length; i++) {
    const name = phases[i]!.name;
    if (!nameToId.has(name)) {
      nameToId.set(name, ids[i]!);
    }
  }

  // Only convert agent phases — user phases are handled via ask_user/task_create
  return phases
    .filter(phase => (phase.assignee ?? 'agent') === 'agent')
    .map(phase => {
      const idx = phases.indexOf(phase);
      const id = ids[idx]!;

      // Build task from steps + verification
      const taskLines = phase.steps.map((s, i) => `${i + 1}. ${s}`);
      if (phase.verification) {
        taskLines.push(`\nAfter completing, verify: ${phase.verification}`);
      }

      // Resolve depends_on names to step IDs
      let input_from: string[] | undefined;
      if (phase.depends_on && phase.depends_on.length > 0) {
        input_from = phase.depends_on
          .map(dep => nameToId.get(dep))
          .filter((resolved): resolved is string => resolved !== undefined);
        if (input_from.length === 0) input_from = undefined;
      }

      return { id, task: taskLines.join('\n'), input_from, model: phase.model, thinking: phase.thinking, effort: phase.effort };
    });
}

// --- Business-friendly presentation ---

function formatPresentation(input: PlanTaskInput, estimatedCostUsd?: number | undefined): string {
  const lines: string[] = [];

  // Context — brief, conversational
  if (input.context) {
    lines.push(input.context.summary);
    if (input.context.findings && input.context.findings.length > 0) {
      for (const f of input.context.findings) {
        lines.push(`  - ${f}`);
      }
    }
    lines.push('');
  }

  lines.push(input.summary);
  lines.push('');

  // Phased plan or flat steps
  if (input.phases && input.phases.length > 0) {
    for (let p = 0; p < input.phases.length; p++) {
      const phase = input.phases[p]!;
      const marker = phase.assignee === 'user' ? ' [your input needed]' : '';
      lines.push(`${p + 1}. ${phase.name}${marker}`);
    }
  } else if (input.steps && input.steps.length > 0) {
    for (let i = 0; i < input.steps.length; i++) {
      lines.push(`${i + 1}. ${input.steps[i]}`);
    }
  }

  if (estimatedCostUsd !== undefined && estimatedCostUsd > 0.01) {
    lines.push('');
    lines.push(`Estimated cost: ~$${estimatedCostUsd.toFixed(2)}`);
  }

  lines.push('');
  lines.push('Shall I proceed?');
  return lines.join('\n');
}

// --- Pipeline bridge ---

/**
 * Convert approved phases to a stored pipeline, return workflow_id.
 *
 * Every workflow runs through the orchestrator (`runManifest`) — there is one
 * execution path (D9). `executionMode` is therefore written to the constant
 * `'orchestrated'`; the field is retained on the type only for backward
 * compatibility with legacy stored rows and is otherwise unread.
 */
function convertToPipeline(summary: string, phases: PlanPhase[], runHistory: RunHistory | null | undefined, historicalAvg?: Record<string, number>): string {
  const pipelineSteps = phasesToPipelineSteps(phases);
  if (pipelineSteps.length === 0) return '';

  const pipelineId = randomUUID();
  const costEstimate = estimatePipelineCost(pipelineSteps, historicalAvg);

  const planned: PlannedPipeline = {
    id: pipelineId,
    name: truncateSlug(slugify(summary), 50) || `plan-${pipelineId.slice(0, 8)}`,
    goal: summary,
    steps: pipelineSteps,
    reasoning: 'Converted from user-approved plan',
    estimatedCost: costEstimate.totalCostUsd,
    createdAt: new Date().toISOString(),
    executed: false,
    executionMode: 'orchestrated',
    template: false,
    mode: inferPipelineMode(pipelineSteps),
    // plan_task plans carry no capture parameters; the field exists so a saved
    // template can be re-targeted (populated only on the capture/promote path).
    parameters: [],
  };

  // Save-time gate. plan_task is the canonical save path for pipelines today;
  // future Workflows-editor save endpoints should call this gate too.
  assertPlannedPipelineIsValid(planned);

  // Persist to the in-memory store AND pipeline_runs. plan_task is decoupled
  // from run (D4) — the returned workflow_id must survive an engine restart or
  // LRU eviction before run_workflow / a scheduled task_create resolves it;
  // storePipeline alone is volatile (max 10 entries, lost on restart).
  storePipeline(pipelineId, planned);
  runHistory?.insertPlannedPipeline(planned);
  return pipelineId;
}

// --- Tool definition ---

export const planTaskTool: ToolEntry<PlanTaskInput> = {
  definition: {
    name: 'plan_task',
    description:
      'Present a plan before executing complex, multi-step tasks. Use after understanding the problem. ' +
      'Steer small or quick work to direct execution — plan_task is for substantial work only. ' +
      'Provide phases for structured plans, or just a summary to auto-generate a plan. ' +
      'plan_task NEVER executes — on approval it converts the plan to a stored workflow and ' +
      'returns { approved: true, workflow_id }. Call run_workflow with that workflow_id to run it.',
    input_schema: {
      type: 'object' as const,
      properties: {
        summary: { type: 'string', description: 'What will be done, in plain language' },
        context: {
          type: 'object',
          description: 'What was discovered before planning',
          properties: {
            summary: { type: 'string', description: 'Brief summary of findings' },
            findings: {
              type: 'array',
              items: { type: 'string' },
              description: 'Key discoveries',
            },
          },
          required: ['summary'],
        },
        phases: {
          type: 'array',
          description: 'Steps of the plan. Independent steps run in parallel. User steps pause for input.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Step name in plain language' },
              steps: {
                type: 'array',
                items: { type: 'string' },
                description: 'What happens in this step',
              },
              model: {
                type: 'string',
                enum: ['deep', 'balanced', 'fast'],
                description: 'Capability tier for this step. Omit to use session default. Prefer fast for simple tasks, balanced for standard, deep only for complex analysis. Provider-agnostic — resolves to a concrete model per the active provider.',
              },
              thinking: {
                type: 'string',
                enum: ['adaptive', 'enabled', 'disabled'],
                description: 'Thinking mode for this step. Omit for adaptive (default).',
              },
              effort: {
                type: 'string',
                enum: ['low', 'medium', 'high', 'xhigh', 'max'],
                description: 'Effort level for this step. Omit for medium (default).',
              },
              verification: {
                type: 'string',
                description: 'How to confirm this step succeeded (internal, not shown to user)',
              },
              depends_on: {
                type: 'array',
                items: { type: 'string' },
                description: 'Step names this depends on. Omit for independent steps.',
              },
              assignee: {
                type: 'string',
                enum: ['agent', 'user'],
                description: '"agent" (default) = automated. "user" = needs human input.',
              },
            },
            required: ['name', 'steps'],
          },
        },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Simple step list for small plans (use phases for complex plans)',
        },
      },
      required: ['summary'],
    },
  },
  handler: async (input: PlanTaskInput, agent: IAgent): Promise<string> => {
    let phases = input.phases ?? [];
    let hasPhases = phases.length > 0;
    const hasSteps = (input.steps ?? []).length > 0;

    // Auto-plan fallback: no phases AND no steps → use planDAG()
    // H-011: prefer fresh getProviderConfig() snapshot over stale userConfig.
    // userConfig is captured at engine init and goes stale after a runtime
    // provider-switch (reloadUserConfig); the snapshot accessor reflects the
    // post-switch state. Tolerate legacy mocks without getProviderConfig via
    // typeof-check + fall back to userConfig. Pattern recidivism of #568/#570/#571.
    const planConfig = agent.toolContext.userConfig;
    const planProv = typeof (agent as { getProviderConfig?: unknown }).getProviderConfig === 'function'
      ? (agent as { getProviderConfig: () => import('../../types/agent.js').ProviderConfigSnapshot }).getProviderConfig()
      : null;
    const planApiKey = planProv?.apiKey ?? planConfig.api_key;
    if (!hasPhases && !hasSteps && planApiKey) {
      const plan = await planDAG(input.summary, {
        apiKey: planApiKey,
        apiBaseURL: planProv?.apiBaseURL ?? planConfig.api_base_url,
        provider: planProv?.provider ?? planConfig.provider,
        openaiModelId: planProv?.openaiModelId ?? planConfig.openai_model_id,
        maxSteps: 10,
        projectContext: input.context?.summary,
      });
      if (plan && plan.steps.length > 0) {
        phases = plan.steps.map(s => ({
          name: s.id,
          steps: [s.task],
          depends_on: s.input_from?.length ? s.input_from : undefined,
        }));
        hasPhases = true;
      }
    }

    const userPhaseNames = phases.filter(p => p.assignee === 'user').map(p => p.name);
    const historicalAvg = agent.toolContext.runHistory?.getAvgStepCostByModelTier(30);

    // Pre-compute cost estimate for phased plans
    let estimatedCostUsd: number | undefined;
    if (hasPhases) {
      const previewSteps = phasesToPipelineSteps(phases);
      if (previewSteps.length > 0) {
        estimatedCostUsd = estimatePipelineCost(previewSteps, historicalAvg).totalCostUsd;
      }
    }

    /**
     * Finalize an approved phased plan (D4 — decoupled). `plan_task` NEVER
     * executes: the phases are already converted to a stored `PlannedPipeline`
     * by `convertToPipeline`; this just shapes the return JSON. The agent
     * follows up with `run_workflow(workflow_id)` to actually run it.
     *
     * `includeEstimatedCost` is true only for the non-interactive path to
     * preserve the existing return-JSON contract.
     */
    const finalizeApprovedPlan = (
      workflowId: string,
      includeEstimatedCost: boolean,
    ): string => {
      const planned = workflowId ? getPipeline(workflowId) : undefined;
      const userSteps = userPhaseNames.length > 0 ? userPhaseNames : undefined;

      return JSON.stringify({
        approved: true,
        workflow_id: workflowId || undefined,
        steps: planned?.steps.map(s => ({ id: s.id, task: s.task })),
        user_steps: userSteps,
        ...(includeEstimatedCost ? { estimated_cost_usd: estimatedCostUsd } : {}),
      });
    };

    // Auto-approve in non-interactive context
    if (!agent.promptUser) {
      if (hasPhases) {
        const workflowId = convertToPipeline(input.summary, phases, agent.toolContext.runHistory, historicalAvg);
        return finalizeApprovedPlan(workflowId, true);
      }
      return JSON.stringify({ approved: true });
    }

    const presentation = formatPresentation(input, estimatedCostUsd);
    const answer = await agent.promptUser(presentation, ['Proceed', 'Adjust', 'Cancel']);
    const normalized = answer.toLowerCase().trim();

    if (['proceed', 'y', 'yes'].includes(normalized)) {
      if (hasPhases) {
        const workflowId = convertToPipeline(input.summary, phases, agent.toolContext.runHistory, historicalAvg);
        return finalizeApprovedPlan(workflowId, false);
      }
      return JSON.stringify({ approved: true });
    }
    if (['cancel', 'n', 'no'].includes(normalized)) {
      return JSON.stringify({ approved: false, feedback: 'User canceled the plan.' });
    }
    const feedback = normalized === 'adjust' ? 'User wants adjustments. Ask what to change.' : answer;
    return JSON.stringify({ approved: false, feedback });
  },
};
