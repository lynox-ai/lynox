import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { Agent } from '../core/agent.js';
import { getModelId, clampTier, normalizeTier } from '../types/index.js';
import type { IAgent, ToolEntry, ToolContext, LynoxUserConfig, ModelTier, ThinkingMode, StreamEvent, PreApprovalSet, InlinePipelineStep, CapabilityContract, LLMProvider, SecretStoreLike } from '../types/index.js';
import type { PromptUserFn, PromptTabsFn, PromptSecretFn, PromptMeta } from '../types/agent.js';
import type { IMemory } from '../types/memory.js';
import { getActiveProvider } from '../core/llm-client.js';
import type { ManifestStep, AgentDef, AgentTool, GateAdapter, Manifest } from '../types/orchestration.js';
import { getRole, getRoleNames } from '../core/roles.js';
import { resolveRunModel, resolveCrossProviderSlotCreds } from '../core/tier-resolver.js';
import { resolveProviderApiKey } from '../core/llm/provider-keys.js';
import { resolveTools } from '../tools/resolve-tools.js';
import { isHumanInTheLoopTool } from './human-in-the-loop.js';
import type { PromptBudget } from './prompt-budget.js';
import { withCurrentTimePrefix, GROUNDING_PROMPT_BLOCK } from '../core/prompts.js';

const INLINE_EXCLUDED_TOOLS = new Set(['spawn_agent', 'run_workflow']);

// Core tools sufficient for most pipeline steps — avoids loading ~20 tool
// definitions (~3000 tokens/turn). `knowledge_search` was the pre-B1 memory
// API and no longer exists in the tool registry (dropped to flat-file via
// PR #540); without an explicit memory_* entry here, workflow sub-steps
// silently degraded with "Tool not available: memory_recall" when a step
// tried to recall what a previous step stored. memory_recall + memory_store
// + memory_update + memory_list are read-or-tenant-scoped and safe in the
// inline sandbox. memory_delete + memory_promote stay opt-in via per-step
// allowTools because they're destructive / confidence-changing.
export const INLINE_CORE_TOOLS = new Set([
  'bash', 'read_file', 'write_file', 'http', 'ask_user',
  'data_store_query', 'data_store_insert',
  'memory_recall', 'memory_store', 'memory_update', 'memory_list',
]);

/**
 * A2 observability: a step's tool calls are recorded under its own
 * `pipeline_step` run id. The runner builds this callback (closing over the
 * step run id + RunHistory + a sequence counter) and threads it into the
 * direct-Agent spawners; `null`/absent = recording disabled (no RunHistory,
 * e.g. ad-hoc tests). Recording is best-effort and never breaks the run.
 */
export type StepToolRecorder = (call: {
  toolName: string;
  inputJson: string;
  outputJson: string;
  durationMs: number;
  isError: boolean;
}) => void;

/** Bounded, crash-safe JSON for tool-call previews (no PII guarantees here —
 * the inputs are tool arguments already redacted upstream where needed). */
function boundedJson(value: unknown, max = 4000): string {
  if (value === undefined) return '{}';
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value) ?? 'null';
    return s.length > max ? s.slice(0, max) : s;
  } catch {
    return '"[unserializable]"';
  }
}

/**
 * Build the per-Agent `onStream` handler shared by `spawnInline` /
 * `spawnViaAgent`. It (a) tallies `turn_end` token usage via `onTokens` and
 * (b) — when a recorder is present — captures the step agent's OWN tool calls
 * (`!subAgent`, so forwarded child events aren't double-recorded). Per-Agent
 * closure ⇒ race-safe for parallel STEPS (the global `channels.toolEnd` carries
 * no run id and would mis-attribute concurrent steps).
 *
 * `StreamEvent` carries no `tool_use_id` or duration, so a `tool_result` is
 * paired to its `tool_call` FIFO by name and self-timed. Limitation: when one
 * turn issues ≥2 calls of the SAME tool concurrently and their results complete
 * out of call-order, the recorded input↔output pairing for those same-named
 * calls may be swapped (the set of inputs/outputs is still correct, and
 * tokens/cost/status are unaffected — they come from `turn_end`). This is an
 * observability-only imperfection; an exact fix needs a `tool_use_id` on the
 * stream events, out of scope for this slice.
 */
