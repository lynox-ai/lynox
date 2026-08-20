/**
 * Online guard: every model a TIER_PRESET pins must still be SERVED.
 *
 * ## Why this file exists, and why the neighbouring guard could not do it
 *
 * On 2026-08-14 Fireworks retired the unsuffixed alias
 * `accounts/fireworks/models/deepseek-v4-flash` in favour of a dated snapshot.
 * Both shipped presets pinned the bare id in their FAST slot, so from 09:44 that
 * morning every fast-tier call on every instance running a preset failed with
 * `404 Model not found, inaccessible, and/or not deployed` — compaction
 * (session.ts DEFAULT_COMPACTION_MODEL), memory + knowledge extraction, follow-up
 * generation, and every workflow step that declares no model
 * (UNDECLARED_STEP_TIER). It ran for four days: one scheduled job failed at the
 * same minute each day and nobody was told.
 *
 * `provider-preset-reachability.test.ts` exists for this class and could not
 * catch it, by construction: its cases "self-skip unless the endpoint is
 * reachable AND serving the model". A model disappearing is exactly the state
 * that makes it skip — the condition that should fail it silences it instead.
 *
 * So this file inverts the skip rule, and that inversion is the whole point:
 *
 *   - no credential  → SKIP. We genuinely cannot test, and saying nothing is honest.
 *   - credential set, model 404s → **FAIL**. We tested, and the promise is broken.
 *
 * It asserts reachability only — a 200 from a one-token completion. Whether the
 * model is any GOOD is a different question with different instruments (the
 * fitness harness, the fast-slot bench). This one answers "is it there", which is
 * the question four days of silence turned out to hinge on.
 */

import { describe, it, expect } from 'vitest';
import { TIER_PRESETS } from '../../src/core/tier-presets.js';
import type { TierSlot } from '../../src/types/index.js';

const FIREWORKS_KEY = process.env['FIREWORKS_API_KEY'];

/** Every distinct (endpoint, model) a preset pins, with the presets that pin it. */
function pinnedSlots(): Array<{ modelId: string; baseUrl: string; presets: string[] }> {
  const byKey = new Map<string, { modelId: string; baseUrl: string; presets: Set<string> }>();
  for (const [presetName, preset] of Object.entries(TIER_PRESETS)) {
    for (const slot of Object.values(preset.tier_set) as Array<TierSlot | undefined>) {
      if (!slot?.model_id || !slot.api_base_url) continue;
      const key = `${slot.api_base_url}::${slot.model_id}`;
      const entry = byKey.get(key) ?? { modelId: slot.model_id, baseUrl: slot.api_base_url, presets: new Set<string>() };
      entry.presets.add(presetName);
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].map(e => ({ modelId: e.modelId, baseUrl: e.baseUrl, presets: [...e.presets].sort() }));
}

const FIREWORKS_HOST = 'api.fireworks.ai';
const slots = pinnedSlots();
const fireworksSlots = slots.filter(s => s.baseUrl.includes(FIREWORKS_HOST));

// Not `describe.skip` on an empty list: zero pinned slots would mean the presets
// stopped pinning anything, which is itself worth failing on.
describe('preset slots are served by their provider', () => {
  it('the presets pin at least one Fireworks-hosted slot', () => {
    expect(fireworksSlots.length).toBeGreaterThan(0);
  });

  const runFireworks = FIREWORKS_KEY ? describe : describe.skip;

  runFireworks('Fireworks', () => {
    for (const slot of fireworksSlots) {
      it(`serves ${slot.modelId} (pinned by: ${slot.presets.join(', ')})`, async () => {
        const res = await fetch(`${slot.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${FIREWORKS_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: slot.modelId, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }),
        });
        const body = await res.text();
        // The message names the preset AND the id, because the fix is always
        // "the provider renamed it" and the reader needs both to act.
        expect(res.status, `${slot.modelId} is pinned by preset(s) ${slot.presets.join(', ')} but the provider answered ${res.status}: ${body.slice(0, 200)}`).toBe(200);
      }, 30_000);
    }
  });
});
