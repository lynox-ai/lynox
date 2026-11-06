import { describe, it, expect } from 'vitest';
import { APIError } from '@anthropic-ai/sdk';
import { isRetryable } from './agent.js';

const named = (name: string, message = 'x'): Error => Object.assign(new Error(message), { name });

describe('isRetryable — stream-transport failures', () => {
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

  it('walks a multi-level cause chain with the full matcher (SDK connection-error shape)', () => {
    // @anthropic-ai/sdk: APIConnectionError('Connection error.') → TypeError('fetch failed') → ECONNRESET
    const chain = Object.assign(new Error('Connection error.'), {
      cause: Object.assign(new TypeError('fetch failed'), { cause: new Error('read ECONNRESET') }),
    });
    expect(isRetryable(chain)).toBe(true);
    // two opaque wrappers — only recursion to depth 2 finds the transient root
    const buried = Object.assign(new Error('opaque outer'), {
      cause: Object.assign(new Error('opaque inner'), { cause: new Error('read ECONNRESET') }),
    });
    expect(isRetryable(buried)).toBe(true);
    // depth bound: a chain deeper than 4 levels of noise stops matching
    let deep: Error = new Error('read ECONNRESET');
    for (let i = 0; i < 5; i++) deep = Object.assign(new Error('opaque wrapper'), { cause: deep });
    expect(isRetryable(deep)).toBe(false);
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

  it('classifies adapter HTTP errors by STATUS, never by the untrusted body text', () => {
    // openai-adapter embeds the provider error body verbatim — the body text is
    // attacker-influencable and must never make a paid deterministic 4xx look transient.
    expect(isRetryable(new Error('OpenAI-compatible API error 400: request terminated by moderation'))).toBe(false);
    expect(isRetryable(new Error('OpenAI-compatible API error 422: account terminated'))).toBe(false);
    expect(isRetryable(new Error('OpenAI-compatible API error 400: upstream read ECONNRESET while proxying'))).toBe(false);
    // a deterministic 4xx stays non-retryable even with a transport-looking cause attached
    expect(isRetryable(Object.assign(new Error('OpenAI-compatible API error 400: x'), { cause: new Error('read ECONNRESET') }))).toBe(false);
    // transient statuses ARE retryable regardless of body
    expect(isRetryable(new Error('OpenAI-compatible API error 429: slow down'))).toBe(true);
    expect(isRetryable(new Error('OpenAI-compatible API error 502: bad gateway'))).toBe(true);
    expect(isRetryable(new Error('OpenAI-compatible API error 503: overloaded'))).toBe(true);
    // a mid-message "terminated" in a plain (non-adapter) error is not undici's shape either
    expect(isRetryable(new Error('subscription terminated by admin'))).toBe(false);
  });
});

describe('isRetryable — provider errors inside the stream (status undefined)', () => {
  // The shape the SDK's stream parser throws for an `error` event: status undefined, the whole
  // event as the body, and the event's error type as `type` (core/streaming.js).
  const envelope = (type: string): { type: string; error: { type: string; message: string } } =>
    ({ type: 'error', error: { type, message: 'mid-stream failure' } });
  const midStream = (type: string): APIError => new APIError(undefined, envelope(type), undefined, new Headers(), type);

  it('retries the three transient types, like their HTTP twins', () => {
    expect(isRetryable(midStream('overloaded_error'))).toBe(true);
    expect(isRetryable(midStream('rate_limit_error'))).toBe(true);
    expect(isRetryable(midStream('api_error'))).toBe(true);
  });

  it('does not retry any other type', () => {
    for (const type of ['invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'request_too_large', 'billing_error', 'error']) {
      expect(isRetryable(midStream(type)), type).toBe(false);
    }
  });

  it('reads `type` alone, without a body', () => {
    expect(isRetryable(new APIError(undefined, undefined, 'x', new Headers(), 'overloaded_error'))).toBe(true);
  });

  it('reads the envelope alone, for an APIError built without the type argument', () => {
    expect(isRetryable(new APIError(undefined, envelope('overloaded_error'), undefined, new Headers(), undefined))).toBe(true);
    expect(isRetryable(new APIError(undefined, envelope('invalid_request_error'), undefined, new Headers(), undefined))).toBe(false);
  });
});
