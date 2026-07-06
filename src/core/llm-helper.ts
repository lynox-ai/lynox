/**
 * Tool-callable LLM invocation with strict JSON-schema validation, budget cap,
 * and pre-flight token estimate.
 *
 * Used by tools that need to extract structured data from prose (the canonical
 * case is `api_setup bootstrap` parsing a docs page into an ApiProfile draft).
 *
 * Single-shot only — no streaming, no multi-turn. If you need either of those,
 * use the Agent class directly.
 *
 * Pattern: a fake `extract` tool is forced via `tool_choice`. The model returns
 * a tool_use block whose `input` is the structured data. Anthropic's input_schema
 * pushes the model toward the requested shape but doesn't server-enforce enum or
 * required constraints, so this helper post-validates structurally.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { createLLMClient } from './llm-client.js';
import { MODEL_MAP, modelCapability } from '../types/models.js';
import type { IAgent, ProviderConfigSnapshot } from '../types/index.js';

/** Minimal JSON-schema subset accepted by the extractor. */
export interface ExtractSchema {
  type: 'object';
  properties: Record<string, ExtractSchemaProperty>;
  required?: string[];
}

export type ExtractSchemaProperty =
  | { type: 'string'; enum?: readonly string[]; pattern?: string }
  | { type: 'number'; minimum?: number; maximum?: number }
  | { type: 'integer'; minimum?: number; maximum?: number }
  | { type: 'boolean' }
  | { type: 'array'; items: ExtractSchemaProperty; maxItems?: number }
  | { type: 'object'; properties: Record<string, ExtractSchemaProperty>; required?: string[] };

export interface CallForStructuredJsonOptions {
  /** System prompt — describes the extractor's role. */
  system: string;
  /** User prompt — typically the source text the model should extract from. */
  user: string;
  /** JSON-schema-subset describing the expected output shape. */
  schema: ExtractSchema;
  /** Hard cap on input tokens (pre-flight estimate, char-based). Default 100_000. */
  maxInputTokens?: number;
  /** Hard cap on total USD per call (pre-flight estimate). Default 0.50. */
  budgetUsd?: number;
  /** Model id. When omitted, resolved provider-aware: for `openai` provider
   *  takes `agent.getProviderConfig().openaiModelId` (e.g. Mistral large);
   *  for Anthropic/Vertex/custom takes the Sonnet tier from `MODEL_MAP`.
   *  Overridable via `LYNOX_LLM_HELPER_MODEL` env var (the public-demo
   *  container sets this to a Haiku id to keep the daily cost-cap healthy). */
  model?: string;
  /**
   * Anthropic client. If omitted, a fresh client is constructed via the active
   * provider in `llm-client.ts`. Pass an existing one to share connection pool
   * + auth (the Agent class already holds one).
   */
  client?: Anthropic;
  /**
   * Calling agent. When provided AND `client` is omitted, the helper resolves
   * provider + credentials from `agent.getProviderConfig()` so the call goes
   * through the same provider the user picked at runtime (Anthropic, Mistral
   * via openai-compat, Vertex, etc.). Without this, a Mistral user's
   * docs-bootstrap call previously hit `createLLMClient()` with no opts,
   * which either threw "OpenAI provider requires apiBaseURL" or silently
   * fell back to a stale module-global provider.
   *
   * The snapshot carries credentials — never log / serialise it.
   */
  agent?: IAgent;
  /** Max output tokens. Default 4000. */
  maxOutputTokens?: number;
}

export interface StructuredJsonResult<T> {
  data: T;
  /** Tokens charged by Anthropic for input (from response.usage). */
  inputTokens: number;
  /** Tokens charged by Anthropic for output (from response.usage). */
  outputTokens: number;
  /** Computed USD cost from the model-appropriate list pricing. */
  costUsd: number;
}

/**
 * List prices per 1M tokens for the models this helper can invoke. Reads
 * from the MODEL_CAPABILITIES registry (types/models.ts) — pre-2026-05-18
 * this helper carried its own divergent rate table that drifted from
 * pricing.ts (e.g. Haiku 0.80/4 here vs 1/5 in pricing.ts). Falls back to
 * the Sonnet rate (registry default) — fail-closed for the budget gate
 * since Sonnet is the engine-wide primary client.
 */
