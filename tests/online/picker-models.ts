/**
 * The model ids the settings picker offers per tier (`tier_models`), plus the ids the
 * provider withdrew. Outside the `.test.ts` file so the offline check
 * (tests/online-guards.test.ts) can import it without registering the online suite.
 */
import { LLM_CATALOG } from '../../src/core/llm/catalog.js';

/**
 * Withdrawn by Fireworks, measured 2026-10-12: a one-token completion answered
 * `404 Model not found, inaccessible, and/or not deployed` for each. They left the
 * picker; the online guard calls them as its positive control, so a probe that
 * cannot tell "not served" from "served" fails there instead of passing everything.
 */
export const WITHDRAWN_FIREWORKS_IDS: readonly string[] = [
  'accounts/fireworks/models/glm-5p2',
  'accounts/fireworks/models/deepseek-v4-pro',
  'accounts/fireworks/models/deepseek-v4-flash-0731',
  'accounts/fireworks/models/qwen3p7-plus',
  'accounts/fireworks/models/kimi-k2p6',
  'accounts/fireworks/models/kimi-k2p7-code',
];

/** Every (endpoint, model) the picker offers through a catalog entry's `tier_models`. */
export function pickerModels(): Array<{ modelId: string; baseUrl: string; entry: string }> {
  return LLM_CATALOG.flatMap(e =>
    (e.tier_models ?? []).map(m => ({ modelId: m.id, baseUrl: e.base_url_default ?? '', entry: e.display_name })));
}

/** HTTP status of a one-token completion: 200 means the provider serves the model. */
export async function completionStatus(baseUrl: string, modelId: string, key: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }),
  });
  return { status: res.status, body: await res.text() };
}
