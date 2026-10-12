/**
 * Online guard: every Fireworks model the settings picker offers must still be SERVED.
 * Fireworks is the only catalog entry with `tier_models`; tests/online-guards.test.ts
 * fails if another one gains them, since this file would skip it.
 *
 * The picker list (`tier_models`) IS the dropdown. A withdrawn id in it is a choice
 * that fails on its first call, and nothing else notices: preset-slot-served.test.ts
 * checks only the ids a preset pins, and a picker-only id is pinned by none. On
 * 2026-10-12 six of eleven Fireworks picker ids answered 404.
 *
 * Same skip rule as preset-slot-served.test.ts: no credential → SKIP, credential set
 * and a picker id is not served → FAIL.
 *
 * The positive control calls the six withdrawn ids and expects them NOT to be
 * served. Without it, a probe that reads every answer as 200 would pass the whole
 * list. If one of them comes back, the control fails — that is news too: the id
 * can return to the picker.
 */

import { describe, it, expect } from 'vitest';
import { FIREWORKS_HOST } from './preset-slots.js';
import { WITHDRAWN_FIREWORKS_IDS, completionStatus, pickerModels } from './picker-models.js';

const FIREWORKS_KEY = process.env['FIREWORKS_API_KEY'];
const FIREWORKS_BASE = 'https://api.fireworks.ai/inference/v1';

// That the picker offers at least one Fireworks model is checked offline, in
// tests/online-guards.test.ts: an empty list here would skip silently.
const fireworksModels = pickerModels().filter(m => m.baseUrl.includes(FIREWORKS_HOST));

describe('picker models are served by their provider', () => {
  const runFireworks = FIREWORKS_KEY ? describe : describe.skip;

  runFireworks('Fireworks', () => {
    for (const m of fireworksModels) {
      it(`serves ${m.modelId}`, async () => {
        const { status, body } = await completionStatus(m.baseUrl, m.modelId, FIREWORKS_KEY!);
        expect(status, `${m.modelId} is offered in the ${m.entry} picker but the provider answered ${status}: ${body.slice(0, 200)}`).toBe(200);
      }, 30_000);
    }

    for (const id of WITHDRAWN_FIREWORKS_IDS) {
      it(`control: does not serve withdrawn ${id}`, async () => {
        const { status, body } = await completionStatus(FIREWORKS_BASE, id, FIREWORKS_KEY!);
        expect(status, `${id} was withdrawn on 2026-10-12 but answered ${status}: either the probe no longer tells served from unserved, or the provider serves it again (then it may return to the picker): ${body.slice(0, 200)}`).toBe(404);
      }, 30_000);
    }
  });
});