interface ModelPricing { input: number; output: number; }
const FALLBACK_MODEL_ID = 'claude-sonnet-4-6';

function pricingFor(model: string): ModelPricing {
  const cap = modelCapability(model) ?? modelCapability(FALLBACK_MODEL_ID);
  return { input: cap?.pricing.input ?? 3, output: cap?.pricing.output ?? 15 };
}

const DEFAULT_MAX_INPUT_TOKENS = 100_000;
/**
 * Default per-call budget cap. Sized for a Sonnet call on a ~70 K-token docs
 * page with the 4 K output cap: ~$0.27 actual, ~$0.40 worst-case. Set to
 * $0.50 so the gate doesn't false-positive on real-world API landing pages.
 */
const DEFAULT_BUDGET_USD = 0.50;
const DEFAULT_MAX_OUTPUT_TOKENS = 4_000;
/**
 * Default Anthropic-tier model. Sonnet matches the engine-wide primary client
 * (per the bench-verdict baseline) for Anthropic / Vertex / custom proxy.
 * Public-demo containers override this to Haiku via `LYNOX_LLM_HELPER_MODEL`
 * to fit the daily cost-cap of the anonymous sandbox — see
 * `pro/packages/deploy/demo/docker-compose.yml`.
 *
 * For `openai` provider (Mistral / Gemini / etc.) we never hardcode an
 * Anthropic id — see `resolveModel()`.
 */
const DEFAULT_ANTHROPIC_MODEL = process.env['LYNOX_LLM_HELPER_MODEL'] ?? MODEL_MAP.balanced;

/**
 * Resolve the model id to send in the API call. Provider-aware:
 *   - openai (Mistral/Gemini/etc.): use the configured `openaiModelId` so the
 *     request hits a model the OpenAI-compatible endpoint actually serves.
 *     `LYNOX_LLM_HELPER_MODEL` overrides this only when its value looks
 *     non-Anthropic (so the public-demo Haiku override doesn't accidentally
 *     route Mistral traffic to a claude id the endpoint will 404 on).
 *   - everything else: stick with the Sonnet default (or `LYNOX_LLM_HELPER_MODEL`).
 *
 * Returns `DEFAULT_ANTHROPIC_MODEL` when no provider info is available
 * (legacy callers passing a `client` directly), preserving prior behaviour.
 */
function resolveModel(provider: ProviderConfigSnapshot | undefined): string {
  if (provider?.provider === 'openai') {
    const envOverride = process.env['LYNOX_LLM_HELPER_MODEL'];
    // Only honour the env override if it's NOT a claude-* id — otherwise the
    // public-demo override would 404 against Mistral / Gemini endpoints.
    if (envOverride && !envOverride.startsWith('claude-')) return envOverride;
    if (provider.openaiModelId) return provider.openaiModelId;
  }
  return DEFAULT_ANTHROPIC_MODEL;
}

/** Rough char→token estimate. English ~3.5 chars/token; over-estimates for
 *  non-Latin scripts (safer for budget gates). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Estimate USD cost for the pre-flight gate.
 *
 * Output is hard-capped at `maxOutputTokens` by the actual API call, so the
 * estimate clamps the output projection to that ceiling. Without the clamp,
 * a 250 KB / 71 K-token input would project a 17.8 K-token output (25%) and
 * blow past a $0.05 budget at Haiku output prices — even though the actual
 * call would emit at most 4 K tokens (~$0.016). That false-positive cost
 * dominates the docs-bootstrap path for any real-world API landing page.
 *
 * Exported so the cost-clamp regression test can assert the math directly
 * (a behavioural-only test would still pass if the clamp were silently
 * widened, e.g. doubled to 8 K).
 */
export function estimateCostUsd(
  inputTokens: number,
  maxOutputTokens: number = DEFAULT_MAX_OUTPUT_TOKENS,
  model: string = DEFAULT_ANTHROPIC_MODEL,
): number {
  const estimatedOutput = Math.min(Math.ceil(inputTokens * 0.25), maxOutputTokens);
  const p = pricingFor(model);
  return (inputTokens * p.input + estimatedOutput * p.output) / 1_000_000;
}