export function createStepStreamHandler(opts: {
  onTokens: (inputDelta: number, outputDelta: number) => void;
  recordToolCall?: StepToolRecorder | undefined;
}): (event: StreamEvent) => void {
  const pending: Array<{ name: string; input: unknown; start: number }> = [];
  return (event: StreamEvent): void => {
    if (event.type === 'turn_end') {
      opts.onTokens(event.usage.input_tokens, event.usage.output_tokens);
      return;
    }
    const record = opts.recordToolCall;
    if (!record) return;
    if (event.type === 'tool_call' && !event.subAgent) {
      pending.push({ name: event.name, input: event.input, start: Date.now() });
    } else if (event.type === 'tool_result' && !event.subAgent) {
      const idx = pending.findIndex(p => p.name === event.name);
      const matched = idx >= 0 ? pending.splice(idx, 1)[0] : undefined;
      record({
        toolName: event.name,
        inputJson: boundedJson(matched?.input),
        outputJson: boundedJson(event.result),
        durationMs: matched ? Math.max(0, Date.now() - matched.start) : 0,
        isError: event.isError === true,
      });
    }
  };
}

/**
 * Per-pipeline-run sub-agent prompt callbacks + budget tracking.
 * Stitched together by `runManifest` and forwarded into spawners.
 */
export interface SubAgentPromptHandles {
  parentPromptUser?: PromptUserFn | undefined;
  parentPromptTabs?: PromptTabsFn | undefined;
  parentPromptSecret?: PromptSecretFn | undefined;
  promptBudget?: PromptBudget | undefined;
}

/**
 * Build the per-step Agent prompt callbacks. Wraps the parent callbacks so
 * each prompt is tagged with the originating step's id + task. Returns
 * undefined for callbacks the parent didn't provide (autonomous run).
 *
 * If a PromptBudget is attached, every successful prompt consumes one slot;
 * once the budget is exhausted the wrapper throws PromptBudgetExceededError
 * which surfaces back to the sub-agent as a tool error — the agent learns
 * to plan within the budget on the next turn.
 */
export function buildSubAgentPromptCallbacks(
  step: ManifestStep,
  parent: SubAgentPromptHandles | undefined,
): { promptUser?: PromptUserFn | undefined; promptTabs?: PromptTabsFn | undefined; promptSecret?: PromptSecretFn | undefined } {
  if (!parent) return {};
  const meta: PromptMeta = { stepId: step.id, stepTask: step.task };
  const budget = parent.promptBudget;
  // Budget is checked up-front (so a saturated budget rejects without ever
  // touching the parent), then refunded if the parent rejects/aborts —
  // a flaky network can't drain the cap without the user actually seeing
  // a prompt.
  return {
    promptUser: parent.parentPromptUser
      ? async (q, opts, m) => {
          if (budget) budget.consume();
          try {
            return await parent.parentPromptUser!(q, opts, { ...meta, ...m });
          } catch (err) {
            if (budget) budget.refund();
            throw err;
          }
        }
      : undefined,
    promptTabs: parent.parentPromptTabs
      ? async (qs, m) => {
          if (budget) budget.consume();
          try {
            return await parent.parentPromptTabs!(qs, { ...meta, ...m });
          } catch (err) {
            if (budget) budget.refund();
            throw err;
          }
        }
      : undefined,
    promptSecret: parent.parentPromptSecret
      ? async (n, p, k, m) => {
          if (budget) budget.consume();
          try {
            return await parent.parentPromptSecret!(n, p, k, { ...meta, ...m });
          } catch (err) {
            if (budget) budget.refund();
            throw err;
          }
        }
      : undefined,
  };
}

export function stripHumanInTheLoopTools(tools: ToolEntry[]): ToolEntry[] {
  if (!tools.some(t => isHumanInTheLoopTool(t.definition.name))) return tools;
  return tools.filter(t => !isHumanInTheLoopTool(t.definition.name));
}

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
 * When maxTier is set (managed hosting), tiers are clamped before resolution.
 */
