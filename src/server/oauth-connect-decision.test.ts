import { describe, it, expect } from 'vitest';

import type { ApiProfile } from '../core/api-store.js';
import { decideConnect, isRefusal, type ConnectFacts, type ConnectRefusalKind } from './oauth-connect-decision.js';
import { presetRegisterOf, type PresetRegister } from '../core/oauth-presets.js';

// No module mock: the decision takes its register as a parameter, so a test
// hands in its own and production keeps the frozen, empty one. A seam that is a
// parameter needs no interception.
const REGISTER = presetRegisterOf([{
  id: 'example-shop',
  label: 'Example Shop',
  host: { kind: 'template', param: 'shop', template: '{shop}.shops.example.com' },
  authorizePath: '/admin/oauth/authorize',
  tokenPath: '/admin/oauth/access_token',
  params: [{ name: 'shop', pattern: /[a-z0-9][a-z0-9-]{0,59}/, describe: 'the shop name' }],
}]);

/** Every case here decides against the test register unless it brings its own. */
const decide = (facts: ConnectFacts, register = REGISTER): ReturnType<typeof decideConnect> =>
  decideConnect(facts, register);

const ACK = { accepted: true as const, hosts: ['acme.shops.example.com'], accepted_at: '2026-09-22T00:00:00.000Z' };

function profile(over: Partial<ApiProfile> = {}): ApiProfile {
  return {
    id: 'shop-api',
    name: 'Shop',
    base_url: 'https://acme.shops.example.com/admin',
    description: 'Shop API',
    auth: {
      type: 'oauth2',
      vault_keys: ['SHOP_CLIENT_ID'],
      oauth: { preset_id: 'example-shop', preset_params: { shop: 'acme' }, client_id_key: 'SHOP_CLIENT_ID', client_secret_key: 'SHOP_CLIENT_SECRET' },
    },
    custom_endpoint_ack: ACK,
    ...over,
  };
}

const good: ConnectFacts = {
  authenticated: true,
  fetchSite: 'same-origin',
  fetchDest: 'document',
  profile: profile(),
  httpSecretSet: true,
};

/**
 * One fixture per way the route refuses before it mints anything.
 *
 * Typed as a total record: a new refusal kind fails to compile until it has a
 * case here. And the table is iterated below rather than merely declared —
 * a complete table nobody runs passes the compiler and checks nothing.
 */
const BEFORE_MINT: Record<ConnectRefusalKind, ConnectFacts> = {
  'no-session': { ...good, authenticated: false },
  'inside-network': { ...good, profile: profile({ custom_endpoint_ack: undefined }) },
  'no-fetch-metadata': { ...good, fetchSite: undefined, fetchDest: undefined },
  'cross-site': { ...good, fetchSite: 'cross-site' },
  'not-a-document': { ...good, fetchDest: 'empty' },
  'unknown-profile': { ...good, profile: undefined },
  'not-oauth2': { ...good, profile: profile({ auth: { type: 'bearer', vault_keys: ['SHOP_TOKEN'] } }) },
  'no-preset': (() => {
    const p = profile();
    return { ...good, profile: { ...p, auth: { ...p.auth!, oauth: { ...p.auth!.oauth!, preset_id: 'nope' } } } };
  })(),
  'bad-preset-param': (() => {
    const p = profile();
    return { ...good, profile: { ...p, auth: { ...p.auth!, oauth: { ...p.auth!.oauth!, preset_params: {} } } } };
  })(),
  'no-egress-ack': { ...good, profile: profile({ custom_endpoint_ack: undefined }) },
  'no-http-secret': { ...good, httpSecretSet: false },
};

