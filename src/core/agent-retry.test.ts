import { describe, it, expect } from 'vitest';
import { isRetryable } from './agent.js';

const named = (name: string, message = 'x'): Error => Object.assign(new Error(message), { name });

describe('isRetryable — stream-transport failures (DEF-fireworks-longstream-retry)', () => {
  it('retries a TransformError (a dropped provider stream on a long output)', () => {
    expect(isRetryable(named('TransformError'))).toBe(true);
  });

  it('retries a terminated / other-side-closed stream', () => {
    expect(isRetryable(new Error('terminated'))).toBe(true);
    expect(isRetryable(new Error('The operation was aborted: other side closed'))).toBe(true);
  });

  it('retries an undici error that wraps the transport failure in .cause', () => {
    expect(isRetryable(Object.assign(new Error('fetch failed wrapper'), { cause: new Error('read ECONNRESET') }))).toBe(true);
    expect(isRetryable(Object.assign(new Error('boom'), { cause: new Error('terminated') }))).toBe(true);
  });

  it('still retries the pre-existing connection errors', () => {
    expect(isRetryable(new Error('socket hang up'))).toBe(true);
    expect(isRetryable(new Error('connect ETIMEDOUT'))).toBe(true);
    expect(isRetryable(new Error('read ECONNRESET'))).toBe(true);
  });

  it('does NOT retry a plain non-transient error or non-Error value', () => {
    expect(isRetryable(new Error('validation failed'))).toBe(false);
    expect(isRetryable('some string')).toBe(false);
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });
});
