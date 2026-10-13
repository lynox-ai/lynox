/**
 * Online guard: every model id the engine prices for the direct Anthropic API must still
 * be SERVED, under its own name.
 *
 * The list is `MODEL_CAPABILITIES`, not the picker: the Anthropic catalog entry offers a
 * subset, and the candidates for the next model switch have capability rows (price and
 * request shape) before any catalog entry, preset or default names them. A switch PR
 * that points a tier at one of them needs to know it answers; this is the reachability
 * step of the switch's eval plan.
 *
 * A one-token message is enough to tell served from not served, and the response names
 * the model that answered, so each case also asserts that the name is the one asked for.
 *
 * Skip rule as in the other online guards: no credential → SKIP; credential set and an
 * id is not served or answers under another name → FAIL. A credential without credit
 * answers 400 for every id, which fails here as well; the message says so.
 *
 * The positive control calls a retired id and expects it NOT to be served.
 */
import { describe, it, expect } from 'vitest';
import { hasApiKey, getApiKey } from './setup.js';
import { RETIRED_ANTHROPIC_ID, anthropicDirectIds, messageStatus } from './anthropic-models.js';

// That the list is non-empty and carries the switch candidates is checked offline, in
// tests/online-guards.test.ts: an empty list here would pass silently.
const ids = anthropicDirectIds();

describe('Anthropic serves every model the engine prices for its API', () => {
  const run = hasApiKey() ? describe : describe.skip;

  run('api.anthropic.com', () => {
    for (const id of ids) {
      it(`serves ${id}`, async () => {
        const { status, body } = await messageStatus(id, getApiKey());
        expect(status, `${id} has a capability row but Anthropic answered ${status}: ${body.slice(0, 200)}`).toBe(200);
        const served = (JSON.parse(body) as { model?: unknown }).model;
        expect(served, `${id} was served as ${String(served)}`).toBe(id);
      }, 60_000);
    }

    it(`positive control: does not serve the retired ${RETIRED_ANTHROPIC_ID}`, async () => {
      const { status, body } = await messageStatus(RETIRED_ANTHROPIC_ID, getApiKey());
      expect(status, `the retired id answered ${status}: ${body.slice(0, 200)}`).toBe(404);
    }, 60_000);
  });
});
