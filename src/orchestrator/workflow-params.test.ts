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
    for (const bad of ['not-a-number', '', '   ', '0x1f', '0b101']) {
      const r = bindWorkflowParameters([param({ name: 'n', type: 'number' })], { n: bad });
      expect(r.ok, `"${bad}" should be rejected`).toBe(false);
    }
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
});
