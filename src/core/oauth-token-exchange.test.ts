import { describe, it, expect, vi, afterEach } from 'vitest';

const fetchWithValidatedRedirects = vi.fn();
const readBodyLimited = vi.fn();
vi.mock('../tools/builtin/http.js', () => ({ fetchWithValidatedRedirects, readBodyLimited }));

const {
  exchangeToken, vetTokenEndpoint, isTokenEndpointRefused, TOKEN_EXCHANGE_TIMEOUT_MS,
} = await import('./oauth-token-exchange.js');

afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

/** A vetted endpoint, obtained the only way there is to obtain one. */
function vetted(url = 'https://api.openai.com/oauth/token') {
  const v = vetTokenEndpoint(url, undefined);
  if (isTokenEndpointRefused(v)) throw new Error(`fixture is not vetted: ${url}`);
  return v;
}

describe('vetTokenEndpoint — the gate that used to live in the tool', () => {
  it('admits a baseline host', () => {
    expect(isTokenEndpointRefused(vetTokenEndpoint('https://api.openai.com/x', undefined))).toBe(false);
  });

  it('refuses a host nobody vetted or accepted', () => {
    const v = vetTokenEndpoint('https://tokens.example.invalid/x', undefined);
    expect(isTokenEndpointRefused(v)).toBe(true);
  });

  it('admits an unvetted host the profile explicitly accepted', () => {
    const ack = { accepted: true as const, hosts: ['tokens.example.invalid'] };
    expect(isTokenEndpointRefused(
      vetTokenEndpoint('https://tokens.example.invalid/x', ack),
    )).toBe(false);
    // Control: the same ack does not admit a DIFFERENT host, so the pass above
    // is the ack matching and not the ack merely existing.
    expect(isTokenEndpointRefused(
      vetTokenEndpoint('https://other.example.invalid/x', ack),
    )).toBe(true);
  });

  it('is fail-closed on an ack that does not say `accepted`', () => {
    // Found by this suite's own first fixture, which omitted the flag and was
    // refused. Kept because the refusal is the behaviour worth pinning: a
    // half-written acceptance is not an acceptance.
    const halfWritten = { hosts: ['tokens.example.invalid'] } as never;
    expect(isTokenEndpointRefused(
      vetTokenEndpoint('https://tokens.example.invalid/x', halfWritten),
    )).toBe(true);
  });

  it('names the host and never the whole value', () => {
    // The raw value can hold anything somebody pasted, including a credential,
    // and this string reaches a model's context or a browser page.
    const v = vetTokenEndpoint('https://user:hunter2@tokens.example.invalid/x?k=sec', undefined);
    expect(isTokenEndpointRefused(v)).toBe(true);
    if (!isTokenEndpointRefused(v)) return;
    expect(v.host).toBe('tokens.example.invalid');
    expect(v.host).not.toContain('hunter2');
    expect(v.host).not.toContain('sec');
  });

  it('refuses rather than throwing when the value is not a URL', () => {
    const v = vetTokenEndpoint('not a url', undefined);
    expect(isTokenEndpointRefused(v)).toBe(true);
    if (isTokenEndpointRefused(v)) expect(v.host).toBe('not a url');
  });
});

