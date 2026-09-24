import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { signProfileOAuthState } from '../core/oauth-state-cookie.js';
import { profileOAuthCookieAttributes, authorizationCodeParams } from './http-api.js';

/**
 * The callback is the one route in this file's subject that an unauthenticated
 * stranger can reach: it is a top-level browser redirect from a provider, so
 * no session travels with it. These cases are therefore about what it REFUSES,
 * which is the half a stranger can exercise.
 *
 * ⚠ **What is not covered HERE is a property of this file, not of the tooling
 * — and that sentence used to read the other way.** It said the successful
 * round-trip "needs a provisioned profile, vault credentials and a provider to
 * answer, and this harness has none of the three", which presented a choice as
 * a limit. It is reachable: `http-api.test.ts` already swaps `getApiStore` and
 * `getSecretStore` through the engine mock, `derivePresetEndpoints` carries a
 * register seam, and the exchange mocks like any other module. The success
 * path and the partial-write case live there now.
 *
 * What is true of THIS file is narrower: it boots a real engine on purpose, so
 * that the refusals below are measured against the server a stranger actually
 * meets rather than against a mock of it. Naming a gap as a property of the
 * tooling is how it stops being looked at.
 */

const PORT = 39_517;
const SECRET = 'callback-route-test-secret-value';
const CALLBACK = '/api/oauth/callback';
const COOKIE = 'lynox_profile_oauth_state';
const STATE = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const VERIFIER = 'v'.repeat(43);

let api: LynoxHTTPApi;
let server: Server | undefined;
let baseUrl: string;

/** A cookie this engine would itself have minted. */
function mintCookie(profileId = 'bexio', atSec = Math.floor(Date.now() / 1000)): string {
  const signed = signProfileOAuthState({ state: STATE, profileId, verifier: VERIFIER }, SECRET, atSec);
  if (signed === null) throw new Error('fixture could not be signed');
  return `${COOKIE}=${encodeURIComponent(signed)}`;
}

async function callback(query: string, cookie?: string): Promise<Response> {
  return fetch(`${baseUrl}${CALLBACK}${query}`, {
    redirect: 'manual',
    headers: cookie === undefined ? {} : { cookie },
  });
}

beforeAll(async () => {
  vi.stubEnv('LYNOX_HTTP_SECRET', SECRET);
  vi.stubEnv('LYNOX_ALLOW_PLAIN_HTTP', 'true');
  api = new LynoxHTTPApi();
  await api.init();
  server = await api.start(PORT);
  baseUrl = `http://127.0.0.1:${String(PORT)}`;
  for (let i = 0; i < 20; i++) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => { server ? server.close(() => { resolve(); }) : resolve(); });
  vi.unstubAllEnvs();
});

describe('what a stranger gets', () => {
  // Each of these is a way of arriving without a valid round-trip. They all
  // answer the SAME text on purpose: which one failed is information about this
  // engine's state, and whoever reaches this page without a cookie is not the
  // person who started the flow.
  it.each([
    ['no cookie at all', `?code=c&state=${STATE}`, undefined],
    ['a cookie that is not ours', `?code=c&state=${STATE}`, `${COOKIE}=not-a-signed-value`],
    ['a cookie with a tampered signature', `?code=c&state=${STATE}`,
      // Stamped NOW on purpose. With a stale timestamp the TTL refuses it before
      // the signature is ever computed, and the case silently stops being about
      // the signature at all — which is what it said on the label for one revision.
      `${COOKIE}=${STATE}.bexio.${VERIFIER}.${String(Math.floor(Date.now() / 1000))}.dead`],
    ['no code', `?state=${STATE}`, mintCookie()],
    ['no state', '?code=c', mintCookie()],
    ['a state that does not match the cookie', '?code=c&state=3f2504e0-4f89-11d3-9a0c-0305e82c3302', mintCookie()],
  ])('refuses %s', async (_label, query, cookie) => {
    const res = await callback(query, cookie);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('no longer valid');
    // The refusal never says which of the five it was, and never echoes a value.
    expect(body).not.toContain('bexio');
    expect(body).not.toContain(STATE);
  });

  it('refuses an expired cookie although its signature is valid', async () => {
    // Eleven minutes old against a ten-minute TTL. The signature still verifies;
    // the age is what refuses it, which is the property the TTL exists for.
    const old = mintCookie('bexio', Math.floor(Date.now() / 1000) - 11 * 60);
    const res = await callback(`?code=c&state=${STATE}`, old);
    expect(res.status).toBe(400);
  });

  it('clears the cookie when it refuses, so a reload does not retry', async () => {
    const res = await callback('?code=c&state=wrong', mintCookie());
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(COOKIE);
    expect(setCookie).toContain('Max-Age=0');
    // Path-scoped even when clearing: a clear on a different path leaves the
    // real cookie in place and looks like it worked.
    expect(setCookie).toContain(`Path=${CALLBACK}`);
  });

  it('tells a declining user something different from a broken link', async () => {
    // `error` is the provider's ordinary "the human said no". Reading it as a
    // tampered request would blame the user for a choice they made.
    const res = await callback('?error=access_denied');
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('did not complete');
  });
});

