import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAUTH_PRESETS, isPresetClientSecretName, presetClientKeys, presetRegisterOf } from './oauth-presets.js';
import { SecretStore, isProtectedSecretWrite, resolveSecretRefsWith } from './secret-store.js';
import type { SecretScope } from '../types/index.js';
import type { SecretVault } from './secret-vault.js';
import { askSecretTool } from '../tools/builtin/ask-secret.js';
import type { IAgent } from '../types/index.js';

// A built-in provider's OAuth client lives under names derived from the provider's id. The secret
// half is the engine's: the model does not see it listed, cannot reference it and cannot ask for it.

function vaulted(entries: Record<string, string>): SecretStore {
  const map = new Map(Object.entries(entries).map(([k, v]) => [k, { value: v, scope: 'any' as SecretScope, ttlMs: 0 }]));
  return new SecretStore(undefined, { getAll: () => map } as unknown as SecretVault);
}

const clean = (): void => {
  for (const key of Object.keys(process.env)) if (key.startsWith('LYNOX_SECRET_')) delete process.env[key];
};
beforeEach(clean);
afterEach(clean);

describe('presetClientKeys', () => {
  it('derives one pair per provider from its id', () => {
    expect(presetClientKeys('bexio')).toEqual({ id: 'BEXIO_CLIENT_ID', secret: 'BEXIO_CLIENT_SECRET' });
    expect(presetClientKeys('shopify')).toEqual({ id: 'SHOPIFY_CLIENT_ID', secret: 'SHOPIFY_CLIENT_SECRET' });
    expect(presetClientKeys('my-crm')).toEqual({ id: 'MY_CRM_CLIENT_ID', secret: 'MY_CRM_CLIENT_SECRET' });
  });

  it('derives no name of this instance\'s own credentials for any shipped provider', () => {
    for (const id of OAUTH_PRESETS.ids()) {
      const { id: cid, secret } = presetClientKeys(id);
      expect(isProtectedSecretWrite(cid), id).toBe(false);
      expect(isProtectedSecretWrite(secret), id).toBe(false);
    }
  });
});

describe('isPresetClientSecretName', () => {
  it.each([
    ['BEXIO_CLIENT_SECRET', true],
    ['SHOPIFY_CLIENT_SECRET', true],
    ['SHOPIFY_CLIENT_ID', false],
    ['FOO_CLIENT_SECRET', false],
    ['MY_APP_CLIENT_SECRET', false],
    ['SHOPIFY_CLIENT_SECRET_2', false],
    ['XSHOPIFY_CLIENT_SECRET', false],
  ] as const)('%s: %s', (name, want) => {
    expect(isPresetClientSecretName(name)).toBe(want);
  });

  it('follows the register it is given', () => {
    const register = presetRegisterOf([{ ...OAUTH_PRESETS.get('bexio')!, id: 'acme-books' }]);
    expect(isPresetClientSecretName('ACME_BOOKS_CLIENT_SECRET', register)).toBe(true);
    expect(isPresetClientSecretName('BEXIO_CLIENT_SECRET', register)).toBe(false);
  });
});

describe('the names the model is shown', () => {
  const store = (): SecretStore => vaulted({
    SHOPIFY_CLIENT_SECRET: 'shpss-value-1234',
    SHOPIFY_CLIENT_ID: 'client-id-1234',
    FOO_CLIENT_SECRET: 'own-value-1234',
  });

  it('leave out a provider\'s client secret, and keep its client id and an operator\'s own secret', () => {
    const names = store().listAgentVisibleNames();
    expect(names).not.toContain('SHOPIFY_CLIENT_SECRET');
    expect(names).toEqual(expect.arrayContaining(['SHOPIFY_CLIENT_ID', 'FOO_CLIENT_SECRET']));
  });

  it('offer no near match that is a provider\'s client secret', () => {
    expect(store().findNameMatches('SHOPIFYCLIENT_SECRET')).not.toContain('SHOPIFY_CLIENT_SECRET');
  });

  it('are the only list the model reads: the engine still resolves the secret', () => {
    const s = store();
    expect(s.resolve('SHOPIFY_CLIENT_SECRET')).toBe('shpss-value-1234');
    // The indirection `fetch_token` and `vaultHolds` use for client credentials.
    expect(s.resolveSecretRefs({ _: 'secret:SHOPIFY_CLIENT_SECRET' })).toEqual({ _: 'shpss-value-1234' });
  });
});

