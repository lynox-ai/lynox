/**
 * Which catalog presets the reachability suite covers, outside the `.test.ts` file so the
 * offline coverage check (tests/online-guards.test.ts) can import it without registering
 * the online suite.
 */
import { LLM_CATALOG } from '../../src/core/llm/catalog.js';

/** Env var carrying the key for each remote preset, and its default test model. */
export const REMOTE_PRESETS: Record<string, { keyEnv: string; defaultModel: string }> = {
  groq:      { keyEnv: 'GROQ_API_KEY',      defaultModel: 'llama-3.3-70b-versatile' },
  together:  { keyEnv: 'TOGETHER_API_KEY',  defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  fireworks: { keyEnv: 'FIREWORKS_API_KEY', defaultModel: 'accounts/fireworks/models/gpt-oss-120b' },
};

/** Default test model per loopback runtime. Each must be tool-capable. */
export const LOOPBACK_DEFAULT_MODEL: Record<string, string> = {
  ollama:   'qwen2.5:7b',
  lmstudio: 'qwen2.5-7b-instruct',
  vllm:     'Qwen/Qwen2.5-7B-Instruct',
  localai:  'qwen2.5-7b-instruct',
};

/**
 * Every catalog entry that pins an endpoint and is not a native provider — i.e.
 * exactly the presets whose tool-calling is unproven. Derived from the catalog
 * rather than hand-listed, so a new preset cannot be added without this suite
 * noticing it.
 */
export const PRESETS_UNDER_TEST = LLM_CATALOG.filter(
  (e) => e.base_url_default !== undefined && e.verification !== 'native',
);
