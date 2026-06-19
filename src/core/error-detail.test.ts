import { describe, it, expect } from 'vitest';
import { extractErrorDetail, ERROR_DETAIL_MAX_CHARS } from './error-detail.js';
import { ExecutionError, ValidationError } from './errors.js';

describe('extractErrorDetail', () => {
  it('captures SDK-style status/type/body so failure classes are distinguishable', () => {
    const apiErr = Object.assign(new Error('rate limited'), {
      status: 429,
      type: 'rate_limit_error',
      error: { type: 'rate_limit_error', message: 'slow down' },
    });
    const detail = JSON.parse(extractErrorDetail(apiErr)) as Record<string, unknown>;
    expect(detail['name']).toBe('Error');
    expect(detail['message']).toBe('rate limited');
    expect(detail['status']).toBe(429);
    expect(detail['type']).toBe('rate_limit_error');
    expect((detail['error'] as { type: string }).type).toBe('rate_limit_error');
  });

  it('includes a LynoxError code + context', () => {
    const err = new ValidationError('bad arg', { field: 'tier' });
    const detail = JSON.parse(extractErrorDetail(err)) as Record<string, unknown>;
    expect(detail['name']).toBe('ValidationError');
    expect(detail['code']).toBe('VALIDATION_ERROR');
    expect((detail['context'] as { field: string }).field).toBe('tier');
  });

  it('unwraps a wrapped provider cause (status survives one level down)', () => {
    const cause = Object.assign(new Error('overloaded'), { status: 529, error: { type: 'overloaded_error' } });
    const wrapped = new ExecutionError('provider call failed', undefined, { cause });
    const detail = JSON.parse(extractErrorDetail(wrapped)) as { cause: Record<string, unknown> };
    expect(detail.cause['message']).toBe('overloaded');
    expect(detail.cause['status']).toBe(529);
    expect((detail.cause['error'] as { type: string }).type).toBe('overloaded_error');
  });

  it('handles non-Error throwns (string + plain object)', () => {
    expect(JSON.parse(extractErrorDetail('boom'))).toEqual({ raw: 'boom' });
    const obj = JSON.parse(extractErrorDetail({ weird: 1 })) as { raw: { weird: number } };
    expect(obj.raw.weird).toBe(1);
  });

  it('caps a giant error body', () => {
    const huge = Object.assign(new Error('x'), { error: { blob: 'A'.repeat(50_000) } });
    const out = extractErrorDetail(huge);
    expect(out.length).toBeLessThanOrEqual(ERROR_DETAIL_MAX_CHARS + 20);
    expect(out.endsWith('…[truncated]')).toBe(true);
  });

  it('never throws on a circular structure', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const err = Object.assign(new Error('circ'), { error: circular });
    expect(() => extractErrorDetail(err)).not.toThrow();
  });
});
