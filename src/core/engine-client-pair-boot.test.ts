import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from './engine.js';
import { SecretVault } from './secret-vault.js';
import { reloadConfig } from './config.js';
import type { LynoxConfig } from '../types/index.js';

/**
 * The BOOT proof for the Google client pair.
 *
 * `google-client-pair.test.ts` proves the resolver decides correctly. That is not
 * the property that broke: the old code resolved each half through a DIFFERENT
 * mechanism — the store for the id, the `?? process.env` tail for the secret — and
 * a unit test of a resolver cannot see which mechanism `init()` actually reaches
 * for. Point the engine back at the store and every resolver test stays green.
 *
 * So this boots a real Engine against a tmp data dir and asserts what the engine
 * HANDED TO `createGoogleTools`: the source it chose and, for the case that
 * matters, the secret VALUE. A resolver that returns the vault id with the env
 * secret still reports `source: 'vault'` — the value is the assertion.
 */
const captured = vi.hoisted(() => ({ calls: [] as { clientId: string; clientSecret: string }[] }));
vi.mock('../integrations/google/index.js', () => ({
  createGoogleTools: (opts: { clientId: string; clientSecret: string }) => {
    captured.calls.push({ clientId: opts.clientId, clientSecret: opts.clientSecret });
    return { tools: [], auth: { isAuthenticated: () => false } };
  },
}));

describe('Engine boot — the Google client pair is resolved from ONE source', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_VAULT_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
    'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE'] as const;
  const saved = new Map<string, string | undefined>();

  function setEnv(key: string, value: string | undefined): void {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    saved.clear();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    captured.calls.length = 0;
    reloadConfig();
  });

  function freshDataDir(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `lynox-${label}-`));
    dirs.push(dir);
    // Clear every marker: one leaked from the ambient environment would make a
    // self-host case silently assert the managed path.
    for (const k of ENV_KEYS) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    return dir;
  }

  async function boot(): Promise<Engine> {
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    return engine;
  }

  it('env pair only → source is env, and the env values are what got built', async () => {
    freshDataDir('cp-env');
    setEnv('GOOGLE_CLIENT_ID', 'env-id');
    setEnv('GOOGLE_CLIENT_SECRET', 'env-secret');
    const engine = await boot();
    expect(engine.getGoogleClientSource()).toBe('env');
    expect(captured.calls.at(-1)).toEqual({ clientId: 'env-id', clientSecret: 'env-secret' });
  });

  it('an env pair on a provisioned instance is the managed broker', async () => {
    freshDataDir('cp-broker');
    setEnv('GOOGLE_CLIENT_ID', 'env-id');
    setEnv('GOOGLE_CLIENT_SECRET', 'env-secret');
    setEnv('LYNOX_MANAGED_INSTANCE_ID', 'inst_boot');
    const engine = await boot();
    expect(engine.isGoogleManagedBroker()).toBe(true);
  });

  it('an empty env id leaves Google unbuilt — `??` would have passed it through', async () => {
    freshDataDir('cp-empty');
    setEnv('GOOGLE_CLIENT_ID', '');           // the self-host compose default
    setEnv('GOOGLE_CLIENT_SECRET', 'env-secret');
    const engine = await boot();
    expect(engine.getGoogleClientSource()).toBeNull();
    expect(captured.calls).toHaveLength(0);
  });

  it('BOTH sources → the vault wins, and the built secret is the VAULT secret', async () => {
    // THE case. The old readers took the id from the vault and the secret from the
    // environment, because the store preloads only the secret and never consents it.
    // Asserting `source === 'vault'` alone would pass against that defect — the id
    // did come from the vault. The secret value is what makes this test real, and
    // it is red against any resolver that reads through SecretStore.
    freshDataDir('cp-both');
    setEnv('LYNOX_VAULT_KEY', 'test-vault-key-for-boot-0000000000');
    const seed = new SecretVault();
    seed.set('GOOGLE_CLIENT_ID', 'vault-id');
    seed.set('GOOGLE_CLIENT_SECRET', 'vault-secret');

    setEnv('GOOGLE_CLIENT_ID', 'env-id');
    setEnv('GOOGLE_CLIENT_SECRET', 'env-secret');

    const engine = await boot();
    expect(engine.getGoogleClientSource()).toBe('vault');
    expect(captured.calls.at(-1)).toEqual({ clientId: 'vault-id', clientSecret: 'vault-secret' });
    // And a managed tenant running their own client is NOT the broker.
    expect(engine.isGoogleManagedBroker()).toBe(false);
  });

  it('no pair anywhere → nothing built, no source', async () => {
    freshDataDir('cp-none');
    const engine = await boot();
    expect(engine.getGoogleClientSource()).toBeNull();
    expect(captured.calls).toHaveLength(0);
  });
});
