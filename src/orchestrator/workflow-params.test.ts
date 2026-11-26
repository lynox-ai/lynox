import { describe, it, expect } from 'vitest';
import { bindWorkflowParameters } from './workflow-params.js';
import type { ProcessParameter } from '../types/pipeline.js';

function param(p: Partial<ProcessParameter> & { name: string }): ProcessParameter {
  return { description: '', type: 'string', source: 'user_input', ...p };
}

describe('bindWorkflowParameters', () => {
  it('binds a supplied string value', () => {
    const r = bindWorkflowParameters([param({ name: 'client' })], { client: 'Acme' });
    expect(r).toEqual({ ok: true, params: { client: 'Acme' } });
  });

  it('empty schema yields an empty params object', () => {
    expect(bindWorkflowParameters([], { extra: 'x' })).toEqual({ ok: true, params: {} });
  });

  it('ignores undeclared supplied keys (only the schema binds)', () => {
    const r = bindWorkflowParameters([param({ name: 'client' })], { client: 'Acme', evil: 'inject' });
    expect(r.ok && r.params).toEqual({ client: 'Acme' });
  });

  it('falls back to defaultValue when a value is not supplied', () => {
    const r = bindWorkflowParameters([param({ name: 'region', defaultValue: 'EU' })], {});
    expect(r).toEqual({ ok: true, params: { region: 'EU' } });
  });

  it('fails when a required param (no default) is missing', () => {
    const r = bindWorkflowParameters([param({ name: 'client' })], {});
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('client');
  });

  it('treats null as missing → required error', () => {
    const r = bindWorkflowParameters([param({ name: 'client' })], { client: null });
    expect(r.ok).toBe(false);
  });

  it('coerces a valid number and rejects junk (empty/whitespace/hex)', () => {
    expect(bindWorkflowParameters([param({ name: 'n', type: 'number' })], { n: '42' })).toEqual({ ok: true, params: { n: 42 } });
    expect(bindWorkflowParameters([param({ name: 'n', type: 'number' })], { n: '-3.14' })).toEqual({ ok: true, params: { n: -3.14 } });
    expect(bindWorkflowParameters([param({ name: 'n', type: 'number' })], { n: 7 })).toEqual({ ok: true, params: { n: 7 } });
    // Number() would silently coerce these — bindWorkflowParameters must reject them.
    for (const bad of ['not-a-number', '', '   ', '0x1f', '0b101', '1e999', '-1e999']) {
      const r = bindWorkflowParameters([param({ name: 'n', type: 'number' })], { n: bad });
      expect(r.ok, `"${bad}" should be rejected`).toBe(false);
    }
    // An exponent is fine as long as the number stays finite.
    expect(bindWorkflowParameters([param({ name: 'n', type: 'number' })], { n: '1e3' })).toEqual({ ok: true, params: { n: 1000 } });
  });

  it('requires an ISO date and rejects lax/junk dates', () => {
    expect(bindWorkflowParameters([param({ name: 'd', type: 'date' })], { d: '2026-06-18' }).ok).toBe(true);
    expect(bindWorkflowParameters([param({ name: 'd', type: 'date' })], { d: '2026-06-18T10:00:00Z' }).ok).toBe(true);
    // Date.parse alone accepts all of these — the ISO guard must reject them.
    for (const bad of ['not-a-date', '2026', 'garbage 2026', '0', '2026-13-45']) {
      const r = bindWorkflowParameters([param({ name: 'd', type: 'date' })], { d: bad });
      expect(r.ok, `"${bad}" should be rejected`).toBe(false);
    }
  });

  it('stringifies a non-string value for a string param', () => {
    const r = bindWorkflowParameters([param({ name: 'x', type: 'string' })], { x: 7 });
    expect(r).toEqual({ ok: true, params: { x: '7' } });
  });

  it('empty string is a valid supplied value (not treated as missing)', () => {
    const r = bindWorkflowParameters([param({ name: 'note' })], { note: '' });
    expect(r).toEqual({ ok: true, params: { note: '' } });
  });

  it('treats a null defaultValue as NO default (Haiku emits "defaultValue": null)', () => {
    // A null default must not silently bind the param to null.
    const strict = bindWorkflowParameters([param({ name: 'client', defaultValue: null })], {});
    expect(strict.ok).toBe(false);
    expect(!strict.ok && strict.error).toContain('client');
  });

  describe('lenient mode (requireAll: false — the autonomous cron / run_workflow path)', () => {
    it('leaves a missing required param UNBOUND instead of erroring', () => {
      const r = bindWorkflowParameters([param({ name: 'month' })], undefined, { requireAll: false });
      // No error, and the unbound param is simply absent (placeholder stays unresolved).
      expect(r).toEqual({ ok: true, params: {} });
    });

    it('still applies a real default and still binds a supplied value', () => {
      const r = bindWorkflowParameters(
        [param({ name: 'region', defaultValue: 'EU' }), param({ name: 'client' })],
        { client: 'Acme' },
        { requireAll: false },
      );
      expect(r).toEqual({ ok: true, params: { region: 'EU', client: 'Acme' } });
    });

    it('still rejects a supplied value that fails type coercion', () => {
      const r = bindWorkflowParameters([param({ name: 'n', type: 'number' })], { n: 'junk' }, { requireAll: false });
      expect(r.ok).toBe(false);
    });
  });

  // === Slice B: capability-contract param constraints (S1) ===
  describe('capability-contract constraints', () => {
    it('accepts a value inside an enum constraint', () => {
      const r = bindWorkflowParameters([param({ name: 'env' })], { env: 'staging' }, {
        constraints: { env: { enum: ['staging', 'prod'] } },
      });
      expect(r).toEqual({ ok: true, params: { env: 'staging' } });
    });

    it('rejects a value outside an enum constraint', () => {
      const r = bindWorkflowParameters([param({ name: 'env' })], { env: 'evil' }, {
        constraints: { env: { enum: ['staging', 'prod'] } },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('must be one of');
    });

    it('rejects a value failing a regex constraint', () => {
      const r = bindWorkflowParameters([param({ name: 'slug' })], { slug: 'has spaces' }, {
        constraints: { slug: { regex: '^[a-z0-9-]+$' } },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('pattern');
    });

    it('accepts a value matching a regex constraint', () => {
      const r = bindWorkflowParameters([param({ name: 'slug' })], { slug: 'monthly-report' }, {
        constraints: { slug: { regex: '^[a-z0-9-]+$' } },
      });
      expect(r.ok).toBe(true);
    });

    it('enforces numeric min/max on a coerced number', () => {
      const c = { constraints: { m: { min: 1, max: 12 } } };
      expect(bindWorkflowParameters([param({ name: 'm', type: 'number' })], { m: '13' }, c).ok).toBe(false);
      expect(bindWorkflowParameters([param({ name: 'm', type: 'number' })], { m: '0' }, c).ok).toBe(false);
      expect(bindWorkflowParameters([param({ name: 'm', type: 'number' })], { m: '6' }, c)).toEqual({ ok: true, params: { m: 6 } });
    });

    it('constrains a defaulted value too (a stored default cannot dodge the contract)', () => {
      const r = bindWorkflowParameters([param({ name: 'env', defaultValue: 'evil' })], {}, {
        constraints: { env: { enum: ['staging', 'prod'] } },
      });
      expect(r.ok).toBe(false);
    });

    it('is a no-op when a param has no declared constraint (existing behaviour unchanged)', () => {
      const r = bindWorkflowParameters([param({ name: 'free' })], { free: 'anything goes' }, {
        constraints: { other: { enum: ['x'] } },
      });
      expect(r).toEqual({ ok: true, params: { free: 'anything goes' } });
    });

    it('an EMPTY enum denies all values (deny-all, never allow-all)', () => {
      const r = bindWorkflowParameters([param({ name: 'env' })], { env: 'anything' }, {
        constraints: { env: { enum: [] } },
      });
      expect(r.ok).toBe(false);
    });

    it('anchors the regex to a FULL match — a substring match is rejected', () => {
      const c = { constraints: { id: { regex: 'reports' } } };
      // un-anchored substring would match, but a full-match anchor rejects it.
      expect(bindWorkflowParameters([param({ name: 'id' })], { id: 'reports/../admin' }, c).ok).toBe(false);
      expect(bindWorkflowParameters([param({ name: 'id' })], { id: 'reports' }, c).ok).toBe(true);
    });

    it('min/max rejects a non-numeric (string) param value instead of loosely coercing it', () => {
      // A string param '0x10' must NOT satisfy a numeric bound via Number('0x10')=16.
      const r = bindWorkflowParameters([param({ name: 's', type: 'string' })], { s: '0x10' }, {
        constraints: { s: { min: 1, max: 100 } },
      });
      expect(r.ok).toBe(false);
      // The same min/max on a real number param works.
      const ok = bindWorkflowParameters([param({ name: 'n', type: 'number' })], { n: '16' }, {
        constraints: { n: { min: 1, max: 100 } },
      });
      expect(ok).toEqual({ ok: true, params: { n: 16 } });
    });

    it('applies only the contract\'s own rule for a parameter, never one every object inherits', () => {
      // An entry on Object.prototype is what a polluted prototype would carry. The stamp preview does
      // not show it (it reads own entries only), so the run must not enforce it either.
      const proto = Object.prototype as Record<string, unknown>;
      proto['inherited'] = { enum: ['only-this'] };
      try {
        const schema = [param({ name: 'inherited', defaultValue: 'stored' })];
        expect(bindWorkflowParameters(schema, { inherited: 'other' }, { constraints: {} })).toEqual({ ok: true, params: { inherited: 'other' } });
        // The stored default is not held to it either.
        expect(bindWorkflowParameters(schema, {}, { constraints: {} })).toEqual({ ok: true, params: { inherited: 'stored' } });
        // CONTROL: the same rule as the contract's own entry is enforced, for a value and for the default.
        const own = { constraints: { inherited: { enum: ['only-this'] } } };
        expect(bindWorkflowParameters(schema, { inherited: 'other' }, own).ok).toBe(false);
        expect(bindWorkflowParameters(schema, {}, own).ok).toBe(false);
      } finally {
        delete proto['inherited'];
      }
    });

    it('a contract whose rules are null binds as one without rules, as the preview shows none', () => {
      const schema = [param({ name: 'env', defaultValue: 'stored' })];
      const none = { constraints: null as unknown as Record<string, never> };
      expect(bindWorkflowParameters(schema, { env: 'any' }, none)).toEqual({ ok: true, params: { env: 'any' } });
      expect(bindWorkflowParameters(schema, {}, none)).toEqual({ ok: true, params: { env: 'stored' } });
    });
  });
});

describe('a pattern that does not compile on its own', () => {
  const schema: ProcessParameter[] = [{ name: 'v', description: '', type: 'string', source: 'user_input' } as ProcessParameter];

  it('is refused, though inside the run\'s anchors it compiles and would admit any value', () => {
    const r = bindWorkflowParameters(schema, { v: 'anything at all' }, { constraints: { v: { regex: 'a)|(.*' } } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('Parameter "v" has an invalid constraint pattern.');
  });

  it('CONTROL: a pattern that compiles on its own still holds in full', () => {
    expect(bindWorkflowParameters(schema, { v: 'b' }, { constraints: { v: { regex: 'a|b' } } }).ok).toBe(true);
    expect(bindWorkflowParameters(schema, { v: 'ab' }, { constraints: { v: { regex: 'a|b' } } }).ok).toBe(false);
  });
});
