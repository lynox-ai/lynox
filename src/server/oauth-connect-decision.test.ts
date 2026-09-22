import { describe, it, expect, vi } from 'vitest';
import type { ApiProfile } from '../core/api-store.js';
import { decideConnect, isRefusal, type ConnectFacts, type ConnectRefusalKind } from './oauth-connect-decision.js';

// The register ships empty, so the decision gets its provider the same way
// production would if one were decided: through the register, not the profile.
vi.mock('../core/oauth-presets.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../core/oauth-presets.js')>();
  const register = real.presetRegisterOf([{
    id: 'example-shop',
    label: 'Example Shop',
    host: { kind: 'template', param: 'shop', template: '{shop}.shops.example.com' },
    authorizePath: '/admin/oauth/authorize',
    tokenPath: '/admin/oauth/access_token',
    params: [{ name: 'shop', pattern: /[a-z0-9][a-z0-9-]{0,59}/, describe: 'the shop name' }],
  }]);
  return {
    ...real,
    derivePresetEndpoints: (id: string, params: Readonly<Record<string, unknown>> | undefined) =>
      real.derivePresetEndpoints(id, params, register),
    presetIds: () => register.ids(),
  };
});

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
  it.each(Object.entries(BEFORE_MINT))('refuses %s, and names no authorize URL', (kind, facts) => {
    const decision = decideConnect(facts as ConnectFacts);

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
    // complete, this keeps it used. Nine today; a tenth kind fails to compile
    // above and fails this count here.
    expect(Object.keys(BEFORE_MINT)).toHaveLength(9);
  });

  it('lets a click from this instance through, with the derived target', () => {
    const decision = decideConnect(good);

    expect(isRefusal(decision)).toBe(false);
    if (isRefusal(decision)) return;
    expect(decision).toEqual({
      host: 'acme.shops.example.com',
      authorizeUrl: 'https://acme.shops.example.com/admin/oauth/authorize',
      tokenUrl: 'https://acme.shops.example.com/admin/oauth/access_token',
    });
  });

  it('lets an address-bar open through, which sends site=none', () => {
    expect(isRefusal(decideConnect({ ...good, fetchSite: 'none' }))).toBe(false);
  });

  it('refuses same-site, which is a neighbouring host and not this one', () => {
    // `same-site` means the registrable domain matches — a sibling subdomain
    // counts, and a sibling is not this instance.
    const decision = decideConnect({ ...good, fetchSite: 'same-site' });
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
    const decision = decideConnect({ ...good, profile: p });
    expect(isRefusal(decision) && decision.kind).toBe('no-egress-ack');
  });

  it('checks the secret last, so a wrong link never reports a server fault', () => {
    // Order matters for what the user sees: a cross-site open on an engine
    // without the secret is the user's cross-site open, not a 500.
    const decision = decideConnect({ ...good, fetchSite: 'cross-site', httpSecretSet: false });
    expect(isRefusal(decision) && decision.kind).toBe('cross-site');
  });
});
