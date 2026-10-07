import { describe, it, expect, afterEach, vi } from 'vitest';
import { attemptKey, clearAttemptKey, clearAllAttemptKeys, attemptIsOver } from './run-attempt-key.js';

/**
 * The attempt key's LIFECYCLE (PRD idempotency-bulk-first §3.3): one key per attempt,
 * reused on a re-click, after a reload and in a second tab, and discarded only when the
 * caller ends the attempt.
 *
 * "The same key comes back after a reload" is the property that matters and it is not
 * something a source grep can see — which is why this logic sits in a module rather than
 * in the component, where the only available instrument would be reading its text.
 */
describe('the workflow run attempt key', () => {
  /**
   * A real store, so a second read is a read of what the first write left behind.
   *
   * `length` and `key(i)` are part of it because `clearAllAttemptKeys` enumerates — a fake
   * that implements only get/set/remove made that function throw, which is a property of
   * the fake and not of the code. Enumeration order follows insertion, as a browser's does.
   */
  function store(): Map<string, string> {
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { m.set(k, v); },
      removeItem: (k: string) => { m.delete(k); },
      clear: () => { m.clear(); },
      get length() { return m.size; },
      key: (i: number) => [...m.keys()][i] ?? null,
    });
    return m;
  }

  afterEach(() => { vi.unstubAllGlobals(); });

  it('mints once and returns the SAME key on every later call', () => {
    store();
    const first = attemptKey('wf-1');
    expect(first).not.toBe('');
    // A re-click in the same tab, a reload, and a second tab all read the same storage,
    // so all three are this assertion: the key is a property of the attempt, not of the
    // call that happens to ask for it.
    expect(attemptKey('wf-1')).toBe(first);
    expect(attemptKey('wf-1')).toBe(first);
  });

  it('gives each workflow its own key', () => {
    store();
    expect(attemptKey('wf-1')).not.toBe(attemptKey('wf-2'));
  });

  it('writes the key through, so a fresh process finds it', () => {
    // The assertion is on STORAGE, not on a second call: a module that returned the same
    // key from an in-memory cache would satisfy "called twice gives the same value" while
    // a reload got a fresh one. What makes the reload work is the written entry, so that
    // is what this reads. (The module holds no state; this is what says so.)
    const m = store();
    const key = attemptKey('wf-1');
    expect([...m.entries()]).toEqual([['lynox:workflow-run-key:wf-1', key]]);
  });

  it('a key already in storage is returned without being rewritten', () => {
    // The reload, as directly as this harness can put it: storage holds a key this
    // process never minted, and the first call must hand back THAT one.
    const m = store();
    m.set('lynox:workflow-run-key:wf-1', 'from-a-previous-process');
    expect(attemptKey('wf-1')).toBe('from-a-previous-process');
    expect(m.get('lynox:workflow-run-key:wf-1')).toBe('from-a-previous-process');
  });

  describe('the attempt is identified by its INPUTS too', () => {
    it('different parameter values are a different attempt', () => {
      store();
      const a = attemptKey('wf-1', { client: 'Acme' });
      const b = attemptKey('wf-1', { client: 'Globex' });
      expect(a).not.toBe(b);
      // and each is stable for its own values
      expect(attemptKey('wf-1', { client: 'Acme' })).toBe(a);
    });

    it('key ORDER does not split one attempt in two', () => {
      store();
      const a = attemptKey('wf-1', { client: 'Acme', month: '2026-05' });
      const b = attemptKey('wf-1', { month: '2026-05', client: 'Acme' });
      expect(b).toBe(a);
    });

    it('no params and empty params are the same attempt', () => {
      store();
      expect(attemptKey('wf-1', {})).toBe(attemptKey('wf-1'));
    });

    it('clearing one set of values leaves the other attempt alone', () => {
      store();
      const acme = attemptKey('wf-1', { client: 'Acme' });
      const globex = attemptKey('wf-1', { client: 'Globex' });
      clearAttemptKey('wf-1', { client: 'Acme' });
      expect(attemptKey('wf-1', { client: 'Acme' })).not.toBe(acme);
      expect(attemptKey('wf-1', { client: 'Globex' })).toBe(globex);
    });
  });

  describe('clearAllAttemptKeys — for a workflow that no longer exists', () => {
    it('drops every attempt of that workflow, whatever its inputs were', () => {
      const m = store();
      attemptKey('wf-1');
      attemptKey('wf-1', { client: 'Acme' });
      attemptKey('wf-1', { client: 'Globex' });
      const other = attemptKey('wf-2', { client: 'Acme' });
      expect(m.size, 'four distinct attempts').toBe(4);
      clearAllAttemptKeys('wf-1');
      // One entry left, and it belongs to the other workflow. Asserted on the PREFIX
      // rather than on the whole name: the suffix is a digest, and pinning its value here
      // would make every change to the fingerprint look like a behaviour change.
      expect([...m.keys()].length).toBe(1);
      expect([...m.keys()][0]!.startsWith('lynox:workflow-run-key:wf-2')).toBe(true);
      expect(attemptKey('wf-2', { client: 'Acme' })).toBe(other);
    });

    it('keeps the user\'s typed VALUES out of the storage key', () => {
      // A regression the fingerprint introduced and this closes: the first version put
      // `client=Acme AG\0iban=CH93 …` verbatim into the key's NAME, where a reader of
      // localStorage finds it and where nothing bounds its length. Before the fingerprint
      // existed, storage held one UUID per workflow.
      const m = store();
      attemptKey('wf-1', { client: 'Nordberg AG', iban: 'CH93 0076 2011 6238 5295 7' });
      const name = [...m.keys()][0]!;
      expect(name).not.toContain('Nordberg');
      expect(name).not.toContain('CH93');
      expect(name).not.toContain('iban');
      // and it is bounded, whatever the values were
      expect(name.length).toBeLessThan(64);
    });

    it('a value cannot forge a parameter boundary', () => {
      // The collision the first version had: `{a: 'x\0b=y'}` and `{a: 'x', b: 'y'}` joined
      // to the same string, so one replayed the other's run — the defect the fingerprint
      // was added to prevent, reintroduced by the fingerprint itself.
      store();
      const forged = attemptKey('wf-1', { a: 'x\u0000b=y' });
      const honest = attemptKey('wf-1', { a: 'x', b: 'y' });
      expect(forged).not.toBe(honest);
      // and the `name=value` form is forgeable the same way
      expect(attemptKey('wf-1', { 'a=b': 'c' })).not.toBe(attemptKey('wf-1', { a: 'b=c' }));
    });

    it('the same text typed on two keyboards is ONE attempt', () => {
      // NFC vs NFD: `Behörde` composed and decomposed are different strings and were two
      // keys, so retyping an umlaut on another OS paid for a second run.
      store();
      const composed = attemptKey('wf-1', { client: 'Beh\u00f6rde' });
      const decomposed = attemptKey('wf-1', { client: 'Beho\u0308rde' });
      expect(decomposed).toBe(composed);
    });

    it('does NOT take the keys of a workflow whose id merely starts the same', () => {
      // `startsWith(prefix)` alone would delete `wf-10`'s keys along with `wf-1`'s.
      const m = store();
      attemptKey('wf-1');
      const sibling = attemptKey('wf-10');
      clearAllAttemptKeys('wf-1');
      expect(m.has('lynox:workflow-run-key:wf-10')).toBe(true);
      expect(attemptKey('wf-10')).toBe(sibling);
    });

    it('does not throw without storage', () => {
      vi.stubGlobal('localStorage', undefined);
      expect(() => clearAllAttemptKeys('wf-1')).not.toThrow();
    });
  });

  describe('attemptIsOver — which answers end the attempt', () => {
    // ⚠ This rule used to be a `keepKey` flag inside the component, witnessed only by a
    // regex asserting that a conditional clear existed in its text. Two mutants survived
    // that: "never clear" and "keep the key on every 409". Driven as a function, each
    // answer is its own case.
    it('keeps the key on the two codes that mean the attempt is ALIVE', () => {
      expect(attemptIsOver({ httpStatus: 409, code: 'run_claim_in_flight' })).toBe(false);
      expect(attemptIsOver({ httpStatus: 409, code: 'run_in_progress' })).toBe(false);
    });

    it('ends the attempt on a 409 that cannot change its answer', () => {
      expect(attemptIsOver({ httpStatus: 409, code: 'run_outcome_unknown' })).toBe(true);
      expect(attemptIsOver({ httpStatus: 409, code: 'run_claim_held' })).toBe(true);
      // A 409 whose code this build does not know: still terminal, because no further
      // click on the same key could get a different answer out of the route.
      expect(attemptIsOver({ httpStatus: 409, code: 'something_new' })).toBe(true);
      expect(attemptIsOver({ httpStatus: 409 })).toBe(true);
    });

    it('ends the attempt on the answers that cannot hide a paid run', () => {
      // 200: the run happened and its outcome is known. 403: the consent gate, before any
      // claim. 404: no such workflow, likewise.
      for (const httpStatus of [200, 403, 404]) {
        expect(attemptIsOver({ httpStatus }), `${httpStatus} cannot carry a paid run`).toBe(true);
      }
    });

    it('KEEPS the key on a 400, because a 400 CAN carry a paid run', () => {
      // ⚠ This asserted the opposite one revision ago, with the reason "refused before any
      // claim could be taken" — and the route's own test suite refutes it: a run that threw
      // AFTER it started answers 400 with its claim stamped as having spent. Discarding the
      // key there is what lets the next click pay for the whole workflow again.
      expect(attemptIsOver({ httpStatus: 400 })).toBe(false);
    });

    it('KEEPS the key on an answer the route did not produce', () => {
      // A 502/503/504 from a proxy, or a 429, returns `!res.ok` while the engine may still
      // be spending. Discarding the key there lets the next click pay a second time.
      for (const httpStatus of [429, 500, 502, 503, 504, 0, 418]) {
        expect(attemptIsOver({ httpStatus }), `${httpStatus} is not the route's decision`).toBe(false);
      }
    });

    it('a code on a non-409 status does not make it terminal', () => {
      // The codes belong to 409. A 502 that happened to carry one must not be read as the
      // route's own refusal.
      expect(attemptIsOver({ httpStatus: 502, code: 'run_outcome_unknown' })).toBe(false);
      expect(attemptIsOver({ httpStatus: 503, code: 'run_in_progress' })).toBe(false);
    });
  });

  it('a cleared attempt mints a DIFFERENT key, and clearing one leaves the other', () => {
    store();
    const first = attemptKey('wf-1');
    const other = attemptKey('wf-2');
    clearAttemptKey('wf-1');
    const second = attemptKey('wf-1');
    expect(second).not.toBe(first);
    expect(attemptKey('wf-2')).toBe(other);
  });

  it('treats a stored EMPTY string as no key rather than handing one back', () => {
    // An empty key is refused by the route (400), so handing one back would make every
    // click fail with no way out but clearing site data. (An earlier version of this
    // comment claimed `''` is what `getItem` returns for a "half-written entry" — it is
    // not: `getItem` returns `null` for an absent key and writes are per-key and
    // synchronous. The test is sound; the reason given for it was invented.)
    const m = store();
    m.set('lynox:workflow-run-key:wf-1', '');
    const key = attemptKey('wf-1');
    expect(key).not.toBe('');
  });

  it('still returns a usable key when storage THROWS, and does not throw itself', () => {
    // Private window / blocked site data. The run has to stay possible; what is lost is
    // recognition across a reload, which is the lesser loss.
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    });
    const a = attemptKey('wf-1');
    const b = attemptKey('wf-1');
    expect(a).not.toBe('');
    expect(b).not.toBe('');
    // and the two differ, which is the honest consequence: without storage there is no
    // attempt identity to carry. The test says so rather than pretending otherwise.
    expect(a).not.toBe(b);
    expect(() => clearAttemptKey('wf-1')).not.toThrow();
  });

  it('survives having no localStorage at all', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(attemptKey('wf-1')).not.toBe('');
    expect(() => clearAttemptKey('wf-1')).not.toThrow();
  });
});