export function resolveModel(stepModel: string | undefined, defaultTier: ModelTier, maxTier?: ModelTier | undefined): string {
  const provider = getActiveProvider();
  if (!stepModel) {
    const clamped = clampTier(defaultTier, maxTier);
    return getModelId(clamped, provider);
  }
  // Accept a tier name in either the current (fast/balanced/deep) or the legacy
  // Anthropic-brand (haiku/sonnet/opus) form — manifests + inline pipelines
  // persisted before the 2026-05-29 rename store the old names. A genuine
  // model id (normalizeTier → undefined) passes through unchanged so callers
  // can still pin an explicit id like `claude-opus-4-7`.
  const tier = normalizeTier(stepModel);
  if (tier) {
    const clamped = clampTier(tier, maxTier);
    return getModelId(clamped, provider);
  }
  return stepModel;
}

/**
 * Resolve the per-step Agent wire + creds for an already-resolved tier under the
 * active routing mode. In STANDARD mode (no hybrid tier_set) the result is
 * `crossProviderSlot:false` and the caller keeps its base `config.*` values, so
 * the built Agent is BYTE-IDENTICAL to pre-hybrid behavior. Under a hybrid
 * tier_set with a cross-provider slot for `tier`, the slot drives provider +
 * model + creds so the step lands on the right wire instead of silently running
 * on base (or 404-ing on a model/endpoint mismatch — the #66 pipeline gap).
 *
 * `resolveKey` reads the provider key from env + config (the orchestrator has no
 * SecretStore in scope — unlike spawn.ts, which binds it to the parent agent's
 * vault). It is consulted ONLY on the cross-provider path (`crossProviderSlot`),
 * never in standard mode, so it can never perturb byte-parity. It matters only
 * for a SAME-provider keyless cross slot (one that carries just an api_base_url):
 * `enrichTierSetCreds` injects the key for cross-DIFFERENT-provider slots at
 * config-load, so `hybrid.apiKey` is already populated there and the fallback
 * short-circuits. In the same-provider case `config.api_key` IS the base key, so
 * the fallback lends it only to the base provider — never to a different one.
 */
function resolveStepSlotCreds(config: LynoxUserConfig, tier: ModelTier): ReturnType<typeof resolveCrossProviderSlotCreds> {
  const baseProvider = config.provider ?? getActiveProvider();
  const resolveKey = (provider: LLMProvider): string | undefined => {
    const resolved = resolveProviderApiKey({ provider, apiBaseURL: config.api_base_url, secretStore: undefined, userConfig: config });
    return resolved ?? (provider === baseProvider ? config.api_key : undefined);
  };
  return resolveCrossProviderSlotCreds(tier, baseProvider, resolveKey);
}

/**
 * Spawn a real agent for a manifest step and capture token usage.
 */
