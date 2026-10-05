import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { SecretVault } from './secret-vault.js';
import { GOOGLE_OAUTH_TOKENS_KEY } from '../integrations/google/vault-keys.js';
import type { LynoxConfig } from '../types/index.js';

/**
 * A brokered Google connection survives a restart.
 *
 * A brokered tenant never resolves a client pair, so the boot used to build no
 * credential at all, and only the claim route built one later. After a restart
 * the token was still in the vault while every reader — the status route, the
 * Google tools, the mail context — saw no connection until the user connected
 * again. A unit test that hands the engine a credential cannot see that; this
 * boots a REAL engine and reads what the boot itself built.
 *
 * MUTATION THIS KILLS: deleting the brokered branch in `Engine.init` (the
 * `else if (… LYNOX_MANAGED_INSTANCE_ID …)` after the client-pair resolve).
 */
describe('Engine boot — a brokered Google connection is rebuilt from the vault', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_VAULT_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
    'GOOGLE_SERVICE_ACCOUNT_KEY', 'LYNOX_MANAGED_INSTANCE_ID'] as const;
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
    reloadConfig();
  });

  /** Boots with no client pair anywhere; `managed` sets the control-plane identity, `token` seeds the vault. */
  async function boot(opts: { managed: boolean; token: boolean }): Promise<Engine> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-gbroker-'));
    dirs.push(dir);
    for (const k of ENV_KEYS) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    setEnv('LYNOX_VAULT_KEY', 'test-vault-key-for-boot-0000000000');
    if (opts.managed) setEnv('LYNOX_MANAGED_INSTANCE_ID', 'inst-broker-test');
    reloadConfig();
    if (opts.token) {
      // The shape a claim writes, valid for an hour so nothing tries to refresh during the test.
      const vault = new SecretVault();
      vault.set(GOOGLE_OAUTH_TOKENS_KEY, JSON.stringify({
        access_token: 'ya29.test-access',
        refresh_token: 'test-refresh',
        expires_at: Date.now() + 60 * 60_000,
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      }), 'any');
      vault.close();
    }
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    expect(engine.getGoogleClientSource(), 'no client pair may resolve, or the test drives the wrong branch').toBeNull();
    return engine;
  }

  function mailContextAuth(engine: Engine): unknown {
    const ctx = (engine as unknown as { _mailContext: { googleAuth: unknown } | null })._mailContext;
    if (!ctx) throw new Error('no mail context after boot — the probe broke, this is not a pass');
    return ctx.googleAuth;
  }

  it('builds the credential at boot when the vault holds a brokered token', async () => {
    const engine = await boot({ managed: true, token: true });
    const auth = engine.getGoogleAuth();
    expect(auth, 'a stored brokered token must be connected after a restart').not.toBeNull();
    expect(auth?.isAuthenticated()).toBe(true);
  });

  it('hands that credential to the mail context, which takes it as a value at boot', async () => {
    const engine = await boot({ managed: true, token: true });
    expect(mailContextAuth(engine), 'the mail context must hold the same credential').toBe(engine.getGoogleAuth());
  });

  it('builds none on a managed instance without a stored token', async () => {
    // An empty credential here would make `getGoogleAuth()` non-null for every
    // managed tenant, and the status route would read that as a connection.
    const engine = await boot({ managed: true, token: false });
    expect(engine.getGoogleAuth()).toBeNull();
  });

  it('builds none on a self-host instance with a stored token but no pair', async () => {
    // Without the control-plane identity there is no broker to refresh through.
    const engine = await boot({ managed: false, token: true });
    expect(engine.getGoogleAuth()).toBeNull();
  });
});
