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
import { FIREWORKS_HOST, pinnedSlots } from './preset-slots.js';

const FIREWORKS_KEY = process.env['FIREWORKS_API_KEY'];

const slots = pinnedSlots();
const fireworksSlots = slots.filter(s => s.baseUrl.includes(FIREWORKS_HOST));

// That the presets pin at least one Fireworks slot is checked offline, in
// tests/online-guards.test.ts: an empty list here would skip silently.
describe('preset slots are served by their provider', () => {
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
