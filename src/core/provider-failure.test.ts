import { describe, it, expect } from 'vitest';
import { classifyProviderFailure, type RunFailure } from './provider-failure.js';

const FIREWORKS = 'api.fireworks.ai';
const ANTHROPIC = 'api.anthropic.com';
const MISTRAL = 'api.mistral.ai';
const CUSTOM = 'llm.example.invalid';

/** The OpenAI-compatible adapter's exact throw shape (openai-adapter.ts). */
function adapterError(status: number, body: string): Error {
  return new Error(`OpenAI-compatible API error ${status}: ${body}`);
}

/** An Anthropic SDK APIError-like instance (duck-typed by the classifier). */
function anthropicError(status: number, type: string, message: string): Error {
  return Object.assign(new Error(`${status} ${message}`), {
    status,
    error: { type: 'error', error: { type, message } },
  });
}

describe('classifyProviderFailure — measured billing shapes', () => {
  it('Fireworks 412 with the real suspended body → billing (adapter path)', () => {
    const err = adapterError(
      412,
      'Account lynox is suspended, possibly due to reaching the monthly spending limit or failure to pay past invoices',
    );
    const r = classifyProviderFailure(err, FIREWORKS);
    expect(r).toEqual<RunFailure>({ kind: 'provider_billing', providerHost: FIREWORKS, status: 412 });
  });

  it('Fireworks 412 with NO body still classifies (status-only rule)', () => {
    // The signal is the 412 from fireworks; the body is confirmation, not required.
    expect(classifyProviderFailure(adapterError(412, ''), FIREWORKS)).not.toBeNull();
  });

  it('a 412 from a NON-Fireworks host is NOT billing (the 412 rule is host-pinned)', () => {
    // Pins the `host === 'api.fireworks.ai'` half of rule 2: 412 is Fireworks's
    // billing signal, not a universal one (Mistral's 412 would mean something else).
    expect(classifyProviderFailure(adapterError(412, ''), MISTRAL)).toBeNull();
    expect(classifyProviderFailure(adapterError(412, 'precondition failed'), ANTHROPIC)).toBeNull();
  });

  it('Anthropic 400 with the real credit-balance body → billing (APIError path)', () => {
    const err = anthropicError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API');
    expect(classifyProviderFailure(err, ANTHROPIC)).toEqual<RunFailure>({
      kind: 'provider_billing', providerHost: ANTHROPIC, status: 400,
    });
  });

  it('402 Payment Required → billing on any host (status, not body)', () => {
    expect(classifyProviderFailure(adapterError(402, 'Payment Required'), MISTRAL)).not.toBeNull();
    // Even an untrusted host: 402 is a status the endpoint operator sets, and the
    // CP alert path gates on managed provider_type anyway.
    expect(classifyProviderFailure(adapterError(402, ''), CUSTOM)).not.toBeNull();
  });

  it('Mistral undocumented 401 + insufficient-balance body → billing (trusted-host vocab)', () => {
    const err = adapterError(401, '{"message":"Insufficient balance to complete the request"}');
    expect(classifyProviderFailure(err, MISTRAL)).not.toBeNull();
  });
});

describe('classifyProviderFailure — does NOT over-classify', () => {
  it('a 429 rate limit is never billing, even with a spending-limit body', () => {
    const err = adapterError(429, 'monthly spending limit — slow down');
    expect(classifyProviderFailure(err, FIREWORKS)).toBeNull();
  });

  it('a 5xx server error is never billing', () => {
    expect(classifyProviderFailure(adapterError(503, 'upstream unavailable'), MISTRAL)).toBeNull();
  });

  it('an UNTRUSTED host body cannot forge a billing incident', () => {
    // Same "suspended" vocabulary, custom endpoint → NOT trusted → not billing.
    const err = adapterError(403, 'Account is suspended — insufficient credit balance');
    expect(classifyProviderFailure(err, CUSTOM)).toBeNull();
  });

  it('a trusted 4xx WITHOUT billing vocabulary is not billing', () => {
    const err = anthropicError(400, 'invalid_request_error', 'messages: at least one message is required');
    expect(classifyProviderFailure(err, ANTHROPIC)).toBeNull();
  });

  it('a transport error (no HTTP status) is not billing', () => {
    expect(classifyProviderFailure(new Error('fetch failed'), ANTHROPIC)).toBeNull();
    expect(classifyProviderFailure(new Error('terminated'), FIREWORKS)).toBeNull();
  });

  it('a non-Error value is not billing', () => {
    expect(classifyProviderFailure('boom', ANTHROPIC)).toBeNull();
    expect(classifyProviderFailure(undefined, FIREWORKS)).toBeNull();
  });
});
