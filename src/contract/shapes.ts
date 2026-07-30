/**
 * Cross-repo wire-JSON value shapes — SINGLE SOURCE OF TRUTH.
 *
 * VENDORED DOWNSTREAM — edit ONLY here (`core/src/contract/`); the private
 * control plane compiles a byte-identical vendored copy (it generates the
 * `LYNOX_MODEL_PROFILES_JSON` env blob this shape describes; the engine parses
 * it). Changes here are WIRE-CONTRACT changes. Dependency-free by design.
 */

/** Named model profile for OpenAI-compatible providers (Mistral, Fireworks, …). */
export interface ModelProfile {
  /** Provider type — always 'openai' (OpenAI-compatible API). */
  provider: 'openai';
  /** API base URL (e.g. 'https://api.mistral.ai/v1'). */
  api_base_url: string;
  /** API key for this provider. Ignored if `auth: 'google-vertex'` (OAuth token generated from service account). */
  api_key: string;
  /** Authentication mode. 'static' (default) uses api_key as-is. 'google-vertex' generates OAuth tokens from GOOGLE_APPLICATION_CREDENTIALS. */
  auth?: 'static' | 'google-vertex' | undefined;
  /** Model ID to send in requests (e.g. 'mistral-large-2512'). */
  model_id: string;
  /** Context window size in tokens. Default: 200000. */
  context_window?: number | undefined;
  /** Max output tokens. Default: 16000. */
  max_tokens?: number | undefined;
  /** Max continuation attempts. Default: 5. */
  max_continuations?: number | undefined;
}

/**
 * Runtime guard for a {@link ModelProfile}. Checks only the REQUIRED fields the
 * downstream LLM client dereferences (`provider`, `api_base_url`, `api_key`,
 * `model_id`) — optional fields are left to their defaults. Used at every
 * untrusted boundary that ingests a profile (the `LYNOX_MODEL_PROFILES_JSON`
 * env blob, spawn `profile` inputs) so a malformed entry is dropped rather than
 * reaching the openai-adapter as `Bearer undefined` and crashing the run.
 */
export function isModelProfile(value: unknown): value is ModelProfile {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v['provider'] === 'openai' &&
    typeof v['api_base_url'] === 'string' &&
    typeof v['api_key'] === 'string' &&
    typeof v['model_id'] === 'string'
  );
}
