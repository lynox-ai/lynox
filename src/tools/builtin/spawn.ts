import { randomUUID } from 'node:crypto';

import type { ToolEntry, SpawnSpec, IAgent, ModelTier, StreamHandler, IsolationConfig, IsolationLevel, CostGuardConfig, ModelProfile, ProviderConfigSnapshot, LynoxUserConfig, LLMProvider, SpawnedSubAgent } from '../../types/index.js';
import { getDefaultMaxTokens, modelCapability, modelIdExceedsMaxTier, isBlockedModelId } from '../../types/index.js';
import { reportMeteredCost } from '../../core/metered-request.js';
import { getActiveProvider } from '../../core/llm-client.js';
import { Agent, RunAbortedError } from '../../core/agent.js';
import { describeTurnUntrusted } from '../../core/untrusted-signals.js';
import type { AgentConfig } from '../../types/index.js';
import { loadConfig } from '../../core/config.js';
import { getPricing } from '../../core/pricing.js';
import { channels } from '../../core/observability.js';
import { getRole, getRoleNames } from '../../core/roles.js';
import { resolveRunModel, resolveTierModel, hybridSlotClientConfig, getActiveRoutingMode } from '../../core/tier-resolver.js';
import { resolveProviderApiKey } from '../../core/llm/provider-keys.js';
import { resolveTools } from '../resolve-tools.js';

import { checkSessionBudget } from '../../core/session-budget.js';
import { escapeXml, wrapUntrustedData } from '../../core/data-boundary.js';
import { withCurrentTimePrefix, GROUNDING_PROMPT_BLOCK, safeModelId } from '../../core/prompts.js';
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

/**
 * Full wire + creds a spawned child Agent is built with, chosen from the tier the
 * child resolved to — the SEAM the hybrid-spawn provider bug is pinned to.
 *
 * The child Agent is always CONSTRUCTED FRESH (no ambient-client reuse), so it
 * must carry an explicit, self-consistent provider+model+key. Three cases:
 *
 *   1. **Cross-provider hybrid slot** (`crossProviderSlot`) — the slot drives the
 *      wire + creds (Slice 2). A slot that names a DIFFERENT provider than base
 *      is key-enriched upstream; but a slot that is the SAME provider as base and
 *      only carries an `api_base_url` is ALSO reported cross (see
 *      `hybridSlotClientConfig`) yet `enrichTierSetCreds` deliberately left it
 *      key-LESS (same-provider slots relied on the ambient client's key, which a
 *      fresh child doesn't have). So resolve the provider's key when the slot
 *      didn't supply one — else the child mis-routes / 401s with an empty key.
 *
 *   2. **Hybrid BASE-fallback tier** (`routing_mode==='hybrid'`, no cross slot) —
 *      resolve from the BASE provider, NOT the parent. In hybrid the parent runs
 *      on ITS OWN tier's slot (e.g. a Sonnet `balanced` main on the anthropic
 *      wire), so inheriting the parent's provider would pair this child's
 *      base-tier model (ministral-8b) with the parent's anthropic endpoint → a
 *      `404 no Route matched` (the v2.1.1 bug: fast collectors died silently).
 *      Mirror the session's base-tier resolution. An explicit `profile` opts out
 *      → case 3, which honours it.
 *
 *   3. **Standard mode (or an explicit profile)** — inherit the parent. This
 *      closes the managed-tier staging bug where a live UI provider-switch isn't
 *      yet in `config.json`; in standard mode the parent IS on the base provider,
 *      so inheritance is correct.
 *
 * Pure + table-testable: the caller passes a `resolveKey` closure (bound to
 * `resolveProviderApiKey` over the parent's secret store) so no SecretStore is
 * needed in tests.
 */
