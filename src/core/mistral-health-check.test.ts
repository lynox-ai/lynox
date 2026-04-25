import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkMistralAccountHealth } from './mistral-health-check.js';

describe('checkMistralAccountHealth', () => {
  const originalKey = process.env['MISTRAL_API_KEY'];
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env['MISTRAL_API_KEY'] = 'test-key';
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env['MISTRAL_API_KEY'];
    else process.env['MISTRAL_API_KEY'] = originalKey;
    vi.unstubAllGlobals();
  });

  it('returns no_key when MISTRAL_API_KEY is unset', async () => {
    delete process.env['MISTRAL_API_KEY'];
    const result = await checkMistralAccountHealth();
    expect(result).toEqual({ status: 'no_key' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns no_key when MISTRAL_API_KEY is empty string', async () => {
    process.env['MISTRAL_API_KEY'] = '';
    const result = await checkMistralAccountHealth();
    expect(result).toEqual({ status: 'no_key' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns ok on HTTP 200', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const result = await checkMistralAccountHealth();
    expect(result).toEqual({ status: 'ok' });
  });

  it('maps HTTP 401 to invalid_key', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"bad token"}', { status: 401 }));
    const result = await checkMistralAccountHealth();
    expect(result).toEqual({ status: 'invalid_key', httpStatus: 401 });
  });

  it('maps HTTP 402 to no_credits — the bug Rafael hit on 2026-04-24', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"insufficient credits"}', { status: 402 }));
    const result = await checkMistralAccountHealth();
    expect(result).toEqual({ status: 'no_credits', httpStatus: 402 });
  });

  it('maps HTTP 429 to rate_limited', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"rate limit"}', { status: 429 }));
    const result = await checkMistralAccountHealth();
    expect(result).toEqual({ status: 'rate_limited', httpStatus: 429 });
  });

  it('maps other 5xx to http_error and truncates the body to 200 chars', async () => {
    const longBody = 'X'.repeat(500);
    fetchMock.mockResolvedValue(new Response(longBody, { status: 503 }));
    const result = await checkMistralAccountHealth();
    expect(result.status).toBe('http_error');
    if (result.status === 'http_error') {
      expect(result.httpStatus).toBe(503);
      expect(result.body.length).toBe(200);
    }
  });

  it('returns network_error when fetch throws', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await checkMistralAccountHealth();
    expect(result.status).toBe('network_error');
    if (result.status === 'network_error') {
      expect(result.message).toContain('ECONNREFUSED');
    }
  });

  it('sends Authorization: Bearer with the configured key', async () => {
    process.env['MISTRAL_API_KEY'] = 'sk-mistral-secret';
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    await checkMistralAccountHealth();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe('https://api.mistral.ai/v1/models');
    const init = call?.[1] as RequestInit;
    expect(init.method).toBe('GET');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-mistral-secret');
  });
});
