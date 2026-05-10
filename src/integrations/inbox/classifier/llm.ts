// === Inbox classifier — default LLM wiring ===
//
// Pure adapter: turns an Anthropic-shaped client into the `LLMCaller`
// signature the classifier consumes. Two factories:
//
//   - wrapAnthropicAsLLMCaller(client, modelId): pure, testable with stubs
//   - createHaikuLLMCaller(opts): convenience that builds a real client via
//     `core/llm-client.ts` and the project's `getModelId('haiku')` mapping
//
// The classifier itself stays decoupled from the SDK — tests inject the
// caller directly (see classifier/index.test.ts).

import type Anthropic from '@anthropic-ai/sdk';
import { createLLMClient, type LLMClientOptions } from '../../../core/llm-client.js';
import { getModelId } from '../../../types/index.js';
import type { LLMProvider } from '../../../types/index.js';
import type { LLMCaller } from './index.js';

/**
 * Default response cap. The classifier emits a short JSON object (~120
 * tokens including the German `one_line_why_de`); 256 is conservative
 * headroom and keeps cost predictable.
 */
export const DEFAULT_MAX_TOKENS = 256;

/**
 * Minimal slice of the Anthropic client we depend on. Keeping this narrow
 * lets us test the wrapper with a hand-rolled stub instead of pulling the
 * full SDK type surface into tests.
 */
export interface AnthropicLike {
  messages: {
    create(
      params: {
        model: string;
        max_tokens: number;
        system: string;
        messages: ReadonlyArray<{ role: 'user'; content: string }>;
      },
      requestOptions?: { signal?: AbortSignal | undefined } | undefined,
    ): Promise<{
      content: ReadonlyArray<{ type: string; text?: string | undefined }>;
      /** SDK reports per-call token usage. Used by InboxCostBudget at wiring time. */
      usage?: { input_tokens?: number | undefined; output_tokens?: number | undefined } | undefined;
    }>;
  };
}

export interface WrapOptions {
  maxTokens?: number | undefined;
  /**
   * Fires after each successful classify call with the SDK-reported usage.
   * Engine wiring uses this to feed `InboxCostBudget.recordUsage(...)`.
   * Failures (thrown errors) do not invoke the callback.
   */
  onUsage?: ((usage: { inputTokens: number; outputTokens: number }) => void) | undefined;
}

/**
 * Adapt an Anthropic-shaped client into the classifier's `LLMCaller`
 * contract. Joins all returned text blocks into a single string — the
 * model is instructed to emit bare JSON, but Haiku occasionally emits
 * additional whitespace blocks the schema parser silently tolerates.
 */
export function wrapAnthropicAsLLMCaller(
  client: AnthropicLike,
  modelId: string,
  options: WrapOptions = {},
): LLMCaller {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const onUsage = options.onUsage;
  return async ({ system, user, signal }) => {
    const resp = await client.messages.create(
      {
        model: modelId,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      },
      { signal },
    );
    const parts: string[] = [];
    for (const block of resp.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    if (onUsage && resp.usage) {
      onUsage({
        inputTokens: resp.usage.input_tokens ?? 0,
        outputTokens: resp.usage.output_tokens ?? 0,
      });
    }
    return parts.join('');
  };
}

export interface HaikuCallerOptions extends LLMClientOptions, WrapOptions {
  /** Override the resolved model id (for canary / pinning). */
  modelId?: string | undefined;
}

/**
 * Build a production `LLMCaller` that talks to Haiku via the project's
 * configured provider (Anthropic / Vertex / OpenAI-compatible). Use this
 * from the queue wiring at startup; tests should keep injecting their own
 * caller via `classifyMail(input, fakeLLM)`.
 */
export function createHaikuLLMCaller(opts: HaikuCallerOptions = {}): LLMCaller {
  const provider: LLMProvider = opts.provider ?? 'anthropic';
  const client = createLLMClient(opts) as unknown as Anthropic;
  const modelId = opts.modelId ?? getModelId('haiku', provider);
  const wrapOpts: WrapOptions = {};
  if (opts.maxTokens !== undefined) wrapOpts.maxTokens = opts.maxTokens;
  if (opts.onUsage !== undefined) wrapOpts.onUsage = opts.onUsage;
  return wrapAnthropicAsLLMCaller(client as unknown as AnthropicLike, modelId, wrapOpts);
}
