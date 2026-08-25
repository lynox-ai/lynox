import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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
    setEnv('GOOGLE_CLIENT_ID', '');           // an unset var interpolated to ''
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

  it('env id + vault secret builds NOTHING — the config tier must not re-assemble it', async () => {
    // The hole the first version of this change left open. userConfig used to be a
    // MIRROR: config.ts copied the env id into it and engine-init copied the vault
    // secret into it, so this exact split re-assembled one tier down and was reported
    // as source 'config' — a source that had never held a pair. Real path: an
    // operator rotates GOOGLE_CLIENT_ID in the environment while the old secret
    // sits in the vault, and gets PROJECT-B's id with PROJECT-A's secret, i.e.
    // invalid_client.
    freshDataDir('cp-crossmix');
    setEnv('LYNOX_VAULT_KEY', 'test-vault-key-for-boot-0000000000');
    const seed = new SecretVault();
    seed.set('GOOGLE_CLIENT_SECRET', 'PROJECT-A-secret');   // vault: secret only

    setEnv('GOOGLE_CLIENT_ID', 'PROJECT-B-id');             // env: id only

    const engine = await boot();
    expect(engine.getGoogleClientSource()).toBeNull();
    expect(captured.calls).toHaveLength(0);
  });

  it('config→vault migration is PAIR-ATOMIC: an old vault secret blocks it, and nothing is deleted', async () => {
    // The fix-round's own regression. The migration loop decides per FIELD: it skips
    // a name the vault already holds. With an old secret in the vault and the
    // operator's CURRENT pair in config.json, the secret entry was skipped, the id
    // was moved in beside the OLD secret, and the id was then deleted from
    // config.json — a vault pair assembled from two eras, and no way back because the
    // correct id was gone from disk. Destructive, and it manufactured exactly the
    // mixed pair this whole change exists to prevent.
    const dir = freshDataDir('cp-migrate');
    setEnv('LYNOX_VAULT_KEY', 'test-vault-key-for-boot-0000000000');
    const seed = new SecretVault();
    seed.set('GOOGLE_CLIENT_SECRET', 'PROJECT-A-secret');   // an older era, secret only

    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      google_client_id: 'PROJECT-B-id',
      google_client_secret: 'PROJECT-B-secret',
    }, null, 2) + '\n');

    const engine = await boot();

    // Nothing may be built from a pair assembled across the two eras.
    // No `if (built)` here, and that is the point: guarding the equality made it
    // stop firing in exactly the case where the config tier stops producing a
    // pair at all — the assert above still passes against `undefined`, so the
    // whole test went green with NOTHING built.
    const built = captured.calls.at(-1);
    expect(built, 'the config pair must reach createGoogleTools').toBeDefined();
    expect(built?.clientSecret).not.toBe('PROJECT-A-secret');
    expect(built).toEqual({ clientId: 'PROJECT-B-id', clientSecret: 'PROJECT-B-secret' });
    expect(engine.getGoogleClientSource()).not.toBe('vault');

    // And config.json must still hold the operator's pair — it is the only copy.
    const after = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8')) as Record<string, unknown>;
    expect(after['google_client_id']).toBe('PROJECT-B-id');
    expect(after['google_client_secret']).toBe('PROJECT-B-secret');
  });

  it('reloadGoogle resolves the CONFIG tier when the migration was blocked', async () => {
    // Its own test rather than an appendix to the one above: a reload defect
    // reporting under "migration is PAIR-ATOMIC" sends the reader to the wrong
    // code. The setup is repeated on purpose — sharing it would couple a
    // destructive-migration regression to a reload regression.
    //
    // The config tier only reaches a reload where the config→vault migration did
    // NOT run, and it is conditional (engine-init.ts: vault holds neither,
    // config holds both, env holds neither). An old vault secret is one way to
    // block it; a single env half is another. Everywhere else the pair has moved
    // into the vault by the time reload runs, and the vault tier wins.
    const dir = freshDataDir('cp-reload-config');
    setEnv('LYNOX_VAULT_KEY', 'test-vault-key-for-boot-0000000000');
    const seed = new SecretVault();
    seed.set('GOOGLE_CLIENT_SECRET', 'PROJECT-A-secret');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      google_client_id: 'PROJECT-B-id',
      google_client_secret: 'PROJECT-B-secret',
    }, null, 2) + '\n');

    const engine = await boot();
    captured.calls.length = 0;
    await engine.reloadGoogle();

    const reloaded = captured.calls.at(-1);
    expect(reloaded, 'reloadGoogle must rebuild from the config tier').toBeDefined();
    expect(reloaded).toEqual({ clientId: 'PROJECT-B-id', clientSecret: 'PROJECT-B-secret' });
    expect(engine.getGoogleClientSource()).toBe('config');
  });

  it('reloadGoogle UPDATES the reported source, it does not merely re-report it', async () => {
    // Both other reload cases boot into the source they then assert, so neither
    // can tell a reload that recomputes the source from one that leaves the old
    // value standing — measured: deleting the assignment in reloadGoogle left
    // all of them green. Here the source has to CHANGE.
    freshDataDir('cp-reload-source');
    const engine = await boot();
    expect(engine.getGoogleClientSource()).toBeNull();
    expect(captured.calls).toHaveLength(0);

    setEnv('GOOGLE_CLIENT_ID', 'late-id');
    setEnv('GOOGLE_CLIENT_SECRET', 'late-secret');
    await engine.reloadGoogle();

    expect(engine.getGoogleClientSource()).toBe('env');
    expect(captured.calls.at(-1)).toEqual({ clientId: 'late-id', clientSecret: 'late-secret' });
  });

  it('reloadGoogle re-resolves after the pair has migrated into the vault', async () => {
    // reloadGoogle has a live production caller — `POST /api/google/reload`
    // (src/server/http-api.ts). What it did NOT have was a test: the HTTP API
    // suite replaces it with a vi.fn(), so the real method ran nowhere.
    //
    // This case is the ordinary shape: config.json supplies the pair, init
    // migrates it into the vault, and the reload therefore resolves 'vault'
    // even though config.json is where the operator wrote it.
    const dir = freshDataDir('cp-reload');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      google_client_id: 'cfg-id',
      google_client_secret: 'cfg-secret',
    }, null, 2) + '\n');
    const engine = await boot();
    captured.calls.length = 0;

    await engine.reloadGoogle();

    const rebuilt = captured.calls.at(-1);
    expect(rebuilt, 'reloadGoogle must rebuild the pair').toBeDefined();
    expect(rebuilt).toEqual({ clientId: 'cfg-id', clientSecret: 'cfg-secret' });
    expect(engine.getGoogleClientSource()).toBe('vault');
  });

  it('no pair anywhere → nothing built, no source', async () => {
    freshDataDir('cp-none');
    const engine = await boot();
    expect(engine.getGoogleClientSource()).toBeNull();
    expect(captured.calls).toHaveLength(0);
  });
});
