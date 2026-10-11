import { describe, it, expect, vi } from 'vitest';

// A volume that never answers: every append hangs.
vi.mock('node:fs/promises', async (orig) => ({
  ...(await orig<typeof import('node:fs/promises')>()),
  appendFile: () => new Promise<void>(() => {}),
}));

const { appendBoundedJsonl, quiesceBoundedJsonl, isBoundedJsonlQuiesced } = await import('./bounded-jsonl-log.js');

/**
 * The erasure waits for writes in flight before it removes the logs. A write stuck on a
 * hung volume must not hold the erasure forever: the wait is bounded and the hold stands.
 */
describe('quiesceBoundedJsonl with a hung write', () => {
  it('stops waiting after the bound and keeps the hold', async () => {
    void appendBoundedJsonl('hung-sink.jsonl', { seq: 1 });
    // Let the write get past its check and into the hung call; a hold taken earlier would
    // simply drop it, and the bound would never be needed.
    await new Promise((r) => setTimeout(r, 20));
    const started = Date.now();
    const resume = await quiesceBoundedJsonl(50);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(isBoundedJsonlQuiesced()).toBe(true);
    resume();
  });
});
