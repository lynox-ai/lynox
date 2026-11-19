import { describe, it, expect } from 'vitest';
import { legacyMemoryReason } from './memory-tool-set.js';

/** The answer the registration and the mandate lock both read (660a-2). The boot test proves the engine uses it. */
describe('legacyMemoryReason', () => {
  const store = {};
  it.each([
    ['durable on, store there: the durable tools', true, store, null],
    ['durable on, store missing: the legacy tools, and why', true, null, 'store_missing'],
    ['durable off: the legacy tools', false, store, 'dk_off'],
    ['durable unset: off', undefined, store, 'dk_off'],
    ['a truthy non-true flag is not on', 'true', store, 'dk_off'],
  ] as const)('%s', (_label, flag, ks, expected) => {
    expect(legacyMemoryReason(flag, ks)).toBe(expected);
  });
});
