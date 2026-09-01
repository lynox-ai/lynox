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
 * HANDED TO the auth factory: the source it chose and, for the case that
 * matters, the secret VALUE. (Until 2026-09-01 that factory was
 * `createGoogleTools`, which built the credential AND the tools together. The
 * two were split so the tools can exist before the credential does; the pair
 * now goes to `createGoogleAuth`, and this file follows the pair.) A resolver that returns the vault id with the env
 * secret still reports `source: 'vault'` — the value is the assertion.
 */
const PROBE_TOOL = 'google_probe_tool';
/**
 * The fixture is a suspect, and here it was the defect. It used to return
 * `tools: []` and capture only `clientId`/`clientSecret`, which made two things
 * UNOBSERVABLE BY CONSTRUCTION rather than by omission: whether the registration
 * loop runs at all, and whether the vault, scopes and key path reach the auth
 * factory. Deleting any of those lines from the engine left every test green.
 * It returns one real tool now and captures the whole options object.
 *
 * Both halves are mocked because the engine now calls both: `createGoogleTools`
 * unconditionally (it takes a resolver and no credential), `createGoogleAuth`
 * only when a pair resolved. `calls` therefore records the PAIR decisions, which
 * is what every assertion below is about.
 */
const captured = vi.hoisted(() => ({
  calls: [] as Record<string, unknown>[],
  /** Set by the one test that needs createGoogleTools to blow up. */
  explode: false,
}));
vi.mock('../integrations/google/index.js', () => ({
  createGoogleTools: () => ({
    tools: [{ definition: { name: 'google_probe_tool', description: 'probe', parameters: {} }, execute: async () => '' }],
  }),
  createGoogleAuth: (opts: Record<string, unknown>) => {
    captured.calls.push({ ...opts });
    if (captured.explode) throw new Error('createGoogleAuth failed');
    return { isAuthenticated: () => false };
  },
}));

