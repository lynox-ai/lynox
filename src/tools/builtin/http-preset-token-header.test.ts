import { describe, expect, it, vi } from 'vitest';
import type { OAuthPreset } from '../../core/oauth-presets.js';

// The header a built-in provider names for its token is checked like a profile's: a name that is
// not a header, or one that reshapes the request, carries nothing; `Authorization` stays Bearer.
// No shipped preset names such a header, so this file registers three that do.

vi.mock('../../core/oauth-presets.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../core/oauth-presets.js')>();
  const bexio = real.OAUTH_PRESETS.get('bexio');
  if (bexio === undefined) throw new Error('the real register no longer has bexio; rebuild this fixture');
  const named = (id: string, tokenHeaderName: string): OAuthPreset =>
    Object.freeze({ ...bexio, id, apiHosts: [`${id}.api.example`], tokenHeaderName });
  const backing = new Map<string, OAuthPreset>(real.OAUTH_PRESETS.ids().map((id) => [id, real.OAUTH_PRESETS.get(id)!] as const));
  for (const p of [named('bearer', 'Authorization'), named('shaping', 'X-Forwarded-Host'), named('broken', 'Not A Header')]) backing.set(p.id, p);
  const register = Object.freeze({ get: (id: string) => backing.get(id), ids: () => [...backing.keys()].sort() });
  return { ...real, OAUTH_PRESETS: register };
});

const { attachStoredCredential } = await import('./http.js');
const { accessTokenKey, ApiStore } = await import('../../core/api-store.js');
const { OWNER_PRINCIPAL } = await import('../../core/request-principal.js');

async function headersFor(presetId: string): Promise<Record<string, string>> {
  const host = `${presetId}.api.example`;
  const store = new ApiStore();
  const profile = {
    id: `${presetId}-api`, name: presetId, base_url: `https://${host}`, description: 'stub',
    auth: { type: 'oauth2' as const, oauth: { preset_id: presetId, client_id_key: 'P_CID', client_secret_key: 'P_CSECRET' } },
    custom_endpoint_ack: { accepted: true as const, hosts: [host], accepted_at: '2026-10-18T00:00:00.000Z' },
  };
  expect(store.register(profile)).toBe(true);
  const headers: Record<string, string> = {};
  await attachStoredCredential(`https://${host}/x`, headers, false, {
    apiStore: store,
    secretStore: { resolve: (n: string) => (n === accessTokenKey(profile.id) ? 'tok-value' : null) } as never,
    principal: OWNER_PRINCIPAL, mandateEnds: undefined, secretReleases: undefined,
  });
  return headers;
}

describe('a token header a built-in provider names', () => {
  it('keeps Authorization as Bearer', async () => {
    expect(await headersFor('bearer')).toEqual({ Authorization: 'Bearer tok-value' });
  });

  it('attaches nothing under a header that reshapes the request', async () => {
    expect(await headersFor('shaping')).toEqual({});
  });

  it('attaches nothing under a name that is not a header', async () => {
    expect(await headersFor('broken')).toEqual({});
  });
});
