// === Inbox classifier — Mistral EU LLM caller ===
//
// Direct REST adapter for Mistral's chat-completions endpoint, used as
// the EU-resident classifier provider. Hits api.mistral.ai/v1 in
// Frankfurt; no third-party SDK, no AnthropicLike shim — the OpenAI
// adapter in core/openai-adapter.ts only implements `beta.messages.stream`,
// while the inbox classifier issues a single non-streaming
// `messages.create`. A small fetch wrapper is the minimal contract
// difference.
//
// EU-residency policy is enforced at the engine wiring layer: when
// LYNOX_INBOX_LLM_REGION=eu (or a managed-tier check) the engine
// constructs this caller instead of the default Haiku/Anthropic one.

import type { LLMCaller } from './index.js';

/** Default model — Mistral Small is the price/quality fit for classification. */
export const DEFAULT_MISTRAL_MODEL = 'mistral-small-latest';
export const DEFAULT_MISTRAL_BASE_URL = 'https://api.mistral.ai/v1';
export const DEFAULT_MAX_TOKENS = 256;

export interface MistralEuOptions {
  apiKey: string;
  /** Override the model. Defaults to mistral-small-latest. */
  modelId?: string | undefined;
  /** Override base URL (e.g. for a private EU proxy). */
  baseURL?: string | undefined;
  maxTokens?: number | undefined;
  /** Fires after a successful call with the SDK-reported usage. */
  onUsage?: ((usage: { inputTokens: number; outputTokens: number }) => void) | undefined;
  /** Override the global fetch — used by tests to stub the network. */
  fetchImpl?: typeof fetch | undefined;
}

interface MistralChoice {
  message: { content?: string | undefined };
}

interface MistralResponse {
  choices: ReadonlyArray<MistralChoice>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | undefined;
}

/**
 * Build an `LLMCaller` that talks to Mistral. The classifier emits a
 * strict-JSON instruction in its prompt; we additionally request
 * `response_format: {type: 'json_object'}` so Mistral guards the output.
 */
export function createMistralEuLLMCaller(opts: MistralEuOptions): LLMCaller {
  if (!opts.apiKey) {
    throw new Error('createMistralEuLLMCaller: apiKey is required');
  }
  const modelId = opts.modelId ?? DEFAULT_MISTRAL_MODEL;
  const baseURL = (opts.baseURL ?? DEFAULT_MISTRAL_BASE_URL).replace(/\/+$/, '');
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const onUsage = opts.onUsage;
  const apiKey = opts.apiKey;

  return async ({ system, user, signal }) => {
    const body = {
      model: modelId,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    };
    if (signal) init.signal = signal;
    const resp = await fetchImpl(`${baseURL}/chat/completions`, init);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      // Truncate to avoid leaking prompt content via verbose Mistral errors.
      const snippet = text.slice(0, 200);
      throw new Error(`Mistral ${String(resp.status)}: ${snippet || resp.statusText}`);
    }
    const json = (await resp.json()) as MistralResponse;
    if (onUsage && json.usage) {
      onUsage({
        inputTokens: json.usage.prompt_tokens ?? 0,
        outputTokens: json.usage.completion_tokens ?? 0,
      });
    }
    const parts: string[] = [];
    for (const choice of json.choices) {
      if (typeof choice.message.content === 'string') parts.push(choice.message.content);
    }
    return parts.join('');
  };
}