export async function spawnViaAgent(
  step: ManifestStep,
  agentDef: AgentDef,
  stepContext: Record<string, unknown>,
  config: LynoxUserConfig,
  gateAdapter: GateAdapter | undefined,
  runId: string,
  preApproval?: PreApprovalSet | undefined,
  autonomy?: import('../types/index.js').AutonomyLevel | undefined,
  parentPrompt?: SubAgentPromptHandles | undefined,
  userTimezone?: string | undefined,
  capabilityContract?: CapabilityContract | undefined,
  stepRunId?: string | undefined,
  recordToolCall?: StepToolRecorder | undefined,
  secretStore?: SecretStoreLike | undefined,
): Promise<{ result: string; tokensIn: number; tokensOut: number; durationMs: number }> {
  let tokensIn = 0;
  let tokensOut = 0;
  const startTime = Date.now();

  // Single chokepoint: override gate (now a pass-through, D8) + clamp to
  // max_tier + map to the provider's id. The clamp is the cost cap that applies.
  const runModel = resolveRunModel({
    requested: step.model,
    defaultTier: agentDef.defaultTier,
    accountTier: config.account_tier,
    maxTier: config.max_tier,
    provider: getActiveProvider(),
  });
  const model = runModel.modelId;
  // #66: steer this step by the hybrid tier_set. Standard mode (no tier_set) →
  // crossProviderSlot=false → the base config.* values below are byte-identical
  // to before; a cross-provider slot drives the wire + creds so the step lands
  // on the right provider/model instead of running on base (or 404-ing).
  const creds = resolveStepSlotCreds(config, runModel.tier);
  const agentModel = creds.crossProviderSlot ? creds.model : model;

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

  // Strip ask_user / ask_secret if no parent prompt callback (autonomous run).
  // Belt-and-suspenders default: the validator already rejects autonomous
  // pipelines that need them, but a registry drift here would silently throw
  // "ask_user: agent.promptUser is not set" deep in the run.
  if (!parentPrompt?.parentPromptUser) {
    tools = stripHumanInTheLoopTools(tools);
  }

  // Honour user-disabled tools (Settings → Integrations → Tool Toggles).
  // Pipeline steps were previously bypassing this gate — see #401 follow-up.
  const disabledTools = config.disabled_tools ?? [];
  if (disabledTools.length > 0) {
    const disabled = new Set(disabledTools);
    tools = tools.filter(t => !disabled.has(t.definition.name));
  }

  // Resolve thinking from step hint, fallback to adaptive. The legacy
  // `'enabled'` hint maps to adaptive: the manual `{type:'enabled',
  // budget_tokens}` shape 400s on Sonnet 5 / Opus 4.7+ (manual extended
  // thinking removed in the 4.7/5 generation); adaptive is safe on 4.6 too.
  const thinking: ThinkingMode = step.thinking === 'disabled'
    ? { type: 'disabled' }
    : { type: 'adaptive' };

  const promptCallbacks = buildSubAgentPromptCallbacks(step, parentPrompt);

  const agent = new Agent({
    name: step.agent,
    model: agentModel,
    // A2: ground the named-agent pipeline path too. Prepend the block to the
    // agent definition's prompt (or use it standalone when none is defined).
    systemPrompt: agentDef.systemPrompt
      ? `${GROUNDING_PROMPT_BLOCK}\n\n${agentDef.systemPrompt}`
      : GROUNDING_PROMPT_BLOCK,
    tools,
    thinking,
    // Default 'high' matches agent.ts:271 main-agent default (non-Haiku,
    // non-custom-proxy). Pre-2026-05-24 the orchestrator defaulted to 'medium'
    // here while the main-agent defaulted to 'high' — silent split that
    // contradicted the "Gründlich (empfohlen)" UI label.
    effort: step.effort ?? config.effort_level ?? 'high',
    maxIterations: 10,
    excludeTools: disabledTools,
    maxContextWindowTokens: config.max_context_window_tokens,
    costGuard: { maxBudgetUSD: runModel.tier === 'deep' ? 10 : 2, maxIterations: 10 },
    // #66: a cross-provider hybrid slot drives creds from the slot; standard mode
    // (crossProviderSlot=false) keeps the base config.* values → byte-parity.
    apiKey: creds.crossProviderSlot ? creds.apiKey : config.api_key,
    apiBaseURL: creds.crossProviderSlot ? creds.apiBaseURL : config.api_base_url,
    provider: creds.crossProviderSlot ? creds.provider : config.provider,
    gcpProjectId: config.gcp_project_id,
    gcpRegion: config.gcp_region,
    openaiModelId: creds.crossProviderSlot ? creds.openaiModelId : config.openai_model_id,
    preApproval,
    autonomy,
    capabilityContract,
    // Share the parent agent's SecretStore so this step's tools resolve
    // `secret:NAME` refs against the vault AND the fail-loud unresolved-secret
    // guard (agent.ts) fires. Without it the whole secret block is skipped: the
    // literal `secret:NAME` is sent to the external service and the model then
    // papers over the empty/4xx result. Mirrors spawn.ts threading it for
    // `spawn_agent`. Undefined for callers that supply none → unchanged.
    secretStore,
    // A2: the step's own run id (reuses the Agent's `currentRunId` attribution
    // tag), so an isDangerous guard decision during this step is stamped onto
    // the append-only audit with the run it occurred in.
    currentRunId: stepRunId,
    promptUser: promptCallbacks.promptUser,
    promptTabs: promptCallbacks.promptTabs,
    promptSecret: promptCallbacks.promptSecret,
    userTimezone,
    onStream: createStepStreamHandler({
      onTokens: (i, o) => { tokensIn += i; tokensOut += o; },
      recordToolCall,
    }),
  });

  activePipelineAgents.add(agent);
  const timeoutMs = step.timeout_ms ?? 1_800_000;
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    agent.abort();
  }, timeoutMs);
  try {
    // Sub-agent gets the same per-turn time anchor as top-level chat,
    // so a pipeline step that schedules "in 5 min" via run_at lands at
    // wallclock + 5 min, not session-start + 5 min.
    const result = await agent.send(withCurrentTimePrefix(JSON.stringify(stepContext), userTimezone));
    if (timedOut) {
      throw new Error(`Step "${step.id}" timed out after ${timeoutMs}ms`);
    }
    return { result, tokensIn, tokensOut, durationMs: Date.now() - startTime };
  } catch (err) {
    // A timeout aborts the agent mid-send → send() now THROWS RunAbortedError
    // instead of returning ''; surface the clearer "timed out" message. Any
    // other abort/error (e.g. the parent workflow was stopped) propagates as-is
    // so the step is recorded as interrupted/failed, not a silent empty success.
    if (timedOut) {
      throw new Error(`Step "${step.id}" timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    activePipelineAgents.delete(agent);
  }
}

/**
 * Build the literal-replay instruction for a captured step. Given the captured
 * tool name + (param-substituted) input object, produces a task that pins the
 * step agent to executing exactly that call — the determinism seam that
 * replaces re-interpreting `description` prose. The prose is appended as
 * read-only context so the agent knows what the call is for. Pure + exported
 * for unit testing.
 */
export function buildReplayInstruction(
  tool: string,
  inputTemplate: Record<string, unknown>,
  description: string | undefined,
): string {
  const lines = [
    'Execute exactly this tool call and return its result. Do not add, omit, rename, or reinterpret any argument, and do not call any other tool first or instead.',
    `Tool: ${tool}`,
    `Input (JSON): ${JSON.stringify(inputTemplate)}`,
  ];
  const trimmed = description?.trim();
  if (trimmed) {
    lines.push(`(Context — what this step accomplishes: ${trimmed})`);
  }
  return lines.join('\n');
}

/**
 * Spawn an inline agent from a task description (no disk agent def needed).
 * Inherits parent tools minus recursion-prone ones.
 */
export async function spawnInline(
  step: ManifestStep,
  stepContext: Record<string, unknown>,
  config: LynoxUserConfig,
  parentTools: ToolEntry[],
  preApproval?: PreApprovalSet | undefined,
  autonomy?: import('../types/index.js').AutonomyLevel | undefined,
  parentToolContext?: ToolContext | undefined,
  parentPrompt?: SubAgentPromptHandles | undefined,
  userTimezone?: string | undefined,
  parentMemory?: IMemory | null | undefined,
  capabilityContract?: CapabilityContract | undefined,
  stepRunId?: string | undefined,
  recordToolCall?: StepToolRecorder | undefined,
  secretStore?: SecretStoreLike | undefined,
): Promise<{ result: string; tokensIn: number; tokensOut: number; durationMs: number }> {
  let tokensIn = 0;
  let tokensOut = 0;
  const startTime = Date.now();

  // Load role if specified
  const resolved = step.role ? getRole(step.role) : undefined;
  if (step.role && !resolved) {
    throw new Error(`Unknown role "${step.role}" on step "${step.id}". Available roles: ${getRoleNames().join(', ')}.`);
  }

  // Single chokepoint: step > role > user config > default, then the override
  // gate (now a pass-through, D8) + CLAMP to max_tier + map to the provider's
  // id. The cost-guard bucket below uses the same resolved tier so the budget
  // can't disagree with the chosen model.
  const configTier = config.default_tier;
  const runModel = resolveRunModel({
    requested: step.model,
    defaultTier: (resolved?.model ?? configTier ?? 'balanced') as ModelTier,
    accountTier: config.account_tier,
    maxTier: config.max_tier,
    provider: getActiveProvider(),
  });
  const model = runModel.modelId;
  // #66: steer this inline step by the hybrid tier_set (see spawnViaAgent).
  // Standard mode → crossProviderSlot=false → byte-parity with the base config.*.
  const creds = resolveStepSlotCreds(config, runModel.tier);
  const agentModel = creds.crossProviderSlot ? creds.model : model;
  // A2: pipeline steps carry the grounding block too (they previously ran on a
  // bare task prompt with no provenance discipline).
  const systemPrompt = `${GROUNDING_PROMPT_BLOCK}\n\nYou are a focused task agent. Complete the task precisely. Return structured data (JSON, Markdown tables) over verbose prose. When creating artifacts, keep HTML/SVG minimal — use plain data + CSS, avoid large JS chart libraries inline. Optimize for clarity, not visual complexity.`;
  // Use minimal tool set for inline steps unless role specifies custom tools
  const roleProfile = resolved
    ? { allowedTools: resolved.allowTools ? [...resolved.allowTools] : undefined, deniedTools: resolved.denyTools ? [...resolved.denyTools] : undefined }
    : null;
  const filteredParent = resolved?.allowTools ? parentTools : parentTools.filter(t => INLINE_CORE_TOOLS.has(t.definition.name));
  let tools = resolveTools(undefined, roleProfile, filteredParent, INLINE_EXCLUDED_TOOLS);
  // Strip ask_user / ask_secret if no parent prompt callback (autonomous run).
  // Belt-and-suspenders: validator/scheduler should already block this path,
  // but a registry drift here would silently throw at tool dispatch time.
  if (!parentPrompt?.parentPromptUser) {
    tools = stripHumanInTheLoopTools(tools);
  }
  // Honour user-disabled tools (Settings → Integrations → Tool Toggles).
  const disabledToolsInline = config.disabled_tools ?? [];
  if (disabledToolsInline.length > 0) {
    const disabledSet = new Set(disabledToolsInline);
    tools = tools.filter(t => !disabledSet.has(t.definition.name));
  }
  // Resolve thinking: step hint > adaptive default. Haiku 4.5 has no
  // extended-thinking support — force disabled regardless of step hint to
  // avoid Anthropic 400 "model does not support" errors. Keyed on the EFFECTIVE
  // model (agentModel): byte-identical to `model` in standard mode, and detects
  // Haiku on the actual slot model under a cross-provider hybrid tier_set.
  const isHaikuStep = agentModel.includes('haiku');
  let thinking: ThinkingMode;
  if (isHaikuStep) {
    thinking = { type: 'disabled' };
  } else if (step.thinking === 'disabled') {
    thinking = { type: 'disabled' };
  } else {
    // Legacy `'enabled'` hint → adaptive: the manual `{type:'enabled',
    // budget_tokens}` shape 400s on Sonnet 5 / Opus 4.7+ (manual extended
    // thinking removed in the 4.7/5 generation); adaptive is safe on 4.6 too.
    thinking = { type: 'adaptive' };
  }
  // Parity with agent.ts:271 main-agent default (non-Haiku, non-custom-proxy).
  const effort = step.effort ?? resolved?.effort ?? config.effort_level ?? 'high';
  const maxIter = 10;

  const promptCallbacks = buildSubAgentPromptCallbacks(step, parentPrompt);

  const agent = new Agent({
    name: step.id,
    model: agentModel,
    systemPrompt,
    tools,
    thinking,
    effort,
    excludeTools: disabledToolsInline,
    maxContextWindowTokens: config.max_context_window_tokens,
    // #66: cross-provider hybrid slot drives creds; standard mode keeps the base
    // config.* values → byte-parity.
    apiKey: creds.crossProviderSlot ? creds.apiKey : config.api_key,
    apiBaseURL: creds.crossProviderSlot ? creds.apiBaseURL : config.api_base_url,
    provider: creds.crossProviderSlot ? creds.provider : config.provider,
    gcpProjectId: config.gcp_project_id,
    gcpRegion: config.gcp_region,
    openaiModelId: creds.crossProviderSlot ? creds.openaiModelId : config.openai_model_id,
    preApproval,
    autonomy,
    capabilityContract,
    // A2: stamp guard decisions during this inline step onto the audit (see spawnViaAgent).
    currentRunId: stepRunId,
    toolContext: parentToolContext,
    // Share the parent agent's SecretStore so this inline step's tools resolve
    // `secret:NAME` refs AND the fail-loud unresolved-secret guard (agent.ts)
    // fires — instead of silently sending the literal `secret:NAME` to the
    // external service. Mirrors spawn.ts for `spawn_agent`; undefined for
    // callers that supply none → unchanged.
    secretStore,
    maxIterations: maxIter,
    costGuard: { maxBudgetUSD: runModel.tier === 'deep' ? 10 : 2, maxIterations: maxIter },
    promptUser: promptCallbacks.promptUser,
    promptTabs: promptCallbacks.promptTabs,
    promptSecret: promptCallbacks.promptSecret,
    userTimezone,
    // Parent-memory wiring: PR #548 added memory_* to INLINE_CORE_TOOLS but
    // a sub-agent constructed without `memory:` has `agent.memory === null`,
    // so every memory_* handler short-circuits with "Memory is not configured
    // for this agent." (caught 2026-05-23 live verification). Pass-through
    // null when parent had no memory — that's strictly equivalent to the
    // previous behaviour and keeps headless callers + ad-hoc tests untouched.
    memory: parentMemory ?? undefined,
    onStream: createStepStreamHandler({
      onTokens: (i, o) => { tokensIn += i; tokensOut += o; },
      recordToolCall,
    }),
  });

  activePipelineAgents.add(agent);
  const timeoutMs = step.timeout_ms ?? 1_800_000;
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    agent.abort();
  }, timeoutMs);

  // Captured steps replay the literal call — but ONLY when the captured tool is
  // actually in this step's (deliberately minimal) inline tool set. A captured
  // tool the inline sandbox doesn't grant (e.g. a non-core or destructive tool)
  // falls back to the param-substituted prose task rather than instructing the
  // agent to call a tool it doesn't have. No sandbox widening — the inline
  // allowlist stays the security boundary. `step.task` / `step.input_template`
  // are already param-substituted by the runner before spawn.
  const task = (step.tool !== undefined
      && step.input_template !== undefined
      && tools.some(t => t.definition.name === step.tool))
    ? buildReplayInstruction(step.tool, step.input_template, step.task)
    : step.task;

  try {
    const result = await agent.send(withCurrentTimePrefix(JSON.stringify({ task, context: stepContext }), userTimezone));
    if (timedOut) {
      throw new Error(`Step "${step.id}" timed out after ${timeoutMs}ms`);
    }
    return { result, tokensIn, tokensOut, durationMs: Date.now() - startTime };
  } catch (err) {
    // A timeout aborts the agent mid-send → send() now THROWS RunAbortedError
    // instead of returning ''; surface the clearer "timed out" message. Any
    // other abort/error (e.g. the parent workflow was stopped) propagates as-is
    // so the step is recorded as interrupted/failed, not a silent empty success.
    if (timedOut) {
      throw new Error(`Step "${step.id}" timed out after ${timeoutMs}ms`);
    }
    throw err;
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
  config: LynoxUserConfig,
  parentTools: ToolEntry[],
  depth: number,
  parentPrompt?: SubAgentPromptHandles | undefined,
  userTimezone?: string | undefined,
  parentSessionCounters?: import('../types/agent.js').SessionCounters | undefined,
  parentMemory?: IMemory | null | undefined,
  autonomy?: import('../types/index.js').AutonomyLevel | undefined,
  capabilityContract?: CapabilityContract | undefined,
  runHistory?: import('../core/run-history.js').RunHistory | null | undefined,
  secretStore?: SecretStoreLike | undefined,
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
      effort: s.effort,
      thinking: s.thinking,
      input_from: s.input_from,
      timeout_ms: s.timeout_ms,
      tool: s.tool,
      input_template: s.input_template,
    })),
    gate_points: [],
    on_failure: 'stop',
    execution: 'parallel',
  };

  const startTime = Date.now();
  const state = await runManifest(subManifest, config, {
    parentTools,
    depth: depth + 1,
    parentPrompt,
    userTimezone,
    parentSessionCounters,
    parentMemory,
    // Thread the run's posture into the nested sub-pipeline. Without this a
    // `runtime:'pipeline'` step inside a headless `autonomous` workflow re-spawns
    // its inner steps with autonomy=undefined → a benign DANGEROUS_BASH op is
    // denied non-interactively and the run silently fails — the C1 bug leaking
    // through nesting. The capability-contract seam rides along for Slice B.
    autonomy,
    capabilityContract,
    // A2: thread RunHistory so the nested sub-pipeline's steps record their own
    // `pipeline_step` rows (under the sub-pipeline's run id) — observability at
    // every nesting depth, not just the top level.
    runHistory: runHistory ?? undefined,
    // Carry the parent SecretStore into the nested pipeline so a
    // `runtime:'pipeline'` step's inner inline/named steps also resolve secrets
    // + fire the fail-loud guard, instead of dropping it one level down.
    secretStore,
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