describe('the start route decides everything before it mints anything', () => {
  // One row needs a provider the shipped register cannot express; the seam is a
  // parameter, so the table carries the exception rather than a mock.
  const REGISTER_FOR: Partial<Record<ConnectRefusalKind, typeof REGISTER>> = {
    'inside-network': presetRegisterOf([{
      id: 'example-shop', label: 'LAN', host: { kind: 'constant', host: '169.254.169.254' },
      authorizePath: '/authorize', tokenPath: '/token', params: [],
    }]),
  };

  it.each(Object.entries(BEFORE_MINT))('refuses %s, and names no authorize URL', (kind, facts) => {
    const decision = decide(facts as ConnectFacts, REGISTER_FOR[kind as ConnectRefusalKind] ?? REGISTER);

    expect(isRefusal(decision)).toBe(true);
    if (!isRefusal(decision)) return;
    expect(decision.kind).toBe(kind);
    expect(decision.status).toBeGreaterThanOrEqual(400);
    // Nothing to mint against: a refusal carries no target, so the route has
    // nothing it could have written a cookie or a nonce for.
    expect(decision).not.toHaveProperty('authorizeUrl');
    expect(decision.message.length).toBeGreaterThan(20);
  });

  it('covers every refusal the type allows, and runs each one', () => {
    // The pairing that makes the table worth having: the compiler keeps it
    // complete, this keeps it used. Eleven today; a twelfth kind fails to compile
    // above and fails this count here.
    expect(Object.keys(BEFORE_MINT)).toHaveLength(11);
  });

  it('lets a click from this instance through, with the derived target', () => {
    const decision = decide(good);

    expect(isRefusal(decision)).toBe(false);
    if (isRefusal(decision)) return;
    expect(decision).toEqual({
      host: 'acme.shops.example.com',
      authorizeUrl: 'https://acme.shops.example.com/admin/oauth/authorize',
      tokenUrl: 'https://acme.shops.example.com/admin/oauth/access_token',
    });
  });

  it('lets an address-bar open through, which sends site=none', () => {
    expect(isRefusal(decide({ ...good, fetchSite: 'none' }))).toBe(false);
  });

  it('refuses same-site, which is a neighbouring host and not this one', () => {
    // `same-site` means the registrable domain matches — a sibling subdomain
    // counts, and a sibling is not this instance.
    const decision = decide({ ...good, fetchSite: 'same-site' });
    expect(isRefusal(decision) && decision.kind).toBe('cross-site');
  });

  it('asks the ack about the derived host, not the profile base_url', () => {
    // The fixture has to SEPARATE the two, or it cannot tell them apart: a
    // profile that calls one host and authorizes at another, with only the
    // first accepted. Asking about base_url would let this through, and the
    // user would be sent to a provider nobody accepted.
    const p = profile({
      base_url: 'https://api.acme-cdn.example/v1',
      custom_endpoint_ack: { ...ACK, hosts: ['api.acme-cdn.example'] },
    });
    const decision = decide({ ...good, profile: p });
    expect(isRefusal(decision) && decision.kind).toBe('no-egress-ack');
  });

  it('answers a cross-site open the same way whether or not the profile exists', () => {
    // The ordering that matters for what a refusal TELLS a caller. Fetch metadata
    // is judged before the store is consulted, so someone who opens the link from
    // another site learns that their open was wrong — not whether this instance
    // carries that profile. Only one of the nine orderings was pinned before; this
    // is the one where getting it backwards leaks something.
    const known = decide({ ...good, fetchSite: 'cross-site' });
    const unknown = decide({ ...good, fetchSite: 'cross-site', profile: undefined });

    expect(isRefusal(known) && known.kind).toBe('cross-site');
    expect(isRefusal(unknown) && unknown.kind).toBe('cross-site');
    expect(isRefusal(known) && isRefusal(unknown) && known.message).toBe(isRefusal(unknown) ? unknown.message : '');
  });

  it('refuses to send a browser to a host inside the operator network', () => {
    // The egress vetting says yes to `localhost` and `.local`, because for
    // OUTBOUND traffic a host in the operator's own network carries no
    // third-party exposure. A CONSENT SCREEN there is a different matter: the
    // user cannot judge it, and it is not the provider they think they are
    // authorizing. Nothing pinned that difference until this.
    const lan = presetRegisterOf([{
      id: 'example-shop', label: 'LAN', host: { kind: 'constant', host: 'localhost' },
      authorizePath: '/authorize', tokenPath: '/token', params: [],
    }]);
    const decision = decide({ ...good, profile: profile({ custom_endpoint_ack: undefined }) }, lan);

    expect(isRefusal(decision) && decision.kind).toBe('inside-network');
    // And the advice says what is actually possible — pinned as the SENTENCE,
    // not as a word. The first version of this line forbade the word `accept`
    // and failed against the very wording it was written to require: the
    // message uses it to say that nobody CAN accept this on your behalf. What
    // must be absent is the INSTRUCTION the neighbouring refusal gives, because
    // a private host never reaches the prompt that would stamp an acceptance,
    // so following it changes nothing.
    expect(isRefusal(decision) && decision.message).not.toMatch(/save the profile again/i);
    expect(isRefusal(decision) && decision.message).toContain('name a provider this engine knows');
  });

  it.each([
    ['the rest of 127/8', '127.0.0.2'],
    ['the metadata address', '169.254.169.254'],
    ['carrier-grade NAT', '100.64.0.1'],
    // The bracketed, NORMALISED spelling, and it has to be that one: measured
    // here rather than assumed, `new URL('https://::ffff:127.0.0.1/')` throws
    // and `https://[::ffff:127.0.0.1]/` comes back with hostname
    // `[::ffff:7f00:1]`. Both are refused — one commit earlier than this check,
    // by the host-identity rule in `derivePresetEndpoints` — which is why the
    // fixture below carries the only spelling that actually REACHES the
    // inside-network branch. The sibling case pins the other two.
    ['IPv4-mapped loopback', '[::ffff:7f00:1]'],
  ])('refuses a redirect to %s, which a five-string set missed', (_label, host) => {
    // The first version of this rule listed five literal hosts and leaned on the
    // private-LAN patterns for everything else. Those cover RFC1918 in dotted
    // quad and three suffixes — not these four.
    const inside = presetRegisterOf([{
      id: 'example-shop', label: 'inside', host: { kind: 'constant', host },
      authorizePath: '/authorize', tokenPath: '/token', params: [],
    }]);
    const decision = decide({ ...good, profile: profile({ custom_endpoint_ack: undefined }) }, inside);

    expect(isRefusal(decision) && decision.kind).toBe('inside-network');
  });

  it.each([
    ['unbracketed, which no URL parser accepts as a host', '::ffff:127.0.0.1'],
    ['bracketed but not normalised, which the parser rewrites', '[::ffff:127.0.0.1]'],
  ])('refuses %s before the network question is even asked', (_label, host) => {
    // The same address in two spellings that never reach `isPrivateIP`, and the
    // refusal they DO get is the honest one to assert. `derivePresetEndpoints`
    // requires the derived host to survive a round trip through the URL parser
    // unchanged, and neither spelling does: the first throws, the second comes
    // back as `[::ffff:7f00:1]`. Writing `inside-network` here would have been a
    // test that passes for a reason it does not state — the defence is the host
    // identity rule, one layer earlier, and if that rule is ever relaxed this
    // case goes red instead of quietly moving to another branch.
    const inside = presetRegisterOf([{
      id: 'example-shop', label: 'inside', host: { kind: 'constant', host },
      authorizePath: '/authorize', tokenPath: '/token', params: [],
    }]);
    const decision = decide({ ...good, profile: profile({ custom_endpoint_ack: undefined }) }, inside);

    expect(isRefusal(decision) && decision.kind).toBe('bad-preset-param');
  });

  it('refuses an unauthenticated open before it says whether the profile exists', () => {
    // The ordering that decides what an anonymous caller learns. Fetch metadata
    // cannot answer WHO — `none` is an address-bar open — so identity comes
    // first, and a request without a session gets the same answer whether or not
    // the id names anything here.
    const known = decide({ ...good, authenticated: false });
    const unknown = decide({ ...good, authenticated: false, profile: undefined });

    expect(isRefusal(known) && known.kind).toBe('no-session');
    expect(isRefusal(unknown) && unknown.kind).toBe('no-session');
    expect(isRefusal(known) && isRefusal(unknown) && known.message === unknown.message).toBe(true);
  });

  it('checks the secret last, so a wrong link never reports a server fault', () => {
    // Order matters for what the user sees: a cross-site open on an engine
    // without the secret is the user's cross-site open, not a 500.
    const decision = decide({ ...good, fetchSite: 'cross-site', httpSecretSet: false });
    expect(isRefusal(decision) && decision.kind).toBe('cross-site');
  });
});
