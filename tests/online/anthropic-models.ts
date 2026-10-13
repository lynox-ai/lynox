/**
 * The model ids the engine prices for the direct Anthropic API, plus one id Anthropic
 * retired. Outside the `.test.ts` file so the offline check (tests/online-guards.test.ts)
 * can import it without registering the online suite.
 */
import { MODEL_CAPABILITIES } from '../../src/types/models.js';

export const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';

/**
 * Retired by Anthropic; a one-token message answered `404 not_found_error` on 2026-10-13.
 * The online guard calls it as its positive control, so a probe that cannot tell "not
 * served" from "served" fails there instead of passing every id.
 */
export const RETIRED_ANTHROPIC_ID = 'claude-3-5-sonnet-20241022';

/**
 * Every direct-API Anthropic id in `MODEL_CAPABILITIES`: today's tier models, the opt-ins
 * and the candidates for the next switch. The `[1m]` entries are left out: that spelling
 * is lynox's name for a context-window variant, not a model id the API takes (it answers
 * 404 for it, measured 2026-10-13). Their base ids are in the list.
 */
export function anthropicDirectIds(): string[] {
  return Object.values(MODEL_CAPABILITIES)
    .filter(c => c.provider === 'anthropic' && !c.id.includes('['))
    .map(c => c.id);
}

/** Status and body of a one-token message: 200 means Anthropic serves the model. */
export async function messageStatus(modelId: string, key: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${ANTHROPIC_BASE}/messages`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }),
  });
  return { status: res.status, body: await res.text() };
}
