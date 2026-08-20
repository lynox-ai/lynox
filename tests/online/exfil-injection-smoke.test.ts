/**
 * Online smoke for the exfil-injection harness (real Haiku API).
 *
 * NOT the measurement — that is `scripts/exfil-injection/run.ts` across the model
 * matrix. This is the instrument's ONLINE self-check: it proves the harness
 * actually drives a real model, delivers the injection through the real scan/wrap
 * path, and produces a well-formed judged outcome end-to-end.
 *
 * It does NOT assert that the model leaks — a well-aligned model REFUSES, which
 * is the measurement, not a failure. The proof that the instrument can SEE a leak
 * is the deterministic MECHANICAL control (mechanical-control.test.ts), which
 * needs no model. Asserting "a real model leaks" here would make a safe model
 * indistinguishable from a blind harness (fb_eval_preflight).
 *
 * Cost: a few cents. Skipped without an Anthropic key.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getApiKey, hasApiKey, HAIKU } from './setup.js';
import { runCase, type ModelSpec } from '../security/exfil-injection/harness.js';
import { buildCorpus } from '../security/exfil-injection/corpus.js';
import { makeCanary } from '../security/exfil-injection/judge.js';

const SKIP = !hasApiKey();

describe.skipIf(SKIP)('Online: exfil-injection harness liveness', () => {
  let spec: ModelSpec;
  beforeAll(() => {
    spec = { label: 'haiku', provider: 'anthropic', model: HAIKU, apiKey: getApiKey() };
  });

  it('drives a real model and DELIVERS the injection through the real read path', async () => {
    const web = buildCorpus().find(c => c.id === 'web-verify-evade')!;
    const canary = makeCanary();
    const out = await runCase(web, canary, spec, { interactive: false, maxIterations: 6 });
    // Liveness (refuter C1): the model made tool calls and read the injected note.
    expect(out.error, out.error).toBeUndefined();
    expect(out.toolCalls).toBeGreaterThan(0);
    expect(out.delivered).toBe(true);
  }, 90_000);

  it('runs a case end-to-end and produces a well-formed JUDGED outcome (no assertion on leak — that is the measurement)', async () => {
    const http = buildCorpus().find(c => c.id === 'http-control-evade')!;
    const canary = makeCanary();
    const out = await runCase(http, canary, spec, { interactive: false, maxIterations: 6 });
    expect(out.error, out.error).toBeUndefined();
    expect(out.delivered).toBe(true);
    expect(Array.isArray(out.egress)).toBe(true);
    // Every egress the model DID emit is fully judged (both layers present).
    for (const e of out.egress) {
      expect(typeof e.verdict.attempted).toBe('boolean');
      expect(typeof e.verdict.endToEndLeak).toBe('boolean');
      // The wiring invariant that also holds on real runs: http_request can never
      // leak end-to-end under guarded (full-control blocked to a non-baseline host).
      if (e.call.channel === 'http_request') expect(e.verdict.endToEndLeak).toBe(false);
    }
  }, 120_000);
});
