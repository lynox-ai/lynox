import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from './engine.js';
import { SecretVault } from './secret-vault.js';
import { reloadConfig } from './config.js';
import { accessTokenKey } from './api-store.js';
import { renderSecretsBriefing } from './engine-init.js';
import type { LynoxConfig } from '../types/index.js';

/**
 * The `<secrets>` briefing offers every free name as `secret:NAME`. The `secret:` gate refuses
 * a connection's token, so those names are listed apart, as their profile's. The boot renders the briefing before any API
 * profile is loaded, and the engine renders it again once they are: only a real boot shows that the
 * second render happens and sees the profiles. A unit test of the renderer hands it the filter
 * itself and cannot see whether the engine ever calls it.
 */
describe('Engine boot — a connection token is not offered in the <secrets> briefing', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const ENV_KEYS = ['LYNOX_DATA_DIR', 'LYNOX_VAULT_KEY', 'LYNOX_MANAGED_INSTANCE_ID'] as const;
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
  }, 60_000);

  const ACCESS = accessTokenKey('shop-api');

  async function boot(withProfile: boolean): Promise<Engine> {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-secrets-brief-'));
    dirs.push(dir);
    for (const k of ENV_KEYS) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    setEnv('LYNOX_VAULT_KEY', 'test-vault-key-for-boot-0000000000');
    const seed = new SecretVault();
    seed.set('SHOP_RT', 'refresh-value-0001');
    seed.set(ACCESS, 'access-value-0002');
    seed.set('FREE_KEY', 'free-value-0003');
    if (withProfile) {
      mkdirSync(join(dir, 'apis'), { recursive: true });
      writeFileSync(join(dir, 'apis', 'shop-api.json'), JSON.stringify({
        id: 'shop-api', name: 'shop-api', base_url: 'https://shop.example/v1', description: 'Shop',
        auth: { type: 'oauth2', oauth: { token_url: 'https://shop.example/oauth/token', grant_type: 'refresh_token', refresh_token_key: 'SHOP_RT' } },
        custom_endpoint_ack: { accepted: true, hosts: ['shop.example'], accepted_at: '2026-10-18T00:00:00.000Z' },
        endpoints: [{ method: 'GET', path: '/orders', description: 'Orders' }],
      }));
    }
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    return engine;
  }

  it('leaves out the grant token and the configured refresh slot, and keeps a free name', async () => {
    const engine = await boot(true);
    expect(engine.getToolContext().apiStore?.get('shop-api'), 'the profile was loaded').toBeDefined();
    const briefing = engine.getSecretsBriefing() ?? '';
    expect(briefing).toContain('secret:FREE_KEY');
    expect(briefing).not.toContain(`secret:${ACCESS}`);
    expect(briefing, 'the configured refresh slot is a token too').not.toContain('secret:SHOP_RT');
    // Still there, counted as the profile's: left out, the vault reads as holding no access for it.
    // Never named: a name is what a model writes after secret:.
    expect(briefing).toContain('2 for profile "shop-api"');
    expect(briefing).not.toContain(ACCESS);
    expect(briefing).not.toContain('SHOP_RT');
  }, 60_000);

  it('control: without the profile, the same names are all offered', async () => {
    const engine = await boot(false);
    const briefing = engine.getSecretsBriefing() ?? '';
    expect(briefing).toContain('secret:FREE_KEY');
    expect(briefing).toContain(`secret:${ACCESS}`);
    expect(briefing).toContain('secret:SHOP_RT');
  }, 60_000);
});

describe('renderSecretsBriefing', () => {
  const store = (names: string[]) => ({ listAgentVisibleNames: () => names, getMasked: () => '****abcd' });
  const heldBy = (token: string, ...profiles: unknown[]) => (n: string) => (n === token ? profiles.map((name) => ({ name })) : []);

  it('offers a free name as a secret: reference, and lists a token apart with its profile', () => {
    expect(renderSecretsBriefing(store(['A_KEY', 'B_KEY']))).toContain('secret:B_KEY (****abcd)');
    const out = renderSecretsBriefing(store(['A_KEY', 'B_KEY']), heldBy('B_KEY', 'shop')) ?? '';
    expect(out).toContain('secret:A_KEY (****abcd)');
    expect(out).not.toContain('secret:B_KEY');
    expect(out).toMatch(/Connection tokens in the vault, held by an API profile[^\n]*not referenced with secret:[^\n]*: 1 for profile "shop"\.\n/);
    expect(out, 'a token is not named, and its masked value not shown').not.toContain('B_KEY');
  });

  it('names no profile when two hold the token', () => {
    const out = renderSecretsBriefing(store(['B_KEY']), heldBy('B_KEY', 'one', 'two')) ?? '';
    expect(out).toContain('not collected again: 1 held by more than one profile.');
    expect(out).not.toContain('for profile');
  });

  it('counts two profiles that share a name apart, by id', () => {
    const out = renderSecretsBriefing(store(['A_TOK', 'B_TOK']), (n) => [{ id: n === 'A_TOK' ? 'shop-a' : 'shop-b', name: 'Shop' }]) ?? '';
    expect(out).toContain('1 for profile "Shop", 1 for profile "Shop".');
    const same = renderSecretsBriefing(store(['A_TOK', 'B_TOK']), () => [{ id: 'shop-a', name: 'Shop' }]) ?? '';
    expect(same, 'control: one profile\'s tokens add up').toContain(': 2 for profile "Shop".');
  });

  it('lists only tokens when no free name is left, and nothing for an empty vault', () => {
    const out = renderSecretsBriefing(store(['B_KEY']), heldBy('B_KEY', 'shop')) ?? '';
    expect(out).toContain('1 for profile "shop"');
    expect(out).not.toMatch(/secret:[A-Z]/);
    expect(renderSecretsBriefing(store([]))).toBeUndefined();
  });
});
