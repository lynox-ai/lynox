/**
 * The independent judge's failure semantics (`scripts/model-fitness/judge.ts`).
 *
 * The shipped defect: a judge that was configured but FAILED (a 401, a 429, an
 * unreachable host) returned the same `null` as a judge that was never configured,
 * and the callers soft-pass on `null`. `grounding-discipline` gates all three
 * tiers, so a judge outage turned silently into FIT for every candidate — the
 * harness reporting a verdict it had not measured.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { judgeAvailable, judgeQuality } from '../scripts/model-fitness/judge.js';

const ARGS = { task: 't', answer: 'a', rubric: 'r' };
const originalFetch = globalThis.fetch;
const originalKey = process.env['FIREWORKS_API_KEY'];

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env['FIREWORKS_API_KEY'];
  else process.env['FIREWORKS_API_KEY'] = originalKey;
  vi.restoreAllMocks();
});

const reply = (content: string): Response =>
  ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) }) as unknown as Response;

describe('judgeQuality', () => {
  it('returns null when no judge is configured — the deliberate soft-pass', () => {
    delete process.env['FIREWORKS_API_KEY'];
    expect(judgeAvailable()).toBe(false);
    return expect(judgeQuality(ARGS)).resolves.toBeNull();
  });

  it('THROWS when a configured judge answers with an error status', async () => {
    process.env['FIREWORKS_API_KEY'] = 'k';
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }) as unknown as Response);
    await expect(judgeQuality(ARGS)).rejects.toThrow(/429/);
  });

  it('THROWS when a configured judge is unreachable', async () => {
    process.env['FIREWORKS_API_KEY'] = 'k';
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    await expect(judgeQuality(ARGS)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('scores a normal reply, taking the model conclusion and not its scratch work', async () => {
    process.env['FIREWORKS_API_KEY'] = 'k';
    globalThis.fetch = vi.fn(async () => reply('First I considered 2/5, but on reflection SCORE: 4/5'));
    await expect(judgeQuality(ARGS)).resolves.toMatchObject({ score: 4 });
  });

  it('returns null when a reachable judge answers with nothing scorable', async () => {
    // Still soft-passes: the call worked, the reply was useless. Distinct from an
    // outage, which is an error the run records against the candidate.
    process.env['FIREWORKS_API_KEY'] = 'k';
    globalThis.fetch = vi.fn(async () => reply('I would rather not say.'));
    await expect(judgeQuality(ARGS)).resolves.toBeNull();
  });
});
