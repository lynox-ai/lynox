import { randomUUID } from 'node:crypto';

import type { ToolEntry, SpawnSpec, IAgent, ModelTier, StreamHandler, IsolationConfig, IsolationLevel, CostGuardConfig, ModelProfile, ProviderConfigSnapshot, LynoxUserConfig, LLMProvider } from '../../types/index.js';
import { getDefaultMaxTokens } from '../../types/index.js';
import { reportMeteredCost } from '../../core/metered-request.js';
import { getActiveProvider } from '../../core/llm-client.js';
import { Agent, RunAbortedError } from '../../core/agent.js';
import type { AgentConfig } from '../../types/index.js';
import { loadConfig } from '../../core/config.js';
import { getPricing } from '../../core/pricing.js';
import { channels } from '../../core/observability.js';
import { getRole, getRoleNames } from '../../core/roles.js';
import { resolveRunModel } from '../../core/tier-resolver.js';
import { resolveTools } from '../resolve-tools.js';

import { checkSessionBudget } from '../../core/session-budget.js';
import { escapeXml, wrapUntrustedData } from '../../core/data-boundary.js';
import { withCurrentTimePrefix, GROUNDING_PROMPT_BLOCK } from '../../core/prompts.js';
import {
  DEFAULT_SPAWN_BUDGET_USD,
  DEFAULT_SPAWN_MAX_TURNS,
  MAX_SPAWN_AGENTS,
  MAX_SPAWN_BUDGET_USD,
  MAX_SPAWN_DEPTH,
  MAX_SPAWN_NAME_LENGTH,
  MAX_SPAWN_TASK_LENGTH,
  MAX_SPAWN_TURNS,
} from '../../core/limits.js';

const SPAWN_TIMEOUT = 10 * 60 * 1000;
const SPAWN_EXCLUDED = new Set(['spawn_agent']);

/** Empirical p90 fill of a model's maxOutput per turn; overshoots are caught by the per-spawn cost guard. */
const SPAWN_OUTPUT_FILL_RATIO = 0.3;

/**
 * Reset a Session's spawn-cost counter (for testing). The counter now
 * lives on `SessionCounters.costUSD` — pass the counters object to clear
 * just that Session, rather than a process-wide reset.
 */
