/**
 * Online guard: every Mistral id the registry prices is billed as the model that answers it.
 *
 * ## Why
 *
 * Mistral does not refuse a retired id. It answers it with a successor and names that
 * successor in the response's `model` field: on 2026-10-13 `mistral-medium-2508` came back
 * as `mistral-medium-3-5`, an alias of `mistral-medium-2604` (registry $1.50/$7.50 against
 * the $0.40/$2 it charged for 2508), and
 * `open-mistral-nemo` as `ministral-8b-2512`. A legacy config that pins such an id runs on
 * another model at another price, and the cost cap counts the wrong number — a silent
 * failure in the permissive direction.
 * `MISTRAL_SERVED_AS` maps those ids to the entry of the model that answers; this guard
 * checks the map against the wire:
 *
 * - an id in the map is answered by its target or one of the target's aliases;
 * - every other Mistral id is answered under its own name;
 * - two registered ids that `GET /v1/models` lists as aliases of each other price alike
 *   (`magistral-small-latest` is an alias of `mistral-small-2603` and was priced above it);
 * - an UNDATED id that answers under its own name (`codestral-latest`) has a dated id in its
 *   alias group that the registry prices alike — the `model` field echoes the alias, so
 *   without this a `-latest` moved to a new model would pass;
 * - the registry's context window does not exceed the answering model's
 *   `max_context_length` (a window too large moves compaction past what the provider accepts).
 *
 * Same skip rule as `preset-slot-served.test.ts`: no credential → skip; credential set and
 * the wire disagrees with the registry → FAIL. Positive control: an id that does not exist
 * must answer 400, or the probe is not asking what it claims to.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { MODEL_CAPABILITIES, MISTRAL_SERVED_AS } from '../../src/types/models.js';

const BASE = 'https://api.mistral.ai/v1';
const KEY = process.env['MISTRAL_API_KEY'];
const MISTRAL_ID = /^(mistral|ministral|magistral|open-mistral|codestral|devstral|pixtral)-/;
const mistralIds = Object.keys(MODEL_CAPABILITIES).filter((id) => MISTRAL_ID.test(id));
/** A dated Mistral id ends in a four-digit release (`-2508`, `-2604`). */
const DATED = /-\d{4}$/;

async function served(model: string): Promise<{ status: number; model: unknown; text: string }> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }),
  });
  const text = await res.text();
  let parsed: { model?: unknown } = {};
  try { parsed = JSON.parse(text) as { model?: unknown }; } catch { /* the status says it */ }
  return { status: res.status, model: parsed.model, text };
}

describe('the Mistral ids the registry prices', () => {
  const run = KEY ? describe : describe.skip;
  run('are billed as the model that answers them', () => {
    // Inside the keyed block: tests/online/ may hold no check that passes without
    // credentials (tests/online-guards.test.ts), and the selection only matters to this run.
    it('the selection finds the ids it is meant to', () => {
      expect(mistralIds, 'a tier-routed id').toContain('mistral-medium-2604');
      expect(mistralIds, 'a remapped legacy id').toContain('mistral-medium-2508');
      for (const legacy of Object.keys(MISTRAL_SERVED_AS)) expect(mistralIds, legacy).toContain(legacy);
    });

    const aliases = new Map<string, Set<string>>();
    const maxContext = new Map<string, number>();
    beforeAll(async () => {
      const res = await fetch(`${BASE}/models`, { headers: { 'Authorization': `Bearer ${KEY}` } });
      expect(res.status, 'GET /v1/models').toBe(200);
      const body = await res.json() as { data?: Array<{ id: string; aliases?: string[]; max_context_length?: number }> };
      for (const m of body.data ?? []) {
        aliases.set(m.id, new Set([m.id, ...(m.aliases ?? [])]));
        if (typeof m.max_context_length === 'number') maxContext.set(m.id, m.max_context_length);
      }
      expect(aliases.size, 'the model list is not empty').toBeGreaterThan(0);
    }, 30_000);

    it('positive control: an id that does not exist is refused', async () => {
      const r = await served('lynox-guard-no-such-model');
      expect(r.status, r.text.slice(0, 200)).toBe(400);
    }, 30_000);

    for (const id of mistralIds) {
      it(`${id}`, async () => {
        const r = await served(id);
        expect(r.status, `${id} answered ${r.status}: ${r.text.slice(0, 200)}`).toBe(200);
        const target = MISTRAL_SERVED_AS[id];
        const answeringId = target ?? id;
        const limit = maxContext.get(answeringId);
        expect(limit, `GET /v1/models gives no max_context_length for ${answeringId}`).toBeTypeOf('number');
        expect(MODEL_CAPABILITIES[id]!.contextWindow,
          `${id}: registry window exceeds ${answeringId}'s max_context_length ${String(limit)}`)
          .toBeLessThanOrEqual(limit!);
        if (target !== undefined) {
          const answering = aliases.get(target) ?? new Set([target]);
          expect(answering.has(String(r.model)) || r.model === target,
            `${id} is mapped to ${target}, but was served as ${String(r.model)}`).toBe(true);
          return;
        }
        expect(r.model, `${id} was served as ${String(r.model)}: add it to MISTRAL_SERVED_AS with that model's pricing`).toBe(id);
        if (!DATED.test(id)) {
          const dated = [...(aliases.get(id) ?? [])].filter((a) => DATED.test(a));
          const priced = dated.filter((a) => MODEL_CAPABILITIES[a] !== undefined && MISTRAL_SERVED_AS[a] === undefined);
          expect(priced.length, `${id} is an alias of ${JSON.stringify(dated)}, none of which the registry prices: map it in MISTRAL_SERVED_AS`)
            .toBeGreaterThan(0);
        }
        for (const other of aliases.get(id) ?? []) {
          if (other === id || MODEL_CAPABILITIES[other] === undefined || MISTRAL_SERVED_AS[other] !== undefined) continue;
          expect(MODEL_CAPABILITIES[other]!.pricing, `${other} is an alias of ${id} and must price alike`)
            .toEqual(MODEL_CAPABILITIES[id]!.pricing);
        }
      }, 30_000);
    }
  });
});
