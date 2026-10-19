/**
 * The exact-attach wire (`src/contract/http.ts`).
 *
 * The control plane clears an instance for an exact (Shopify) connection, and
 * reports on every usage status whether it holds that clearance. Both answers
 * cross a repo boundary, and both readers must fail closed: a reply that is not
 * exactly `ok: true` is a refusal, and an `exact_held` that is not a boolean is
 * no statement at all, never a `false` that would make the engine act.
 */
import { describe, it, expect } from 'vitest';
import {
  EXACT_ATTACH_REFUSALS,
  isExactAttachRefusal,
  isExactAttachCleared,
  readExactHeld,
} from '../src/contract/http.js';
import { MIGRATED } from '../src/contract/migrated.js';

describe('the refusal vocabulary', () => {
  it('is exactly the five reasons the route refuses with', () => {
    expect([...EXACT_ATTACH_REFUSALS]).toEqual([
      'not_tenant_host', 'below_floor', 'no_floor', 'busy', 'rate_limited',
    ]);
  });

  it('isExactAttachRefusal accepts every member and nothing else', () => {
    for (const reason of EXACT_ATTACH_REFUSALS) expect(isExactAttachRefusal(reason)).toBe(true);
    for (const other of ['BUSY', '', ' busy', 'ok', undefined, null, 1]) {
      expect(isExactAttachRefusal(other)).toBe(false);
    }
  });
});

describe('isExactAttachCleared', () => {
  it('clears on the boolean true', () => {
    expect(isExactAttachCleared({ ok: true })).toBe(true);
  });

  it('refuses everything else', () => {
    for (const body of [
      { ok: false, reason: 'busy' }, { ok: 'true' }, { ok: 1 }, { ok: null }, {},
      null, undefined, 'ok', true, [true],
    ]) {
      expect(isExactAttachCleared(body)).toBe(false);
    }
  });
});

describe('only an own data property speaks', () => {
  it('ignores an inherited value, a getter, and an array carrying the field', () => {
    const inherited = Object.create({ ok: true, exact_held: false }) as object;
    const getters = {
      get ok() { return true; },
      get exact_held() { return false; },
    };
    const array = Object.assign([], { ok: true, exact_held: false });
    for (const body of [inherited, getters, array]) {
      expect(isExactAttachCleared(body)).toBe(false);
      expect(readExactHeld(body)).toBeNull();
    }
  });

  it('reads a parsed body, including one with a "__proto__" key', () => {
    expect(isExactAttachCleared(JSON.parse('{"ok":true}'))).toBe(true);
    expect(readExactHeld(JSON.parse('{"exact_held":false}'))).toBe(false);
    expect(isExactAttachCleared(JSON.parse('{"__proto__":{"ok":true}}'))).toBe(false);
  });
});

describe('readExactHeld', () => {
  it('reads both booleans as statements', () => {
    expect(readExactHeld({ exact_held: true })).toBe(true);
    expect(readExactHeld({ exact_held: false })).toBe(false);
  });

  it('reads an absent or non-boolean field as no statement, never as false', () => {
    for (const body of [
      {}, { exact_held: 'true' }, { exact_held: 'false' }, { exact_held: 1 }, { exact_held: 0 },
      { exact_held: null }, null, undefined, 'exact_held', false,
      // Not an object, even though the property is there: only a parsed object body speaks.
      Object.assign(() => undefined, { exact_held: true }),
    ]) {
      expect(readExactHeld(body)).toBeNull();
    }
  });
});

describe('the exact-attach symbols are registered as migrated', () => {
  // The orphan-twin sweep (`contract-drift.test.ts`) hunts only what `MIGRATED`
  // names; without these rows a private copy could appear and nothing would object.
  it('names all seven, owned by http.ts', () => {
    const rows = MIGRATED.filter((m) => m.contractFile === 'http.ts').map((m) => m.name);
    for (const name of [
      'ExactAttachRequest', 'EXACT_ATTACH_REFUSALS', 'ExactAttachRefusal', 'isExactAttachRefusal',
      'ExactAttachResponse', 'isExactAttachCleared', 'readExactHeld',
    ]) {
      expect(rows).toContain(name);
    }
  });
});
