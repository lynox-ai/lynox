import { describe, expect, it } from 'vitest';
import { GenerateRateLimiter } from './generate-rate-limit.js';

describe('GenerateRateLimiter', () => {
  it('allows requests up to the cap, then rejects', () => {
    let t = 1_000_000;
    const limiter = new GenerateRateLimiter({ windowMs: 1000, maxPerWindow: 3, now: () => t });
    expect(limiter.check('a').ok).toBe(true);
    expect(limiter.check('a').ok).toBe(true);
    expect(limiter.check('a').ok).toBe(true);
    const rejected = limiter.check('a');
    expect(rejected.ok).toBe(false);
    expect(rejected.windowCount).toBe(3);
    expect(rejected.retryAt).toBeInstanceOf(Date);
  });

  it('separates buckets per account', () => {
    let t = 0;
    const limiter = new GenerateRateLimiter({ windowMs: 1000, maxPerWindow: 1, now: () => t });
    expect(limiter.check('a').ok).toBe(true);
    expect(limiter.check('a').ok).toBe(false);
    // Different account still gets its own slot.
    expect(limiter.check('b').ok).toBe(true);
    expect(limiter.check('b').ok).toBe(false);
  });

  it('reopens the window once timestamps age past windowMs', () => {
    let t = 0;
    const limiter = new GenerateRateLimiter({ windowMs: 1000, maxPerWindow: 2, now: () => t });
    expect(limiter.check('a').ok).toBe(true);
    expect(limiter.check('a').ok).toBe(true);
    expect(limiter.check('a').ok).toBe(false);
    t += 1100;
    // Both prior timestamps now expired; bucket starts fresh.
    expect(limiter.check('a').ok).toBe(true);
  });

  it('retryAt reflects when the oldest in-window timestamp expires', () => {
    let t = 5000;
    const limiter = new GenerateRateLimiter({ windowMs: 1000, maxPerWindow: 1, now: () => t });
    limiter.check('a');
    t += 200;
    const rejected = limiter.check('a');
    expect(rejected.ok).toBe(false);
    // Oldest entry at t=5000 + windowMs 1000 → retryAt 6000.
    expect(rejected.retryAt?.getTime()).toBe(6000);
  });

  it('reset clears all buckets', () => {
    const limiter = new GenerateRateLimiter({ windowMs: 1000, maxPerWindow: 1 });
    limiter.check('a');
    expect(limiter.check('a').ok).toBe(false);
    limiter.reset();
    expect(limiter.check('a').ok).toBe(true);
  });
});
