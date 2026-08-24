import { describe, it, expect } from 'vitest';
import { resolveClientPair, isManagedBrokerPair } from './google-client-pair.js';

const ID = 'GOOGLE_CLIENT_ID';
const SECRET = 'GOOGLE_CLIENT_SECRET';

/** A vault stub that answers only what it was given. */
function vaultOf(entries: Record<string, string>) {
  return { get: (name: string): string | null => entries[name] ?? null };
}

describe('resolveClientPair', () => {
  it('takes the env pair when only the env has both', () => {
    const out = resolveClientPair(ID, SECRET, { env: { [ID]: 'env-id', [SECRET]: 'env-secret' } });
    expect(out).toEqual({ clientId: 'env-id', clientSecret: 'env-secret', source: 'env' });
  });

  it('takes the vault pair when only the vault has both', () => {
    const out = resolveClientPair(ID, SECRET, { vault: vaultOf({ [ID]: 'v-id', [SECRET]: 'v-secret' }), env: {} });
    expect(out).toEqual({ clientId: 'v-id', clientSecret: 'v-secret', source: 'vault' });
  });

  it('takes the VAULT pair when both exist — and the vault SECRET, not the env one', () => {
    // The case the old readers got wrong, and the reason this function exists.
    // They resolved the id from the vault and the secret from the env, because
    // the store preloads only the secret and never consents it. The assertion
    // that matters is the secret: a resolver that returns the vault id with the
    // env secret satisfies `source === 'vault'` and is still the defect.
    const out = resolveClientPair(ID, SECRET, {
      vault: vaultOf({ [ID]: 'v-id', [SECRET]: 'v-secret' }),
      env: { [ID]: 'env-id', [SECRET]: 'env-secret' },
    });
    expect(out?.source).toBe('vault');
    expect(out?.clientSecret).toBe('v-secret');
    expect(out?.clientId).toBe('v-id');
  });

  it('never mixes: a half-filled vault falls through to the env pair entirely', () => {
    const out = resolveClientPair(ID, SECRET, {
      vault: vaultOf({ [ID]: 'v-id-only' }),
      env: { [ID]: 'env-id', [SECRET]: 'env-secret' },
    });
    expect(out).toEqual({ clientId: 'env-id', clientSecret: 'env-secret', source: 'env' });
  });

  it('never mixes: a half-filled env does not borrow the other half from the vault', () => {
    const out = resolveClientPair(ID, SECRET, {
      vault: vaultOf({ [SECRET]: 'v-secret-only' }),
      env: { [ID]: 'env-id' },
    });
    expect(out).toBeNull();
  });

  it('an empty env value does not SHADOW a good config pair', () => {
    // A deployment interpolating an unset var (`NAME=${NAME:-}`) yields ''. Under the
    // old `??` chain that empty string outranked config.json and Google was silently
    // not built. The old code did not hand '' to Google — the truthiness guard caught
    // that — it lost the working credential behind it.
    const out = resolveClientPair(ID, SECRET, {
      env: { [ID]: '', [SECRET]: '' },
      userConfig: { google_client_id: 'cfg-id', google_client_secret: 'cfg-secret' },
    });
    expect(out).toEqual({ clientId: 'cfg-id', clientSecret: 'cfg-secret', source: 'config' });
  });

  it('treats whitespace as absent', () => {
    const out = resolveClientPair(ID, SECRET, { env: { [ID]: '   ', [SECRET]: 'env-secret' } });
    expect(out).toBeNull();
  });

  it('falls back to userConfig only when neither real source has a pair', () => {
    const out = resolveClientPair(ID, SECRET, {
      env: {},
      userConfig: { google_client_id: 'cfg-id', google_client_secret: 'cfg-secret' },
    });
    expect(out).toEqual({ clientId: 'cfg-id', clientSecret: 'cfg-secret', source: 'config' });
  });

  it('prefers the env pair over userConfig, since config mirrors env and vault', () => {
    // config.ts copies env into userConfig and engine-init.ts copies the vault
    // secret into it, so userConfig can itself hold a mixed pair. It must never
    // win over a source that supplied both halves.
    const out = resolveClientPair(ID, SECRET, {
      env: { [ID]: 'env-id', [SECRET]: 'env-secret' },
      userConfig: { google_client_id: 'cfg-id', google_client_secret: 'cfg-secret' },
    });
    expect(out?.source).toBe('env');
  });

  it('returns null when nothing has a pair', () => {
    expect(resolveClientPair(ID, SECRET, { env: {} })).toBeNull();
  });
});

describe('isManagedBrokerPair', () => {
  const envSource = 'env' as const;

  it('is true for an env pair on a provisioned instance', () => {
    expect(isManagedBrokerPair(envSource, { LYNOX_MANAGED_INSTANCE_ID: 'inst_1' })).toBe(true);
  });

  it('is false for an env pair on self-host', () => {
    expect(isManagedBrokerPair(envSource, {})).toBe(false);
  });

  it('is false for a vault pair even on a provisioned instance', () => {
    // A managed tenant running their own Google client is BYO, not the broker —
    // the UI must not offer them the one-click broker button.
    expect(isManagedBrokerPair('vault', { LYNOX_MANAGED_INSTANCE_ID: 'inst_1' })).toBe(false);
  });

  it('is false when there is no pair at all', () => {
    expect(isManagedBrokerPair(null, { LYNOX_MANAGED_INSTANCE_ID: 'inst_1' })).toBe(false);
  });
});
