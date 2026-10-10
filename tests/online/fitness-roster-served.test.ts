/**
 * Online guard: every model the fitness instruments call must still be SERVED, under
 * its own name.
 *
 * ## Why
 *
 * The rosters in `scripts/model-fitness/` are written by hand and were never checked
 * against the providers. By 2026-10-10 the judge (`judge.ts`) and five replay candidates
 * pointed at Fireworks models the provider had withdrawn, so a run would have spent its
 * budget on 404s, and every judge-scored case would have come back as a JudgeError.
 *
 * A 200 is not enough on Mistral. Mistral answers some retired ids by serving a newer
 * model and naming that model in the response: a call for `open-mistral-nemo` comes
 * back with `model: ministral-8b-2512`. A comparator that is silently another model
 * scores that model under the old name. So each case asserts the status AND that the
 * response names the model that was asked for.
 *
 * Same skip rule as `preset-slot-served.test.ts`: no credential → skip; credential set
 * and the model is gone or renamed → FAIL.
 */
import { describe, it, expect } from 'vitest';
import { ALL_CANDIDATES } from '../../scripts/model-fitness/models.js';
import { CANDIDATES as REPLAY_CANDIDATES } from '../../scripts/model-fitness/replay.js';
import { JUDGE_MODEL } from '../../scripts/model-fitness/judge.js';
import { fitnessRosterIds, FITNESS_HOSTS } from './fitness-roster.js';

const KEYS: Record<keyof typeof FITNESS_HOSTS, string | undefined> = {
  fireworks: process.env['FIREWORKS_API_KEY'],
  mistral: process.env['MISTRAL_API_KEY'],
};

const roster = fitnessRosterIds({ candidates: ALL_CANDIDATES, replay: REPLAY_CANDIDATES, judgeModel: JUDGE_MODEL });

describe('the fitness instruments call models their provider still serves', () => {
  for (const host of Object.keys(FITNESS_HOSTS) as Array<keyof typeof FITNESS_HOSTS>) {
    const key = KEYS[host];
    const run = key ? describe : describe.skip;
    run(host, () => {
      for (const entry of roster.filter(e => e.host === host)) {
        it(`serves ${entry.modelId} (used by: ${entry.usedBy.join(', ')})`, async () => {
          const res = await fetch(`${FITNESS_HOSTS[host]}/chat/completions`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: entry.modelId, max_tokens: 1, messages: [{ role: 'user', content: 'ok' }] }),
          });
          const body = await res.text();
          expect(res.status, `${entry.modelId} (used by ${entry.usedBy.join(', ')}) answered ${res.status}: ${body.slice(0, 200)}`).toBe(200);
          const served = (JSON.parse(body) as { model?: unknown }).model;
          expect(served, `${entry.modelId} was served as ${String(served)} — the provider routes this id to another model`).toBe(entry.modelId);
        }, 30_000);
      }
    });
  }
});
