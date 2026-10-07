import { describe, it, expect, afterEach, vi } from 'vitest';
import { attemptKey, clearAttemptKey } from './run-attempt-key.js';

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
  /** A real store, so a second read is a read of what the first write left behind. */
  function store(): Map<string, string> {
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { m.set(k, v); },
      removeItem: (k: string) => { m.delete(k); },
      clear: () => { m.clear(); },
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
    const m = store();
    const key = attemptKey('wf-1');
    expect([...m.entries()]).toEqual([['lynox:workflow-run-key:wf-1', key]]);
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
    // An empty key would be refused by the route (400) and would then be retried
    // forever, since it is also what `getItem` returns for a half-written entry.
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
