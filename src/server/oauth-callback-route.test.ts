import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { signProfileOAuthState } from '../core/oauth-state-cookie.js';

/**
 * The callback is the one route in this file's subject that an unauthenticated
 * stranger can reach: it is a top-level browser redirect from a provider, so
 * no session travels with it. These cases are therefore about what it REFUSES,
 * which is the half a stranger can exercise.
 *
 * ⚠ What is NOT covered here, said rather than implied: the successful
 * round-trip. Completing one needs a provisioned profile, vault credentials and
 * a provider to answer, and this harness starts a real server without any of
 * the three. The exchange itself is covered at its own seam
 * (`core/oauth-token-exchange.test.ts`); what stays untested end to end is the
 * wiring between a verified cookie and a stored token.
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
    ['a cookie with a tampered payload', `?code=c&state=${STATE}`, `${COOKIE}=${STATE}.bexio.${VERIFIER}.1700000000.dead`],
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