describe('the shape of the page itself', () => {
  it('is HTML with no script, because the API sends `default-src none`', async () => {
    const res = await callback('?code=c&state=x');
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).not.toContain('<script');
  });

  it('is not cached, because the url it was reached by carries a code', async () => {
    const res = await callback('?code=c&state=x');
    expect(res.headers.get('cache-control')).toContain('no-store');
  });
});

describe('the inputs that made this route answer 500', () => {
  it('refuses a state whose UTF-8 length differs from its JS length, with 400 and not 500', async () => {
    // `String.length` counts UTF-16 code units, `Buffer.from` produces UTF-8
    // bytes. A 36-character state carrying one non-ASCII character passed a
    // string-length pre-check and then made `timingSafeEqual` throw, so the
    // route answered 500 with a JSON body and an UNCLEARED cookie — instead of
    // the uniform 400 every other malformed arrival gets.
    const sneaky = `${'a'.repeat(35)}\u00e9`;
    expect(sneaky).toHaveLength(36);
    expect(Buffer.from(sneaky)).toHaveLength(37);

    const res = await callback(`?code=c&state=${encodeURIComponent(sneaky)}`, mintCookie());
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('set-cookie') ?? '').toContain('Max-Age=0');
  });

  it('clears the cookie when the provider says the user declined', async () => {
    // A declining user is a FINISHED round-trip, not an interrupted one. This
    // path returned before any clear for one revision, so the next top-level
    // navigation could retry a flow the person had just refused.
    const res = await callback('?error=access_denied', mintCookie());
    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie') ?? '').toContain('Max-Age=0');
  });
});

describe('the attributes that ARE the mechanism', () => {
  it('carries Lax, HttpOnly, Secure and the callback path', () => {
    // `SameSite=Lax` is the whole bound the design names for the redirect hop,
    // and a probe flipped it to `None` with the entire suite staying green.
    const attrs = profileOAuthCookieAttributes();
    expect(attrs).toContain('SameSite=Lax');
    expect(attrs).toContain('HttpOnly');
    expect(attrs).toContain('Secure');
    expect(attrs).toContain('Path=/api/oauth/callback');
    // Not Strict: Strict drops the cookie on the provider's top-level
    // cross-site redirect, which is the one navigation this flow depends on.
    expect(attrs).not.toContain('SameSite=Strict');
  });

  it('is the same string the route actually sends', async () => {
    // Pinning a copy and shipping another is how an asserted attribute becomes
    // decoration. Read back off a live response.
    const res = await callback('?code=c&state=wrong', mintCookie());
    const setCookie = res.headers.get('set-cookie') ?? '';
    for (const part of profileOAuthCookieAttributes().split('; ')) {
      expect(setCookie).toContain(part);
    }
  });
});

describe('the exchange carries the PKCE pre-image', () => {
  it('sends code_verifier, which is what binds the code to the start', () => {
    // Deleting this field from the call site left the whole suite green,
    // because the exchange sits behind a profile this harness cannot build.
    const params = authorizationCodeParams({
      code: 'c', redirectUri: 'https://e/api/oauth/callback',
      clientId: 'id', clientSecret: 'sec', verifier: 'v'.repeat(43),
    });
    expect(params['code_verifier']).toBe('v'.repeat(43));
    expect(params['grant_type']).toBe('authorization_code');
    // The challenge belongs on the authorize URL and nowhere near here.
    expect(Object.keys(params)).not.toContain('code_challenge');
  });
});

// ⚠ LAST in this file on purpose. It spends the whole per-IP window, and every
// case after it then measures 429 instead of what it meant to measure — which
// is exactly what happened when it sat in the middle: three later cases failed
// and neither the route nor they were wrong. A test that consumes a SHARED
// budget changes what every later test is about.
describe('the route is charged against the client window', () => {
  it('answers 429 once the window is spent', async () => {
    // This route answers before the dispatch's shared charge point, so it
    // charges itself. Without that it would be the one path on this server
    // where repetition costs the caller nothing.
    //
    // Driven with a deliberately invalid request: the assertion is about the
    // counter, and a valid one would need a provisioned profile.
    let sawTooMany = false;
    let refusalsBefore = 0;
    for (let i = 0; i < 700; i++) {
      const res = await callback('?code=c&state=x');
      if (res.status === 429) { sawTooMany = true; break; }
      refusalsBefore++;
      await res.text();
    }
    expect(sawTooMany).toBe(true);
    // Positive control on the loop: it reached the ceiling by being charged,
    // not because every request already answered 429.
    expect(refusalsBefore).toBeGreaterThan(10);
  }, 60_000);
});