describe('the names a refusal reads are the names a resolution resolves', () => {
  // The agent refuses on `extractSecretNames`; the vault answers through `resolveSecretRefsWith`.
  // Whatever one resolves, the other must have named, in every shape the input can take.
  it.each([
    ['a header', { headers: { k: 'secret:SHOPIFY_CLIENT_SECRET' } }],
    ['a nested object', { body: { a: { b: { c: 'secret:SHOPIFY_CLIENT_SECRET' } } } }],
    ['an array', { body: ['x', ['y', 'secret:SHOPIFY_CLIENT_SECRET']] }],
    ['the middle of a long string', { body: `${'a '.repeat(2000)}secret:SHOPIFY_CLIENT_SECRET${' z'.repeat(2000)}` }],
    ['a key', { ['secret:SHOPIFY_CLIENT_SECRET']: 'v' }],
    ['next to punctuation', { body: '(secret:SHOPIFY_CLIENT_SECRET),' }],
  ])('in %s', (_label, input) => {
    const s = vaulted({ SHOPIFY_CLIENT_SECRET: 'shpss-value-1234' });
    const resolved: string[] = [];
    resolveSecretRefsWith(input, (n) => { resolved.push(n); return null; });
    expect(resolved).toContain('SHOPIFY_CLIENT_SECRET');
    for (const n of resolved) expect(s.extractSecretNames(input)).toContain(n);
  });
});

describe('ask_secret', () => {
  const agentWith = (promptSecret: ReturnType<typeof vi.fn>, secretStore?: SecretStore): IAgent =>
    ({ name: 't', model: 'm', memory: null, tools: [], onStream: null, promptSecret, ...(secretStore ? { secretStore } : {}) }) as unknown as IAgent;

  it.each([
    ['SHOPIFY_CLIENT_SECRET', 'SHOPIFY_CLIENT_SECRET'],
    ['BEXIO_CLIENT_SECRET', 'BEXIO_CLIENT_SECRET'],
  ])('does not ask for %s, stored or not, and names the place for %s', async (name, canonical) => {
    for (const store of [undefined, vaulted({ [name]: 'value-1234' })]) {
      const promptSecret = vi.fn().mockResolvedValue('saved');
      const result = await askSecretTool.handler({ name, prompt: 'Enter it' }, agentWith(promptSecret, store));
      expect(promptSecret).not.toHaveBeenCalled();
      expect(result).toContain(`"${canonical}" is the OAuth client secret of a built-in provider. The owner of this lynox instance enters it in the connection form of the profile under Settings → API Profiles`);
      // Sent by the engine only where a profile reads it: the sentence says so.
      expect(result).toContain(`for a profile that names "${canonical}" as its client secret and may read it.`);
    }
  });

  // A profile may name a spelling of its own; that name is the one it reads, so it is collected.
  it('asks for a name a profile could read that is not exactly a provider\'s', async () => {
    const promptSecret = vi.fn().mockResolvedValue('saved');
    await askSecretTool.handler({ name: 'SHOPIFY_CLIENTSECRET', prompt: 'Enter it' }, agentWith(promptSecret));
    expect(promptSecret).toHaveBeenCalledWith('SHOPIFY_CLIENTSECRET', 'Enter it', undefined);
  });

  it('asks for a client secret of the operator\'s own name', async () => {
    const promptSecret = vi.fn().mockResolvedValue('saved');
    await askSecretTool.handler({ name: 'FOO_CLIENT_SECRET', prompt: 'Enter it' }, agentWith(promptSecret));
    expect(promptSecret).toHaveBeenCalledWith('FOO_CLIENT_SECRET', 'Enter it', undefined);
  });

  it('does not list a provider\'s client secret', async () => {
    const result = await askSecretTool.handler({ action: 'list' }, agentWith(vi.fn(), vaulted({ SHOPIFY_CLIENT_SECRET: 'shpss-value-1234', SHOPIFY_CLIENT_ID: 'client-id-1234' })));
    expect(result).not.toContain('SHOPIFY_CLIENT_SECRET');
    expect(result).toContain('SHOPIFY_CLIENT_ID');
  });
});