export function resolveSpawnChildProviderConfig(input: {
  hybridSlot: ReturnType<typeof hybridSlotClientConfig>;
  routingMode: 'standard' | 'hybrid';
  profile: ModelProfile | undefined;
  parent: ProviderConfigSnapshot | null;
  baseProvider: LLMProvider;
  userConfig: LynoxUserConfig;
  /** Endpoint-aware: 'openai' alone cannot tell Mistral from Groq from a local Ollama. */
  resolveKey: (provider: LLMProvider, apiBaseURL?: string) => string | undefined;
}): ChildProviderConfig {
  const { hybridSlot, routingMode, profile, parent, baseProvider, userConfig, resolveKey } = input;

  if (hybridSlot.crossProviderSlot) {
    return {
      provider: hybridSlot.provider,
      apiKey: hybridSlot.apiKey ?? resolveKey(hybridSlot.provider, hybridSlot.apiBaseURL),
      apiBaseURL: hybridSlot.apiBaseURL,
      openaiModelId: hybridSlot.openaiModelId,
      openaiAuth: undefined,
    };
  }

  if (!profile && routingMode === 'hybrid') {
    return {
      provider: baseProvider,
      apiKey: resolveKey(baseProvider, userConfig.api_base_url),
      apiBaseURL: userConfig.api_base_url,
      openaiModelId: userConfig.openai_model_id,
      openaiAuth: undefined,
    };
  }

  return resolveChildProviderConfig(profile, parent, userConfig);
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

/**
 * Structured error detail for a failed spawn child's `error_text` column. The
 * compact `stop_reason` gets a 200-char slice of the message; `error_text` gets
 * the FULL detail — name, an HTTP `status` when the SDK error carries one (so a
 * provider mis-route surfaces as `[404] …` not a bare message), and the message.
 * Without this the runs row records status=failed with a null error_text, which
 * makes a silent sub-agent failure undiagnosable after the fact (the exact gap
 * that hid the v2.1.1 hybrid 404s until the DB was read by hand).
 */
export function formatSpawnError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const status = (err as { status?: unknown }).status;
  const statusPrefix = typeof status === 'number' ? `[${status}] ` : '';
  return `${statusPrefix}${err.name}: ${err.message}`;
}

/**
 * Does a spawn `profile` route a child to a model whose cost band exceeds the
 * tenant's `max_tier` ceiling? A profile pins a concrete `model_id` that bypasses
 * the tier clamp (it wins over the resolved tier), so this is the guard that keeps
 * an agent-set (hence prompt-injectable) profile from escaping the cost ceiling.
 *
 * REFUSE, not clamp: a profile is a specific endpoint, so you cannot substitute a
 * cheaper model on it (DEF-0080). Semantics:
 *  - no ceiling (`max_tier` unset, i.e. self-host default) → never exceeds.
 *  - `max_tier: 'deep'` → not restrictive (nothing is above deep) → never exceeds,
 *    including an unregistered model.
 *  - a restrictive ceiling (`fast`/`balanced`): a REGISTERED model exceeds if its
 *    tier is above the ceiling; an UNREGISTERED model (no known tier) is refused
 *    conservatively — its band can't be proven within the ceiling.
 */
export function profileExceedsMaxTier(profileModelId: string, maxTier: ModelTier | undefined): boolean {
  // Delegates to the shared predicate — the same rule now guards the tier
  // chokepoint (`resolveRunModel`), so a raw pipeline `step.model` id is refused
  // the same way a profile is (DEF-0080). (`spec.model` here is separately enum-
  // gated to tiers, so it never reaches the chokepoint's raw-id branch.) Kept as a
  // domain-named wrapper.
  return modelIdExceedsMaxTier(profileModelId, maxTier);
}

/**
 * Which model a spawned child will actually run on, and the hybrid slot that
 * decides its wire.
 *
 * Shared because three callers must give the SAME answer: the pre-spawn cost
 * reservation, the `spawn` event the UI renders, and the child's own
 * construction. Two of them used to compute it separately and disagreed — the
 * reservation fell back to the tenant's `default_tier` while the run pins
 * unroled spawns to `balanced`, so an instance configured `default_tier: 'deep'`
 * reserved deep rates against the session ceiling for a child that then ran
 * balanced. One function, one answer; a UI that names a third model would be
 * worse still.
 *
 * Validation stays with the caller: this resolves, it does not refuse. The
 * refusals live in `assertSpawnRoutingPermitted`, which the handler runs BEFORE
 * it announces the batch — see that function for why the ordering is the whole
 * point.
 */