export function resetSessionSpawnCost(counters: import('../../types/index.js').SessionCounters): void {
  counters.costUSD = 0;
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

/**
 * Five provider fields a sub-agent needs to talk to an LLM. Carries `apiKey`
 * as plaintext, so the result is consumed inline by `AgentConfig` construction
 * and never logged / serialized / sent to telemetry.
 *
 * Exported only for the unit tests that walk the precedence chain end-to-end.
 */
export interface ChildProviderConfig {
  apiKey: string | undefined;
  apiBaseURL: string | undefined;
  provider: LLMProvider | undefined;
  openaiModelId: string | undefined;
  openaiAuth: 'static' | 'google-vertex' | undefined;
}

/**
 * Reads the parent agent's `getProviderConfig()` defensively — legacy `IAgent`
 * mocks in older tests don't implement the method, so the typeof check keeps
 * the spawn path working without forcing a `__mocks__` update. Returns `null`
 * when the parent has no `getProviderConfig` member at all.
 */
function readParentProviderConfig(parentAgent: IAgent): ProviderConfigSnapshot | null {
  const candidate = (parentAgent as { getProviderConfig?: unknown }).getProviderConfig;
  if (typeof candidate !== 'function') return null;
  return (parentAgent as { getProviderConfig: () => ProviderConfigSnapshot }).getProviderConfig();
}

/**
 * Resolve sub-agent provider config along an explicit 3-tier precedence chain:
 *
 *   1. **profile** — a `ModelProfile` (named entry from `userConfig.model_profiles`)
 *      passed via `spec.profile`. Wins everything: a user who pinned a named
 *      profile for this spawn explicitly opted out of inheritance.
 *   2. **parent** — the parent agent's runtime `getProviderConfig()`. Closes
 *      the staging bug where managed-tier UI provider-switch wasn't reflected
 *      in `~/.lynox/config.json` and sub-agents got undefined apiBaseURL.
 *   3. **userConfig** — `loadConfig()` from disk. Final fallback for
 *      self-host paths where parent didn't set its provider config explicitly.
 *
 * Per-field nullish-coalesce means a profile that sets only `api_key` still
 * inherits `api_base_url` from the parent (or, finally, the user config).
 * The mid-tier `parent` may be `null` for legacy `IAgent` mocks without
 * `getProviderConfig()` — see `readParentProviderConfig`.
 */
export function resolveChildProviderConfig(
  profile: ModelProfile | undefined,
  parent: ProviderConfigSnapshot | null,
  userConfig: LynoxUserConfig,
): ChildProviderConfig {
  return {
    apiKey: profile?.api_key ?? parent?.apiKey ?? userConfig.api_key,
    apiBaseURL: profile?.api_base_url ?? parent?.apiBaseURL ?? userConfig.api_base_url,
    provider: profile?.provider ?? parent?.provider ?? userConfig.provider,
    openaiModelId: profile?.model_id ?? parent?.openaiModelId,
    openaiAuth: profile?.auth ?? parent?.openaiAuth,
  };
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
): Promise<{ result: string; childRunId: string | undefined; model: string }> {
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

  // Single chokepoint: the override gate (now a pass-through, D8) THEN CLAMP to
  // the cost ceiling THEN map to the provider's model id. Routing through
  // resolveRunModel adds the max_tier clamp this path previously skipped — a run
  // under a lower ceiling no longer reaches the deep model past its cap.
  const resolvedRun = resolveRunModel({
    requested: spec.model,
    defaultTier: (resolved?.model ?? userConfig.default_tier ?? 'balanced') as ModelTier,
    accountTier: userConfig.account_tier,
    maxTier: userConfig.max_tier,
    provider: getActiveProvider(),
  });
  const modelTier = resolvedRun.tier;
  // Profile overrides model ID + provider; otherwise use the resolved tier id.
  const model = profile ? profile.model_id : resolvedRun.modelId;
  // A2: every sub-agent carries the grounding block. Prepend it to the
  // caller-supplied prompt, OR use it standalone when none was given — otherwise
  // the child falls through to agent.ts's bare default, which has NO grounding.
  const systemPrompt = spec.system_prompt
    ? `${GROUNDING_PROMPT_BLOCK}\n\n${spec.system_prompt}`
    : GROUNDING_PROMPT_BLOCK;
  // OpenAI providers don't support thinking or effort
  const thinking = profile ? { type: 'disabled' as const } : spec.thinking;
  const effort = profile ? undefined : (spec.effort ?? resolved?.effort);
  const maxIterations = spec.max_turns;

  // Tool scoping — map RoleConfig fields to resolveTools interface
  const roleProfile = resolved
    ? { allowedTools: resolved.allowTools ? [...resolved.allowTools] : undefined, deniedTools: resolved.denyTools ? [...resolved.denyTools] : undefined }
    : null;
  // Use the parent's FILTERED tool list (honours user-disabled tools from
  // Settings → Tool Toggles). Without this, a spawn from a prompt-injected
  // parent could re-introduce tools the user explicitly disabled — the
  // exact surface the Tool-Toggle PR was meant to close.
  const tools = resolveTools(spec.tools, roleProfile, parentAgent.getAvailableTools(), SPAWN_EXCLUDED);

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

  // T2-X1 (PRD-HN-LAUNCH-HARDENING) part 4+5: mint a RunHistory row for the
  // child BEFORE constructing the Agent so (a) the constructor can stamp
  // `currentRunId` onto the child, (b) the post-run `updateRun()` below
  // records actual cost keyed on that id, and (c) the daily/monthly cost-cap
  // aggregator (`RunHistory.getCostByDay` → `session-budget.checkPersistentBudget`)
  // sees the spawn spend. Without this, a self-hoster's BYOK cap can drift
  // past their configured limit via fan-out (spawn-child spend is invisible
  // to the runs table today). RunHistory comes from the parent's
  // toolContext — engine-init wires it at startup. Falls back to undefined
  // when no history is configured (ad-hoc Agent ctor outside Session).
  const runHistory = parentAgent.toolContext.runHistory;
  let childRunId: string | undefined;
  if (runHistory) {
    try {
      childRunId = runHistory.insertRun({
        sessionId: parentAgent.currentThreadId ?? '',
        taskText: spec.task,
        modelTier: modelTier as string,
        modelId: model,
        runType: 'single',
        spawnParentId: parentAgent.currentRunId,
        spawnDepth: childDepth,
      });
    } catch {
      // Persistence failures must never break a spawn. Cost simply won't
      // be recorded for this child — caps see exactly what they saw pre-fix.
      childRunId = undefined;
    }
  }

  const agentConfig: AgentConfig = {
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
    // Propagate parent's excludeTools so child's defense-in-depth check
    // refuses tool_use blocks naming disabled tools (in addition to the
    // tool list itself already being filtered above).
    excludeTools: [...parentAgent.getExcludedToolNames()],
    // Inherit the user's context-window cap so a spawned researcher running
    // on a 1M-native model still respects the user's 200k preference.
    maxContextWindowTokens: parentAgent.getMaxContextWindowTokens(),
    // Declared native window: a spawn-time profile's `context_window` wins,
    // else inherit the parent's so a sub-agent on the same custom/BYOK/self-host
    // model trims against the real window, not the 200k id-fallback.
    nativeContextWindow: profile?.context_window ?? parentAgent.getNativeContextWindow(),
    // Profile overrides provider credentials; otherwise INHERIT from parent
    // agent (runtime config), not from loadConfig() (config.json file).
    // Closes the staging bug where managed-tier UI provider-switch isn't
    // reflected in config.json — sub-agent got undefined apiBaseURL and
    // llm-client threw "OpenAI provider requires apiBaseURL". Profile +
    // userConfig.* preserved as fallback for self-host paths where the
    // parent might not have set its provider config explicitly.
    // Precedence chain documented + unit-tested in `resolveChildProviderConfig`.
    ...resolveChildProviderConfig(profile, readParentProviderConfig(parentAgent), userConfig),
    gcpProjectId: userConfig.gcp_project_id,
    gcpRegion: userConfig.gcp_region,
    userTimezone: parentAgent.userTimezone,
    // Share the parent's Session counters so one conversation accumulates
    // a single http/write budget across the main agent + all sub-agents.
    sessionCounters: parentAgent.sessionCounters,
    // Share the recall blob store so a sub-agent's `recall_tool_result` can
    // resolve handles minted by the parent conversation's last compaction.
    toolResultBlobStore: parentAgent.toolResultBlobStore,
    // T2-X1 part 1: shallow-copy parent's toolContext so the child sees the
    // engine's DataStore / RunHistory / ApiStore / KnowledgeLayer / network
    // policy refs (sub-agents need these to use tools). Shallow copy =
    // distinct object, shared refs — so the child INHERITS the parent's
    // `networkPolicy`/`allowedHosts` and cannot escape to broader egress than
    // its parent (the safe direction). Child-side TIGHTENING (a child more
    // restricted than its parent, via `childIsolation → networkPolicy`) is
    // still explicitly post-launch (PRD §6); T2-X1 does NOT claim to close
    // child network isolation, only that a child never widens egress.
    //
    // Reach delta (intentional, autonomy-inheritance): the shared refs are
    // also write-reachable — a child can mutate parent state through
    // dataStore / apiStore / runHistory (e.g. updateRun on the parent's
    // row). Acceptable because the child IS trusted code, but not hidden.
    toolContext: { ...parentAgent.toolContext },
    // T2-X1 part 2: share the parent's SecretStore so `ask_secret`, vault
    // reads, and tool credential lookups work in the child. Documented
    // reach delta: a child's `http_request` will auto-inject `Bearer` tokens
    // for any oauth2 api_profile (http.ts ~415-427) using the parent's
    // vault, AND the child can WRITE/overwrite the parent's vault entries
    // via `secretStore.set`. Both are INTENTIONAL — sub-agents inherit the
    // parent's autonomy, and a researcher spawned to query the user's
    // Stripe/Notion API must be able to authenticate and persist a refresh
    // token. Surfaced explicitly in the PR body, not hidden.
    secretStore: parentAgent.secretStore,
    // T2-X1 part 3: pass the three prompt callbacks so an `ask_user`/
    // `ask_secret`/`ask_tabs` invoked by the child surfaces to the same UI
    // the parent uses. Without these, child tool invocations that need user
    // input silently fail (the prompt callback is undefined).
    promptUser: parentAgent.promptUser,
    promptSecret: parentAgent.promptSecret,
    promptTabs: parentAgent.promptTabs,
    // T2-X1 part 4: pass the pre-minted runId so the constructor stamps it
    // onto the child and the child's downstream code (memory writes,
    // tool-call recording in engine-init's toolEnd subscriber, etc.) can
    // attribute work to this run.
    currentRunId: childRunId,
  };

  // Single try wraps both `new Agent(...)` AND `send(...)` so the runs-row
  // failure-marking catches a synchronous ctor throw too (otherwise the row
  // stays `status='running'` forever and pollutes the history UI). childStart
  // is captured BEFORE the ctor for symmetric durationMs on either failure.
  const childStart = Date.now();
  let childAgent: Agent | undefined;
  try {
    childAgent = new Agent(agentConfig);
    // Track child for abort propagation (added inside try so a ctor throw
    // doesn't leave a half-constructed agent in the active set).
    activeChildAgents.add(childAgent);

    // Same per-turn time anchor as top-level chat / pipeline steps.
    const result = await childAgent.send(withCurrentTimePrefix(task, childAgent.userTimezone));

    // T2-X1 part 5: record the child's actual LLM spend into the same
    // `runs` table the daily/monthly cost-cap aggregator reads. The
    // session-budget pre-flight already reserved an *estimate* (see
    // `estimateSpawnCost` + `checkSessionBudget` in the handler below) —
    // this final updateRun is the post-hoc truth, and crucially it makes
    // the spend visible to `getCostByDay` so a self-hoster's $-per-day
    // cap actually counts spawn work.
    if (runHistory && childRunId) {
      try {
        const snap = childAgent.getCostSnapshot();
        runHistory.updateRun(childRunId, {
          responseText: result,
          tokensIn: snap?.inputTokens ?? 0,
          tokensOut: snap?.outputTokens ?? 0,
          costUsd: snap?.estimatedCostUSD ?? 0,
          durationMs: Date.now() - childStart,
          status: 'completed',
          stopReason: 'end_turn',
        });
      } catch {
        // Persistence failure — non-fatal. The child's result still
        // returns; only the cost-attribution side-effect is missed.
      }
    }

    // The child spent the managed pool key on its OWN token stream, so the
    // parent turn's `onAfterRun` debit never captured this spend — only the
    // local runs table (above) and the pre-flight session-cap RESERVATION in
    // the handler did. Debit the child's ACTUAL cost to the tenant balance so
    // managed billing captures it. CP-only (`reportMeteredCost`, NOT
    // `debitInRunHelperCost`): the local session ceiling was already reserved
    // via `checkSessionBudget` in the handler and is deliberately not
    // reconciled to actual (see the handler comment), so a `recordSessionCost`
    // here would double-count it against the $-per-session cap. No-op on
    // self-host / BYOK (meteredHost null) and for a zero-cost child (the
    // `> 0` guard inside reportMeteredCost).
    const meteredHost = parentAgent.toolContext.meteredHost;
    if (meteredHost) {
      const childCostUsd = childAgent.getCostSnapshot()?.estimatedCostUSD ?? 0;
      reportMeteredCost(meteredHost, randomUUID(), childCostUsd, modelTier);
    }

    return { result, childRunId: childAgent.currentRunId, model };
  } catch (err) {
    // Mark the child run failed/aborted so the cost cap and history UI don't
    // show it as still-running. Fires for BOTH ctor failures (childAgent
    // undefined, no spend yet) and send failures (childAgent constructed,
    // partial spend possible — CostGuard tracks per-turn). An abort (parent
    // stopped → abortSpawnedAgents) now THROWS RunAbortedError instead of
    // returning '' (which mis-recorded the child 'completed'); mark it 'aborted'
    // — an intentional interruption, not a failure.
    const childAborted = err instanceof RunAbortedError;
    if (runHistory && childRunId) {
      try {
        const snap = childAgent?.getCostSnapshot() ?? null;
        runHistory.updateRun(childRunId, {
          tokensIn: snap?.inputTokens ?? 0,
          tokensOut: snap?.outputTokens ?? 0,
          costUsd: snap?.estimatedCostUSD ?? 0,
          durationMs: Date.now() - childStart,
          status: childAborted ? 'aborted' : 'failed',
          stopReason: childAborted ? 'aborted' : (err instanceof Error ? err.message.slice(0, 200) : 'error'),
        });
      } catch { /* swallow */ }
    }
    // A child that aborted / failed mid-run may have spent partial pool-key cost
    // on its own token stream before throwing — never captured by the parent's
    // onAfterRun. Mirror the success-path debit so that partial spend is still
    // billed to the tenant balance instead of silently eaten. CP-only (same
    // rationale as the success path), `> 0`-guarded inside reportMeteredCost,
    // and a no-op when the child was never constructed (ctor throw → no spend).
    if (childAgent) {
      const meteredHost = parentAgent.toolContext.meteredHost;
      if (meteredHost) {
        const childCostUsd = childAgent.getCostSnapshot()?.estimatedCostUSD ?? 0;
        reportMeteredCost(meteredHost, randomUUID(), childCostUsd, modelTier);
      }
    }
    throw err;
  } finally {
    if (childAgent) activeChildAgents.delete(childAgent);
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
              context: { type: 'string', description: 'Additional context prepended to the task. Sub-agents share NO context — pass the REAL source or verbatim excerpts (file paths, quoted figures, actual fact text) the sub-task hinges on, not your paraphrase; a child given only a summary grounds in a guess.' },
              isolated_memory: { type: 'boolean', description: 'If true, agent has no access to parent memory.' },
              system_prompt: { type: 'string' },
              model: { type: 'string', enum: ['deep', 'balanced', 'fast'], description: 'Capability tier — fast (cheap/quick), balanced (default), deep (reasoning-heavy). Provider-agnostic; resolves to a concrete model per the active provider.' },
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
    // model — otherwise fast-tier-roled spawns (operator/collector) get
    // estimated at balanced-tier rates, which over-allocates against the
    // session ceiling and blocks cheap batches.
    const cfg = loadConfig();
    const cfgTier = cfg.default_tier;
    const provider = getActiveProvider();
    const totalEstimate = input.agents.reduce((sum, spec) => {
      const roleDefault = spec.role ? getRole(spec.role)?.model : undefined;
      // Estimate against the SAME model the run will actually use (gate + clamp +
      // provider), not an Anthropic-only tier map — otherwise a Mistral-tenant or
      // ceiling-clamped spawn is mis-estimated and over/under-reserves the budget.
      const { modelId } = resolveRunModel({
        requested: spec.model,
        defaultTier: (roleDefault ?? cfgTier ?? 'balanced') as ModelTier,
        accountTier: cfg.account_tier,
        maxTier: cfg.max_tier,
        provider,
      });
      const iters = spec.max_turns ?? DEFAULT_SPAWN_MAX_TURNS;
      return sum + estimateSpawnCost(modelId, iters);
    }, 0);

    // Enforce session cost ceiling (shared with pipeline steps) against
    // this Session's counters object so concurrent spawns on different
    // Sessions don't see each other's reservations.
    checkSessionBudget(agent.sessionCounters, totalEstimate);

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
        // Wrap sub-agent return value in untrusted-data envelope. A sub-agent
        // can ingest attacker-controlled content (read_file output, web pages,
        // mail bodies) and return it verbatim — without the envelope, the
        // parent would see that content as trusted framing rather than data.
        // See H-002 (OVERNIGHT-PUNCH-LIST-2026-05-25) — spawn_agent used to
        // be exempt from the wrap via the INTERNAL_TOOLS allowlist in agent.ts.
        const wrapped = wrapUntrustedData(outcome.value.result, `sub_agent:${spec.name}`);
        // Surface the concrete model this sub-agent actually ran on. Without
        // this the parent only knows the *tier* it requested (e.g. "fast") and
        // would mislabel the sub-agent's model when reporting back — on a
        // non-Anthropic provider "fast" is NOT a Claude model. The Model-identity
        // prompt rule tells the agent to report THIS id, not the tier.
        // The id can originate from user config (`profile.model_id`) and lands
        // in the header OUTSIDE the untrusted-data envelope, so sanitize it to
        // the conventional model-id charset to prevent markdown / boundary-tag
        // injection into the parent context (defense-in-depth; same pattern as
        // `modelIdentityContext`'s safeId).
        const safeModel = String(outcome.value.model).replace(/[^a-zA-Z0-9._:@-]/g, '').slice(0, 64);
        sections.push(`## ${spec.name} (ran on \`${safeModel}\`)\n\n${wrapped}`);
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