describe('onRequestSent — charged when the provider was REACHED, not when it answered fully', () => {
  // ── Why this test exists ──────────────────────────────────────────────
  //
  // The extraction moved one statement into a callback, and its POSITION is
  // the property: after the fetch resolves, before the body is read. A refuter
  // measured what pinned that position and found nothing — moving the call
  // after the body read left 408 tests green, because every test that drives
  // the counter also drives a complete response body, and a complete body
  // cannot tell the two placements apart.
  //
  // The failure the wrong position enables: the response arrives, so the
  // provider WAS reached, the body read then hits the wall timer, and the
  // request is never charged. Repeated exchanges against a slow-body endpoint
  // would not consume the per-session HTTP cap — the freebie bypass the
  // increment exists to prevent.

  it('charges the request when the response arrived but the body never finishes', async () => {
    vi.useFakeTimers();
    try {
      fetchWithValidatedRedirects.mockResolvedValue({ response: { status: 200, ok: true } });
      // Never settles. This is what a dripping body looks like to this module,
      // and it is why the wall timer exists at all.
      readBodyLimited.mockReturnValue(new Promise(() => { /* never */ }));

      const charged = vi.fn();
      const pending = exchangeToken(
        { endpoint: vetted(), params: { grant_type: 'authorization_code' }, bodyFormat: 'form' },
        undefined,
        charged,
      );
      await vi.advanceTimersByTimeAsync(TOKEN_EXCHANGE_TIMEOUT_MS + 1_500);
      const result = await pending;

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('timed out');
      // The discriminating assertion: charged even though nothing was read.
      expect(charged).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not charge a request that never reached the provider', async () => {
    fetchWithValidatedRedirects.mockRejectedValue(new Error('Blocked: deny-all'));
    const charged = vi.fn();
    const result = await exchangeToken(
      { endpoint: vetted(), params: {}, bodyFormat: 'form' },
      undefined,
      charged,
    );
    expect(result.ok).toBe(false);
    expect(charged).not.toHaveBeenCalled();
  });

  it('charges exactly once on the ordinary path', async () => {
    fetchWithValidatedRedirects.mockResolvedValue({ response: { status: 200, ok: true } });
    readBodyLimited.mockResolvedValue({ text: '{"access_token":"at"}', truncated: false });
    const charged = vi.fn();
    const result = await exchangeToken(
      { endpoint: vetted(), params: {}, bodyFormat: 'form' },
      undefined,
      charged,
    );
    expect(result).toEqual({ ok: true, status: 200, responseOk: true, text: '{"access_token":"at"}' });
    expect(charged).toHaveBeenCalledTimes(1);
  });
});

describe('the body the provider receives', () => {
  it('form-encodes by default, and encodes each key and value', async () => {
    fetchWithValidatedRedirects.mockResolvedValue({ response: { status: 200, ok: true } });
    readBodyLimited.mockResolvedValue({ text: '{}', truncated: false });
    await exchangeToken(
      { endpoint: vetted(), params: { grant_type: 'authorization_code', code: 'a b&c' }, bodyFormat: 'form' },
      undefined,
    );
    const init = fetchWithValidatedRedirects.mock.calls[0]?.[1] as { body: string; headers: Record<string, string> };
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.body).toBe('grant_type=authorization_code&code=a%20b%26c');
  });

  it('sends JSON when the profile says so', async () => {
    fetchWithValidatedRedirects.mockResolvedValue({ response: { status: 200, ok: true } });
    readBodyLimited.mockResolvedValue({ text: '{}', truncated: false });
    await exchangeToken(
      { endpoint: vetted(), params: { grant_type: 'refresh_token' }, bodyFormat: 'json' },
      undefined,
    );
    const init = fetchWithValidatedRedirects.mock.calls[0]?.[1] as { body: string; headers: Record<string, string> };
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"grant_type":"refresh_token"}');
  });

  it('declares the full-control surface, which is what the policy grades', async () => {
    fetchWithValidatedRedirects.mockResolvedValue({ response: { status: 200, ok: true } });
    readBodyLimited.mockResolvedValue({ text: '{}', truncated: false });
    await exchangeToken({ endpoint: vetted(), params: {}, bodyFormat: 'form' }, undefined);
    expect(fetchWithValidatedRedirects.mock.calls[0]?.[2]).toMatchObject({ surface: 'full-control' });
  });
});

describe('a non-2xx is handed back, not interpreted', () => {
  it('returns the status and the text so the caller can decide what it means', async () => {
    // A 400 is `invalid_grant` to one caller and a misconfigured client to
    // another. This module must not choose.
    fetchWithValidatedRedirects.mockResolvedValue({ response: { status: 400, ok: false } });
    readBodyLimited.mockResolvedValue({ text: '{"error":"invalid_grant"}', truncated: false });
    const result = await exchangeToken({ endpoint: vetted(), params: {}, bodyFormat: 'form' }, undefined);
    expect(result).toEqual({ ok: true, status: 400, responseOk: false, text: '{"error":"invalid_grant"}' });
  });
});