export function resolveSpawnChildRouting(input: {
  spec: SpawnSpec;
  role: ReturnType<typeof getRole>;
  profile: ModelProfile | undefined;
  userConfig: LynoxUserConfig;
  baseProvider: LLMProvider;
}): { tier: ModelTier; model: string; hybridSlot: ReturnType<typeof hybridSlotClientConfig> } {
  const { spec, role, profile, userConfig, baseProvider } = input;
  // Single chokepoint: the override gate (now a pass-through, D8) THEN CLAMP to
  // the cost ceiling THEN map to the provider's model id. Routing through
  // resolveRunModel adds the max_tier clamp this path previously skipped — a run
  // under a lower ceiling no longer reaches the deep model past its cap.
  const resolvedRun = resolveRunModel({
    requested: spec.model,
    // Unroled spawns pin to `balanced`, NOT the main chat's `default_tier`
    // (rafael 2026-07-07): once the "Main chat model" picker can raise the main
    // chat to `deep` (Opus/Large), letting tier-unspecified spawns inherit that
    // would silently multiply per-message cost. Roles keep their own tier
    // (operator/collector=fast); an explicit `spec.model` still wins via
    // resolveRunModel's `requested`.
    defaultTier: (role?.model ?? 'balanced') as ModelTier,
    accountTier: userConfig.account_tier,
    maxTier: userConfig.max_tier,
    blockedModelIds: userConfig.blocked_model_ids,
    provider: baseProvider,
  });
  // Slice 2: a subagent's tier follows the hybrid tier_set. When the resolved
  // tier has a CROSS-provider slot (e.g. a Mistral main with a `deep`→Sonnet-5
  // slot), the child runs on that slot's provider/model/creds with a dedicated
  // client — no per-spawn `profile:` needed. `spec.profile` still WINS (an
  // explicit opt-out of inheritance). Standard mode returns no slot
  // (resolveTierModel gates on hybrid) → this is byte-parity with before.
  const hybridSlot = profile
    ? { crossProviderSlot: false as const }
    : hybridSlotClientConfig(resolveTierModel(resolvedRun.tier, baseProvider), baseProvider);
  // Profile overrides model ID + provider; a cross-provider hybrid slot supplies
  // its own model; otherwise use the resolved tier id for the base provider.
  const model = profile
    ? profile.model_id
    : (hybridSlot.crossProviderSlot ? hybridSlot.openaiModelId : resolvedRun.modelId);
  return { tier: resolvedRun.tier, model, hybridSlot };
}

/**
 * Every reason a spawn spec is refused outright, in one place — and it runs
 * BEFORE the batch is announced.
 *
 * WHY THE ORDERING IS THE POINT. These four refusals used to live inside
 * `executeThinker`, which is reached only after the `spawn` event has already
 * been streamed to the client. So a `spawn_agent({profile})` naming a model above
 * the tenant's `max_tier` was ANNOUNCED with that model id — the panel rendered
 * `child · claude-opus-4-6` as "the model it runs on" — and only then refused.
 * The UI named a model the run demonstrably would not use, which is precisely
 * the failure the shared-resolution work was done to remove. Announcing after
 * validation makes the panel's model id true by construction.
 *
 * `executeThinker` calls this too. Not redundancy for its own sake: the
 * announcement path and the construction path must refuse for the same reasons,
 * and one function is the only way that stays true when a fifth reason is added.
 */