describe('Engine boot — the Google client pair is resolved from ONE source', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  // GOOGLE_SERVICE_ACCOUNT_KEY belongs here since one case sets it: freshDataDir
  // is what stops a marker leaking from one case into the next, and a key it does
  // not know about leaks silently.
  const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_VAULT_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
    'GOOGLE_SERVICE_ACCOUNT_KEY',
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
    captured.explode = false;
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
    const dir = freshDataDir('cp-env');
    setEnv('GOOGLE_CLIENT_ID', 'env-id');
    setEnv('GOOGLE_CLIENT_SECRET', 'env-secret');
    // The two arguments no test anywhere set a value for, so their VALUES were
    // never exercised: presence alone survives `scopes: undefined` and a renamed
    // env key, which is exactly what a config-field rename produces.
    setEnv('LYNOX_VAULT_KEY', 'test-vault-key-for-boot-0000000000');
    setEnv('GOOGLE_SERVICE_ACCOUNT_KEY', '/tmp/sa-key.json');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      google_oauth_scopes: ['https://www.googleapis.com/auth/calendar.events'],
    }, null, 2) + '\n');

    const engine = await boot();
    expect(engine.getGoogleClientSource()).toBe('env');
    // toStrictEqual, and the reason is narrower than "the whole object": a subset
    // match cannot see an EXTRA argument at all, and plain toEqual sees one only
    // if its value is defined — `extra: process.env['UNSET']` slips through both.
    // Passing the secret a second time under another name is exactly the shape
    // this module exists against, so the strict form is the one that holds.
    expect(captured.calls.at(-1)).toStrictEqual({
      clientId: 'env-id',
      clientSecret: 'env-secret',
      serviceAccountKeyPath: '/tmp/sa-key.json',
      vault: expect.anything(),
      scopes: ['https://www.googleapis.com/auth/calendar.events'],
    });
    // The BOOT path has its own registration loop, and deleting it survived
    // every suite until this line — the reload fix closed only the other copy.
    expect(engine.registry.find(PROBE_TOOL), 'the boot must register the built tools').toBeDefined();
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
    expect(captured.calls.at(-1)).toMatchObject({ clientId: 'vault-id', clientSecret: 'vault-secret' });
    // A tenant running their OWN client is not the broker — and the marker is
    // set here on purpose, because without it this assertion reads false for the
    // wrong reason: freshDataDir clears the marker, so it would pass with the
    // source term deleted. The point is that a provisioned instance resolving
    // from the VAULT is still not the broker.
    setEnv('LYNOX_MANAGED_INSTANCE_ID', 'inst_vault_byo');
    expect(engine.isGoogleManagedBroker(), 'a vault pair is the tenant\'s own, marker or not').toBe(false);
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
    expect(built, 'the config pair must reach createGoogleAuth').toBeDefined();
    expect(built?.clientSecret).not.toBe('PROJECT-A-secret');
    expect(built).toMatchObject({ clientId: 'PROJECT-B-id', clientSecret: 'PROJECT-B-secret' });
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
    expect(reloaded).toMatchObject({ clientId: 'PROJECT-B-id', clientSecret: 'PROJECT-B-secret' });
    expect(engine.getGoogleClientSource()).toBe('config');
    // The vault handle itself, asserted where one actually exists: nulling this
    // argument would leave the tools unable to read a stored token, and until
    // now nothing looked at it.
    expect(reloaded?.['vault'], 'the vault must reach createGoogleAuth').toBeDefined();
  });

  it('reloadGoogle drives the whole reported state, in both directions', async () => {
    // Five things hang off a reload and each was killed by nothing before this:
    // the resolved source, the managed-broker verdict, the GoogleAuth handle,
    // the registered tools, and the return value. They are asserted in one test
    // because they are one state machine — a reload that half-updates is the
    // failure mode.
    //
    // The consequence that makes this more than tidiness: `GET /api/secrets/status`
    // reports `configured.google` from `getGoogleClientSource() !== null`
    // (src/server/http-api.ts). A source left standing after the credentials are
    // removed therefore tells the settings surface that Google is configured on
    // an engine that resolves nothing. (`GET /api/google/status` does NOT show
    // this — it returns early on a null GoogleAuth and never reaches
    // client_source. An earlier version of this comment named it, and it was
    // wrong: that endpoint cannot display the symptom.)
    freshDataDir('cp-reload-source');
    const engine = await boot();
    expect(engine.getGoogleClientSource()).toBeNull();
    expect(captured.calls).toHaveLength(0);

    // ── nothing → an env pair, on a SELF-HOST engine.
    setEnv('GOOGLE_CLIENT_ID', 'late-id');
    setEnv('GOOGLE_CLIENT_SECRET', 'late-secret');
    expect(await engine.reloadGoogle(), 'a reload that builds must report success').toBe(true);
    expect(engine.getGoogleClientSource()).toBe('env');
    expect(captured.calls.at(-1)).toMatchObject({ clientId: 'late-id', clientSecret: 'late-secret' });
    // The POSITIVE half, and it is what makes the null assertion in phase 4 mean
    // anything: without it, `getGoogleAuth()` reads null there because the boot
    // never set a handle, not because the reload cleared one — and deleting the
    // assignment in reloadGoogle stays green. The vacuous-negative trap, one
    // round after fixing the same trap on isGoogleManagedBroker.
    expect(engine.getGoogleAuth(), 'a reload that builds must install the auth handle').not.toBeNull();
    // The literal reading of "every Google tool was dead": deleting the
    // registration loop used to survive every suite, because the fixture
    // returned no tools. It returns one now, so the loop is observable.
    expect(engine.registry.find(PROBE_TOOL), 'the built tools must reach the registry').toBeDefined();
    // The other three arguments the auth factory is handed. Deleting any of them
    // used to survive every suite, because the fixture captured only id and
    // secret. Presence, not value — in THIS phase there is no vault key and no
    // configured scope list, so the values are legitimately undefined; the
    // vault's VALUE is asserted in the migration case below, where one exists.
    const opts = Object.keys(captured.calls.at(-1) ?? {});
    for (const key of ['vault', 'scopes', 'serviceAccountKeyPath']) {
      expect(opts, `the auth factory must still be handed ${key}`).toContain(key);
    }
    // An env pair alone is NOT the managed broker — the provisioning marker is
    // the other half of that verdict.
    expect(engine.isGoogleManagedBroker(), 'env alone is a self-host pair').toBe(false);

    // ── the same pair, now on a provisioned instance. No reload: the verdict
    // reads process.env live, so it flips without one. Calling reloadGoogle here
    // would look like the cause and be decoration — measured, deleting it left
    // the suite green.
    setEnv('LYNOX_MANAGED_INSTANCE_ID', 'inst_reload');
    expect(engine.isGoogleManagedBroker(), 'env + a provisioning marker IS the broker').toBe(true);

    // An EMPTY marker is not a marker. The shape is the one this module's own
    // header calls out: a deployment interpolating an unset variable
    // (`NAME=${NAME:-}`) hands the process an empty string rather than nothing.
    // Weakening the check to `!== undefined` would make a self-host engine
    // report as the managed broker, and only this case catches that.
    setEnv('LYNOX_MANAGED_INSTANCE_ID', '');
    expect(engine.isGoogleManagedBroker(), 'an empty marker is not a provisioned instance').toBe(false);
    setEnv('LYNOX_MANAGED_INSTANCE_ID', 'inst_reload');

    // ── and back to nothing.
    setEnv('GOOGLE_CLIENT_ID', undefined);
    setEnv('GOOGLE_CLIENT_SECRET', undefined);
    expect(await engine.reloadGoogle(), 'a reload that builds nothing must report failure').toBe(false);
    expect(engine.getGoogleClientSource(), 'the source must clear').toBeNull();
    expect(engine.isGoogleManagedBroker(), 'and the broker verdict with it').toBe(false);
    expect(engine.getGoogleAuth(), 'the auth handle must go with the credentials').toBeNull();
  });

  it('reloadGoogle reports failure when building the tools throws', async () => {
    // The try/catch has two ways to answer false and only one was asserted.
    // A throwing createGoogleAuth with `catch { return true }` would have
    // POST /api/google/reload answer ok while the engine kept whatever handle it
    // had — the same lie as the early-return branch, through the other door.
    freshDataDir('cp-reload-throw');
    setEnv('GOOGLE_CLIENT_ID', 'boom-id');
    setEnv('GOOGLE_CLIENT_SECRET', 'boom-secret');
    const engine = await boot();
    expect(engine.getGoogleAuth(), 'the boot must have built something to lose').not.toBeNull();

    const handleBefore = engine.getGoogleAuth();
    captured.explode = true;
    expect(await engine.reloadGoogle(), 'a reload that throws must report failure').toBe(false);

    // What the throw leaves behind, asserted rather than left to chance — two
    // killable mutants lived in here (dropping the handle, and setting the source
    // only on success). The registry line below is NOT one of them and is kept as
    // documentation: ToolRegistry has no unregister method, so no mutation can
    // make that assertion fail. Counting it as coverage was the error. Two of these are deliberate and one is a question:
    //  · the handle stays the OLD one. Deliberate: the previous integration is
    //    still working, and tearing it down because a rebuild failed would turn
    //    a failed reload into an outage.
    //  · the registry keeps the old tools, for the same reason.
    //  · the SOURCE was already updated before the throw, so it now describes
    //    the pair the failed build was for while the handle is from the previous
    //    one. Harmless while both resolve to the same tier and not obviously
    //    right otherwise — carried as DEF-reload-throw-leaves-source-ahead.
    expect(engine.getGoogleAuth(), 'a failed rebuild must not drop a working handle').toBe(handleBefore);
    expect(engine.registry.find(PROBE_TOOL), 'the tools stay — there is no unregister path at all').toBeDefined();
    expect(engine.getGoogleClientSource(), 'the source reflects the attempted pair').toBe('env');
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
    expect(rebuilt).toMatchObject({ clientId: 'cfg-id', clientSecret: 'cfg-secret' });
    expect(engine.getGoogleClientSource()).toBe('vault');
  });

  it('no pair anywhere → nothing built, no source', async () => {
    freshDataDir('cp-none');
    const engine = await boot();
    expect(engine.getGoogleClientSource()).toBeNull();
    expect(captured.calls).toHaveLength(0);
  });
});
