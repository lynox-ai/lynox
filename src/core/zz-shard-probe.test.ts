import { describe, it, expect } from 'vitest';

// Fails on purpose: a failing shard must turn the `test` check red. Reverted in the next commit.
describe('shard probe', () => {
  it('fails on purpose', () => {
    expect(1).toBe(2);
  });
});