function assertSpawnRoutingPermitted(spec: SpawnSpec, userConfig: LynoxUserConfig): void {
  if (spec.role && !getRole(spec.role)) {
    throw new Error(
      `Unknown role "${spec.role}". Available roles: ${getRoleNames().join(', ')}. ` +
      `If none of these fit, omit the "role" field and set model/effort/tools directly.`,
    );
  }

  const profile: ModelProfile | undefined = spec.profile
    ? userConfig.model_profiles?.[spec.profile]
    : undefined;
  if (spec.profile && !profile) {
    throw new Error(`Unknown model profile "${spec.profile}". Available: ${Object.keys(userConfig.model_profiles ?? {}).join(', ') || 'none configured'}.`);
  }
  if (!profile) return;

  // A profile sets `model = profile.model_id`, bypassing the `max_tier` clamp
  // that `resolveRunModel` applies to a tier. That is the injection lever
  // (DEF-0093): a prompt-injected `spawn({profile})` could route a child to a
  // model above the tenant's cost ceiling. A profile cannot be clamped DOWN (you
  // cannot substitute a different model on someone's endpoint), so the
  // enforcement is REFUSE, not clamp (DEF-0080). Cross-provider hybrid spawn is
  // unaffected — that runs on the tier path.
  if (profileExceedsMaxTier(profile.model_id, userConfig.max_tier)) {
    const band = modelCapability(profile.model_id)?.tier;
    throw new Error(`Model profile "${spec.profile}" (${profile.model_id}) is not permitted on this instance: its cost band ${band ? `"${band}"` : '(unknown)'} exceeds the max tier "${userConfig.max_tier}". A profile pins a specific endpoint and cannot be clamped down, so the spawn is refused. Use the \`model\` tier parameter (fast/balanced/deep) for a ceiling-clamped subagent.`);
  }
  // Model blocklist (blocked_model_ids): a profile pinning a blocked model is
  // refused the same way — a pinned endpoint cannot be substituted, so REFUSE,
  // not clamp. Same checkpoint as the ceiling guard above (write-accept ⟺
  // load-keep ⟺ resolve symmetry for the profile raw-id path).
  if (isBlockedModelId(profile.model_id, userConfig.blocked_model_ids)) {
    throw new Error(`Model profile "${spec.profile}" (${profile.model_id}) is not permitted on this instance: the model is blocked by the operator model blocklist. A profile pins a specific endpoint and cannot be substituted, so the spawn is refused. Use the \`model\` tier parameter (fast/balanced/deep) for a subagent on a permitted model.`);
  }
}

