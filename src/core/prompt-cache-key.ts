import { getProviderDescriptor, type ProviderKey } from '../types/index.js';

/**
 * Stable prompt-cache key for OpenAI-compatible prefix caching (Mistral). The
 * key partitions the provider's cache by conversation, so the same thread's
 * tool + system + history prefix is reused across turns. Per-thread, plus the
 * agent name to separate a thread's sub-agents; falls back to the agent name
 * when there is no thread. The OpenAIAdapter salts it per-tenant before
 * forwarding (see openai-adapter.ts).
 */
export function buildPromptCacheKey(threadId: string | undefined, agentName: string): string {
  return threadId ? `${threadId}:${agentName}` : agentName;
}

/**
 * Whether to send a `prompt_cache_key` for this provider. ONLY the providers on
 * the OpenAI-compatible wire (whose client is the OpenAIAdapter that salts,
 * host-gates, and forwards the key) may receive it. Critically NOT `custom`:
 * despite being a "custom proxy", it is Anthropic-wire (a real Anthropic SDK
 * client), which would forward this unknown key verbatim to a non-OpenAI
 * endpoint that rejects unknown params. Registry-grounded so it tracks the same
 * wire dispatch that built the client.
 */
export function shouldSendPromptCacheKey(provider: ProviderKey): boolean {
  return getProviderDescriptor(provider)?.wireClient === 'openai';
}
