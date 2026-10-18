import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OAuthPreset } from '../../core/oauth-presets.js';

// A preset that names its token endpoint's body format wins over the profile's in `fetch_token`.
// The shipped preset that names one is Shopify's, whose store this engine does not reach yet, so
// this file gives bexio a format of its own and watches the request it posts.

vi.mock('node:dns/promises', () => ({ default: { lookup: vi.fn().mockResolvedValue([{ address: '1.2.3.4', family: 4 }]) } }));

let lynoxDir = '';
vi.mock('../../core/config.js', () => ({ getLynoxDir: () => lynoxDir }));

vi.mock('../../core/oauth-presets.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../core/oauth-presets.js')>();
  const bexio = real.OAUTH_PRESETS.get('bexio');
  if (bexio === undefined) throw new Error('the real register no longer has bexio; rebuild this fixture');
  const jsonBexio: OAuthPreset = Object.freeze({ ...bexio, tokenBodyFormat: 'json' as const });
  const backing = new Map<string, OAuthPreset>(real.OAUTH_PRESETS.ids().map((id) => [id, real.OAUTH_PRESETS.get(id)!] as const));
  backing.set('bexio', jsonBexio);
  const register = Object.freeze({ get: (id: string) => backing.get(id), ids: () => [...backing.keys()].sort() });
  return { ...real, OAUTH_PRESETS: register };
});

const { apiSetupTool } = await import('./api-setup.js');
const { ApiStore } = await import('../../core/api-store.js');
const { setPinnedTransportForTests } = await import('../../core/network-guard.js');
const { OWNER_PRINCIPAL } = await import('../../core/request-principal.js');

let restore: (() => void) | undefined;
beforeEach(() => {
  lynoxDir = mkdtempSync(join(tmpdir(), 'lynox-preset-body-'));
  restore = setPinnedTransportForTests(async (input) => {
    const init: RequestInit = { method: input.method, headers: input.headers };
    if (input.body !== undefined) init.body = input.body.toString('utf8');
    return (globalThis.fetch as typeof fetch)(input.url, init);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  restore?.();
  rmSync(lynoxDir, { recursive: true, force: true });
});

describe('fetch_token — the body format a preset names', () => {
  it('posts the preset\'s format whatever the profile says', async () => {
    const store = new ApiStore();
    expect(store.register({
      id: 'crm-api', name: 'CRM', base_url: 'https://api.bexio.com/2.0', description: 'CRM',
      auth: { type: 'oauth2', vault_keys: ['CRM_CLIENT_ID', 'CRM_CLIENT_SECRET'], oauth: { preset_id: 'bexio', grant_type: 'refresh_token', body_format: 'form', client_id_key: 'CRM_CLIENT_ID', client_secret_key: 'CRM_CLIENT_SECRET' } },
      custom_endpoint_ack: { accepted: true, hosts: ['api.bexio.com', 'auth.bexio.com'], accepted_at: '2026-10-18T00:00:00.000Z' },
    })).toBe(true);
    const vault: Record<string, string> = { CRM_CLIENT_ID: 'client-1', CRM_CLIENT_SECRET: 'secret-1', CRM_API_REFRESH_TOKEN: 'rt-1' };
    const agent = {
      principal: OWNER_PRINCIPAL,
      sessionCounters: { httpRequests: 0 },
      secretStore: { resolve: (n: string) => vault[n] ?? null, set: (n: string, v: string) => { vault[n] = v; }, listNames: () => Object.keys(vault),
        // fetch_token reads through `secret:NAME` references, as the real store resolves them.
        resolveSecretRefs: (x: unknown) => JSON.parse(JSON.stringify(x).replace(/\bsecret:([A-Z_][A-Z0-9_]*)\b/g, (m, n: string) => vault[n] ?? m)) as unknown },
      getAvailableTools: () => [{ definition: { name: 'api_setup' } }],
      toolContext: { apiStore: store, secretReleases: null, mandateEnds: null, allowedWildcards: [], hourlyRateLimit: Infinity, dailyRateLimit: Infinity },
    } as never;
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ access_token: 'at-2', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await apiSetupTool.handler({ action: 'fetch_token', id: 'crm-api' }, agent);

    expect(spy).toHaveBeenCalledTimes(1);
    const init = spy.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body)) as Record<string, string>).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt-1' });
  });
});