/** Compute exact USD cost from Anthropic-reported usage. */
function computeCostUsd(inputTokens: number, outputTokens: number, model: string): number {
  const p = pricingFor(model);
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

/** Defensive cap on schema-recursion depth so a malformed schema with circular
 *  `properties` references can't infinite-loop the validator. */
const MAX_SCHEMA_DEPTH = 32;

/**
 * Validate parsed data structurally against the schema. Throws on mismatch
 * with a path-pointer error (`field.subfield`). Not a full JSON-Schema validator —
 * just the subset this helper supports.
 */
export function validateAgainstSchema(data: unknown, schema: ExtractSchema, path = '', depth = 0): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new Error(`Schema recursion depth exceeded ${String(MAX_SCHEMA_DEPTH)} at "${path || '<root>'}"`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`Expected object at "${path || '<root>'}", got ${data === null ? 'null' : typeof data}`);
  }
  const obj = data as Record<string, unknown>;
  if (schema.required) {
    for (const key of schema.required) {
      if (!(key in obj)) {
        throw new Error(`Missing required field "${path ? `${path}.${key}` : key}"`);
      }
    }
  }
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!(key in obj)) continue;
    validateProperty(obj[key], prop, path ? `${path}.${key}` : key, depth + 1);
  }
}

function validateProperty(value: unknown, prop: ExtractSchemaProperty, path: string, depth: number): void {
  switch (prop.type) {
    case 'string':
      if (typeof value !== 'string') throw new Error(`Expected string at "${path}", got ${typeof value}`);
      if (prop.enum && !prop.enum.includes(value)) {
        throw new Error(`Value "${value}" at "${path}" not in enum [${prop.enum.join(', ')}]`);
      }
      if (prop.pattern && !new RegExp(prop.pattern).test(value)) {
        throw new Error(`Value "${value}" at "${path}" does not match pattern /${prop.pattern}/`);
      }
      break;
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Expected ${prop.type} at "${path}", got ${typeof value}`);
      }
      if (prop.type === 'integer' && !Number.isInteger(value)) {
        throw new Error(`Expected integer at "${path}", got ${String(value)}`);
      }
      if (prop.minimum !== undefined && value < prop.minimum) {
        throw new Error(`Value ${String(value)} at "${path}" below minimum ${String(prop.minimum)}`);
      }
      if (prop.maximum !== undefined && value > prop.maximum) {
        throw new Error(`Value ${String(value)} at "${path}" above maximum ${String(prop.maximum)}`);
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error(`Expected boolean at "${path}", got ${typeof value}`);
      break;
    case 'array':
      if (!Array.isArray(value)) throw new Error(`Expected array at "${path}", got ${typeof value}`);
      if (prop.maxItems !== undefined && value.length > prop.maxItems) {
        throw new Error(`Array at "${path}" has ${String(value.length)} items, max ${String(prop.maxItems)}`);
      }
      value.forEach((item, i) => { validateProperty(item, prop.items, `${path}[${String(i)}]`, depth + 1); });
      break;
    case 'object':
      validateAgainstSchema(value, prop as unknown as ExtractSchema, path, depth);
      break;
  }
}

/**
 * Single Haiku call that returns structured JSON conforming to the given schema.
 *
 * Flow:
 *  1. Pre-flight: estimate input tokens + cost. Reject if over caps.
 *  2. Call `messages.create` with a forced `extract` tool.
 *  3. Read the tool_use block's input as the structured data.
 *  4. Validate structurally against the schema; throw if invalid.
 *  5. Return {data, inputTokens, outputTokens, costUsd} from actual usage.
 *
 * Errors:
 *  - Pre-flight rejection: throws BudgetError with the estimate.
 *  - Model emitted text-only (no tool call): throws with a clear message.
 *  - Model emitted tool_use but invalid JSON shape: throws via validateAgainstSchema.
 *  - Network / API errors: propagate from the SDK.
 */
export async function callForStructuredJson<T = unknown>(
  opts: CallForStructuredJsonOptions,
): Promise<StructuredJsonResult<T>> {
  // Defensive typeof-check tolerates legacy IAgent mocks without the
  // method (older test helpers); we fall through to the legacy module-
  // global provider in that case — same path PR #568 took for spawn.ts.
  const providerSnapshot: ProviderConfigSnapshot | undefined = opts.agent
    && typeof (opts.agent as { getProviderConfig?: unknown }).getProviderConfig === 'function'
    ? opts.agent.getProviderConfig()
    : undefined;

  const {
    system,
    user,
    schema,
    maxInputTokens = DEFAULT_MAX_INPUT_TOKENS,
    budgetUsd = DEFAULT_BUDGET_USD,
    model = resolveModel(providerSnapshot),
    maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
  } = opts;

  // Pre-flight: cost + token check on combined system + user content.
  const inputEstimate = estimateTokens(system) + estimateTokens(user);
  if (inputEstimate > maxInputTokens) {
    throw new BudgetError(
      `Input estimate ${String(inputEstimate)} tokens exceeds maxInputTokens=${String(maxInputTokens)}`,
      { estimatedInputTokens: inputEstimate, estimatedCostUsd: estimateCostUsd(inputEstimate, maxOutputTokens, model) },
    );
  }
  const costEstimate = estimateCostUsd(inputEstimate, maxOutputTokens, model);
  if (costEstimate > budgetUsd) {
    throw new BudgetError(
      `Estimated cost $${costEstimate.toFixed(4)} exceeds budgetUsd=$${budgetUsd.toFixed(4)}`,
      { estimatedInputTokens: inputEstimate, estimatedCostUsd: costEstimate },
    );
  }

  // Construct a provider-aware client so a Mistral user's call doesn't fall
  // back to a stale module-global ANTHROPIC_API_KEY. When `client` is supplied
  // explicitly (test seam, Agent re-using its own connection), we trust the
  // caller. When `agent` is supplied, mirror its provider snapshot into the
  // factory so the SDK construction matches the engine's primary client.
  const client = opts.client ?? createLLMClient(
    providerSnapshot
      ? {
          provider: providerSnapshot.provider,
          apiKey: providerSnapshot.apiKey,
          apiBaseURL: providerSnapshot.apiBaseURL,
          openaiModelId: providerSnapshot.openaiModelId,
          openaiAuth: providerSnapshot.openaiAuth,
        }
      : {},
  );
  const response = await client.messages.create({
    model,
    max_tokens: maxOutputTokens,
    // Explicit thinking-OFF for the forced-tool extraction. Omitting `thinking`
    // means thinking-off on Sonnet 4.6, but on Sonnet 5 the silent default is
    // adaptive-ON — which would spend reasoning tokens inside this call's small
    // 4K `max_tokens` cap (truncation risk) and bill extra output on every
    // extraction. Explicit `disabled` is accepted on Sonnet 5 (only Fable 5
    // rejects it, and this path is never Fable). Cheap deterministic extraction
    // wants no thinking regardless of the model.
    thinking: { type: 'disabled' },
    system,
    messages: [{ role: 'user', content: user }],
    tools: [{
      name: 'extract',
      description: 'Return the extracted structured data exactly conforming to the requested schema.',
      input_schema: schema as unknown as Anthropic.Tool.InputSchema,
    }],
    tool_choice: { type: 'tool', name: 'extract' },
  });

  const toolUseBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'extract',
  );
  if (!toolUseBlock) {
    throw new Error(
      `Model did not call the extract tool. Got content types: [${response.content.map(b => b.type).join(', ')}]`,
    );
  }

  validateAgainstSchema(toolUseBlock.input, schema);

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  return {
    data: toolUseBlock.input as T,
    inputTokens,
    outputTokens,
    costUsd: computeCostUsd(inputTokens, outputTokens, model),
  };
}

/**
 * Thrown when the pre-flight estimate exceeds either the input-token cap or
 * the budget cap. Caller can catch and decide whether to truncate the input
 * or surface a clear error to the agent.
 */
export class BudgetError extends Error {
  readonly estimatedInputTokens: number;
  readonly estimatedCostUsd: number;
  constructor(message: string, ctx: { estimatedInputTokens: number; estimatedCostUsd: number }) {
    super(message);
    this.name = 'BudgetError';
    this.estimatedInputTokens = ctx.estimatedInputTokens;
    this.estimatedCostUsd = ctx.estimatedCostUsd;
  }
}