async function executeThinker(
  spec: SpawnSpec,
  parentAgent: IAgent,
  parentOnStream: StreamHandler | null,
  childDepth: number,
  /**
   * The child's actual spend, reported once it stops for ANY reason — done,
   * failed, or aborted. A child that dies halfway still spent what it spent,
   * and the caller needs that number even though it never receives a result.
   */
  onSettled?: (costUsd: number) => void,
): Promise<{ result: string; childRunId: string | undefined; model: string }> {
  // 4-tier resolution: spec fields > role defaults > user config > global default
  const userConfig = loadConfig();

  // Same refusals the handler already ran before announcing the batch. Kept here
  // because this is the path that BUILDS the child: the two must never diverge,
  // and a fifth refusal added to one and not the other is exactly how the UI came
  // to announce a model the run refused.
  assertSpawnRoutingPermitted(spec, userConfig);

  const resolved = spec.role ? getRole(spec.role) : undefined;
  const profile: ModelProfile | undefined = spec.profile
    ? userConfig.model_profiles?.[spec.profile]
    : undefined;

  const baseProvider = getActiveProvider();
  const { tier: modelTier, model, hybridSlot } = resolveSpawnChildRouting({
    spec, role: resolved, profile, userConfig, baseProvider,
  });
  // Resolve the child's wire + creds ONCE, up front, so (a) the runs row records
  // the ACTUAL provider instead of '' — the recording gap that made the hybrid
  // 404s show `provider=""` and hid which wire the child hit — and (b) the
  // AgentConfig below reuses the same result (no double resolution).
  const childProviderCfg = resolveSpawnChildProviderConfig({
    hybridSlot,
    routingMode: getActiveRoutingMode(),
    profile,
    parent: readParentProviderConfig(parentAgent),
    baseProvider,
    userConfig,
    resolveKey: (provider, apiBaseURL) => resolveProviderApiKey({ provider, apiBaseURL, secretStore: parentAgent.secretStore, userConfig }),
  });
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
        provider: childProviderCfg.provider,
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
    // DK.1: inherit the durable-memory flag so a sub-agent on an ON tenant also stands down
    // the legacy end-of-turn extraction (the child shares the parent's Memory; without this it
    // would keep extracting into the minting channel the substrate decouples from).
    durableMemoryEnabled: parentAgent.durableMemoryEnabled,
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
    // Child wire + creds, resolved from the child's OWN tier (never the parent's
    // runtime slot in hybrid — the v2.1.1 silent-fast-spawn 404). Resolved once
    // above so the runs row records the same provider. Rationale in
    // `resolveSpawnChildProviderConfig`.
    ...childProviderCfg,
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
    // onto the child and the child's downstream code (memory writes, tool-call
    // recording) can attribute work to this run.
    currentRunId: childRunId,
    // Inherit the parent's tool-call sink. Together with `currentRunId` above,
    // this is what finally puts a child's calls on the CHILD's row: the sink
    // books whatever run id the caller hands it, and the child hands its own.
    //
    // Inheriting rather than building a fresh sink is deliberate — the parent's
    // closure holds the Session's RunHistory and per-run sequence counters, and
    // it is also the thing that keeps counting these calls toward the
    // http_request and mail rate limits. A child with no sink would run its
    // fan-out unmetered.
    recordToolCall: parentAgent.recordToolCall,
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

    // DK.1 F5/S8: a child spawned from a tainted parent inherits the taint for durable writes.
    // A prompt-injected parent's `spec.task`/`context` can carry an injected `remember(pin:true)`;
    // the child shares the parent's KnowledgeStore but starts with a clean per-run latch, so
    // without this an injected write would launder to active+pinned through the child. Arm the
    // child's STICKY conversation latch (survives its send() per-run reset, unlike sawUntrustedData)
    // so any such write routes to pending_review. Over-taints in the safe direction only.
    // Propagate the parent's CAUSE, not a blanket marker. `noteUntrustedData()` arms the
    // run-scoped marker as well as the sticky latch — which claims "this run handled wrapped
    // external content" for a child that merely inherited a conversation's history. The gate
    // is identical either way (both OR into `deriveTurnUntrusted`), but the marker is also
    // what gets REPORTED: the review chip names the cause, so a wrong one tells the operator
    // this turn read something external when nothing did. `agent.ts` says as much where it
    // introduces `restoreConversationTaint` for exactly this distinction.
    const parentCause = describeTurnUntrusted(parentAgent);
    if (parentCause === 'conversation') {
      childAgent.restoreConversationTaint?.();
    } else if (parentCause !== 'none') {
      childAgent.noteUntrustedData();
    }

    // Same per-turn time anchor as top-level chat / pipeline steps.
    const result = await childAgent.send(withCurrentTimePrefix(task, childAgent.userTimezone));

    // Wave 1.2 replay (b): a spawned child shares the parent's Memory by default
    // (`memory` above resolves to `parentAgent.memory` unless `isolated_memory`). If the
    // child read untrusted content, the SHARED Memory is now tainted for the parent too —
    // propagate the flag so the parent's own end-of-run extraction abstains. Without this
    // the child's untrusted read is a fail-open hole in the parent's memory. Derive from the
    // FULL union, not the bare marker — a child that read external content via a non-wrapping
    // tool (web_research/mail/read_file) must taint the parent too, symmetric with the
    // parent→child seed above. No-op when the child ran with isolated memory (`memory === undefined`).
    if (memory !== undefined) {
      // Same distinction on the way back: a child tainted only by the inherited conversation
      // must not hand the parent a marker it never earned.
      const childCause = describeTurnUntrusted(childAgent);
      if (childCause === 'conversation') {
        // `restoreConversationTaint` is OPTIONAL on IAgent, and an implementation
        // that omits it would lose the child→parent hand-off SILENTLY — no error,
        // just a turn that looks clean and is not (pipeline.ts already calls
        // `noteUntrustedData` optionally, so partial IAgent implementations have
        // precedent). Fall back to the coarser signal: over-tainting the parent's
        // run marker is the safe direction; losing the taint is not.
        if (parentAgent.restoreConversationTaint) parentAgent.restoreConversationTaint();
        else parentAgent.noteUntrustedData?.();
      } else if (childCause !== 'none') {
        parentAgent.noteUntrustedData?.();
      }
    }

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
          // Record the FULL structured error so a failed sub-agent is diagnosable
          // (not just status=failed + a null error_text). Skipped for an abort —
          // an intentional interruption isn't an error to store.
          errorText: childAborted ? undefined : formatSpawnError(err),
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
    // One place for all three exits. The success and failure branches above
    // each read the same snapshot for their own bookkeeping; reporting it here
    // means an abort — which takes neither branch's `return` — is still counted.
    onSettled?.(childAgent?.getCostSnapshot()?.estimatedCostUSD ?? 0);
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
    const provider = getActiveProvider();

    // Identifies THIS batch for the whole run. Two `spawn_agent` calls can be in
    // flight at once (the agent loop runs up to `MAX_PARALLEL_TOOL_CALLS` tools
    // concurrently), and every later event — progress, child-done, and each
    // child's forwarded tool activity — carries it so a consumer can tell the
    // batches apart instead of collapsing them into one.
    const spawnId = randomUUID();

    // One pass, two outputs from ONE resolution: the budget reservation and the
    // batch description the UI renders. Estimating against the model the child
    // will actually run on (gate + clamp + provider + hybrid slot) is what keeps
    // a Mistral tenant or a ceiling-clamped spawn from mis-reserving, and it is
    // the same reason the UI may not name a different model than the one the
    // ceiling was charged for.
    const subAgents: SpawnedSubAgent[] = [];
    let totalEstimate = 0;
    // Refuse BEFORE announcing, not after. `executeThinker` used to own these
    // checks, and it runs after the `spawn` event is already on the wire — so a
    // ceiling-exceeding or blocked profile was announced with its model id and
    // only then refused. A whole batch is refused if any one spec is: the reserve
    // + announce step is atomic, and half-announcing is worse than not starting.
    input.agents.forEach((spec) => { assertSpawnRoutingPermitted(spec, cfg); });
    input.agents.forEach((spec, i) => {
      const { model } = resolveSpawnChildRouting({
        spec,
        role: spec.role ? getRole(spec.role) : undefined,
        profile: spec.profile ? cfg.model_profiles?.[spec.profile] : undefined,
        userConfig: cfg,
        baseProvider: provider,
      });
      const iters = spec.max_turns ?? DEFAULT_SPAWN_MAX_TURNS;
      totalEstimate += estimateSpawnCost(model, iters);
      // The SAME check the identity block and the result header use. This site
      // had its own charset — one that stripped `/` and cut at 64 — so a
      // Fireworks child was announced to the UI as
      // `accountsfireworksmodelsglm-5p2`. An id it rejects is omitted rather
      // than sent empty: the field is optional, and absent reads as "unknown"
      // where `''` renders as a model with no name.
      const wireModel = safeModelId(model);
      subAgents.push({
        id: `${spawnId}:${i}`,
        name: spec.name,
        role: spec.role,
        ...(wireModel ? { model: wireModel } : {}),
      });
    });

    // Enforce session cost ceiling (shared with pipeline steps) against
    // this Session's counters object so concurrent spawns on different
    // Sessions don't see each other's reservations.
    checkSessionBudget(agent.sessionCounters, totalEstimate);

    channels.spawnStart.publish({ agents: names, parent: agent.name, parentRunId, depth: childDepth });

    if (agent.onStream) {
      await agent.onStream({ type: 'spawn', spawnId, subAgents, estimatedCostUSD: totalEstimate, agent: agent.name });
      // Hand the activity label over from "delegating" to "waiting". Dispatch is
      // over by this line; everything after it is the parent BLOCKED on
      // `Promise.allSettled` below. Without this the status sits on "Delegating
      // to sub-agents…" for the entire child run — measured at 212s on a real
      // deep review, describing a step that took about a second. `api_setup`
      // already uses this same tool_progress channel for a 5-8s gap; the
      // minutes-long one had no phase at all.
      await agent.onStream({ type: 'tool_progress', tool: 'spawn_agent', phase: 'waiting', agent: agent.name });
    }

    // Sub-agent progress state — visible to the UI via forwarded events.
    // Without this, parent's stream only sees spawn start + aggregated result
    // and the UI sits on "Arbeitet…" for minutes with no evidence of progress.
    // Keyed by SpawnedSubAgent.id, never by name: two children in one batch may
    // legitimately share a name, and a name-keyed map would silently merge them.
    const running = new Set(subAgents.map(s => s.id));
    const lastToolBySub: Record<string, string> = {};
    // Actual spend per child, filled in as each one stops. Reported on
    // `spawn_child_done` so a delegation's cost is visible where it was
    // incurred, instead of only inside the turn's single aggregate total.
    const costBySub: Record<string, number> = {};
    const spawnStart = Date.now();

    const parentStream = agent.onStream;
    const makeChildStream = (sub: SpawnedSubAgent): StreamHandler | null => {
      if (!parentStream) return null;
      return (event) => {
        // Forward only high-signal, low-frequency events. Text and thinking
        // token streams from children would flood the parent UI.
        if (event.type === 'tool_call') {
          lastToolBySub[sub.id] = event.name;
          return parentStream({ ...event, subAgent: sub.name, subAgentId: sub.id });
        }
        if (event.type === 'tool_result') {
          return parentStream({ ...event, subAgent: sub.name, subAgentId: sub.id });
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
          spawnId,
          elapsedS,
          running: [...running],
          lastToolBySub: { ...lastToolBySub },
          agent: agent.name,
        });
      }, 5000);
    }

    const results = await Promise.allSettled(
      input.agents.map((spec, i) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), SPAWN_TIMEOUT);
        const childStart = Date.now();
        const sub = subAgents[i]!;

        return executeThinker(spec, agent, makeChildStream(sub), childDepth, (usd) => { costBySub[sub.id] = usd; })
          .then(
            (value) => {
              running.delete(sub.id);
              if (parentStream) {
                void parentStream({
                  type: 'spawn_child_done',
                  spawnId,
                  subAgent: sub.name,
                  subAgentId: sub.id,
                  ok: true,
                  elapsedS: Math.floor((Date.now() - childStart) / 1000),
                  costUsd: costBySub[sub.id] ?? 0,
                  agent: agent.name,
                });
              }
              return value;
            },
            (err: unknown) => {
              running.delete(sub.id);
              if (parentStream) {
                void parentStream({
                  type: 'spawn_child_done',
                  spawnId,
                  subAgent: sub.name,
                  subAgentId: sub.id,
                  ok: false,
                  elapsedS: Math.floor((Date.now() - childStart) / 1000),
                  costUsd: costBySub[sub.id] ?? 0,
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
        // in the header OUTSIDE the untrusted-data envelope, hence the SAME
        // check the identity block uses: a second charset here meant a Fireworks
        // child was reported as `accountsfireworksmodelsglm-5p2` — mangled, and
        // stated with authority because the prompt vouches for it.
        // It rejects rather than repairs, so drop the clause when it rejects:
        // an empty code span in a heading claims a model with no name.
        const safeModel = safeModelId(outcome.value.model);
        const ranOn = safeModel ? ` (ran on \`${safeModel}\`)` : '';
        sections.push(`## ${spec.name}${ranOn}\n\n${wrapped}`);
        childRunIds.push(outcome.value.childRunId);
      } else {
        const err = outcome.reason instanceof Error
          ? outcome.reason
          : new Error(String(outcome.reason));
        errors.push(err);
        // Mark the section as a FAILURE unambiguously so the parent can't mistake
        // a dead sub-agent for one that returned nothing useful — a silent
        // sub-agent failure is more dangerous than a loud one. `formatSpawnError`
        // adds the HTTP status (e.g. `[404] …`) so a provider mis-route reads as
        // a config failure, not a vague error.
        sections.push(`## ${spec.name} — FAILED\n\n**Error:** ${formatSpawnError(err)}`);
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
