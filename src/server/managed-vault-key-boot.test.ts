import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { MANAGED_VAULT_KEY_REFUSAL } from '../core/engine-init.js';
import { _resetVaultKeySource, vaultKeySource } from '../core/vault-key-source.js';

/**
 * A REAL boot of an instance the platform hosts: it starts only on the vault key the platform
 * delivered in the environment. Without it the boot stops before any store is opened, so nothing is
 * written unencrypted and no key of its own is generated next to the data.
 */

const KEY = 'K'.repeat(64);
let booted: { api: LynoxHTTPApi; dir: string } | null = null;

afterEach(async () => {
  if (booted !== null) {
    const { api, dir } = booted;
    booted = null;
    await api.shutdown().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  reloadConfig();
  _resetVaultKeySource();
});

async function boot(env: Record<string, string | undefined>): Promise<{ data: string; init: Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-hosted-start-'));
  const home = join(dir, 'home');
  const data = join(dir, 'data');
  mkdirSync(home);
  mkdirSync(data);
  vi.stubEnv('HOME', home);
  vi.stubEnv('LYNOX_DATA_DIR', data);
  vi.stubEnv('LYNOX_HTTP_SECRET', 'managed-key-boot-secret-value');
  vi.stubEnv('LYNOX_ALLOW_PLAIN_HTTP', 'true');
  vi.stubEnv('LYNOX_MANAGED_INSTANCE_ID', undefined);
  vi.stubEnv('LYNOX_BILLING_TIER', undefined);
  vi.stubEnv('LYNOX_MANAGED_MODE', undefined);
  vi.stubEnv('LYNOX_VAULT_KEY', undefined);
  vi.stubEnv('LYNOX_VAULT_KEY_SOURCE', undefined);
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  reloadConfig();
  _resetVaultKeySource();
  const api = new LynoxHTTPApi();
  booted = { api, dir };
  return { data, init: api.init() };
}

describe('a managed boot and its vault key', () => {
  it('stops without a key, before any store is opened, and generates none', async () => {
    const { data, init } = await boot({ LYNOX_BILLING_TIER: 'managed' });
    await expect(init).rejects.toThrow(MANAGED_VAULT_KEY_REFUSAL);
    expect(existsSync(join(data, 'vault.key'))).toBe(false);
    expect(readdirSync(data).filter(f => f.endsWith('.db'))).toEqual([]);
    expect(process.env['LYNOX_VAULT_KEY'] ?? '').toBe('');
  });

  it('stops on an empty key', async () => {
    const { init } = await boot({ LYNOX_BILLING_TIER: 'managed', LYNOX_VAULT_KEY: '' });
    await expect(init).rejects.toThrow(MANAGED_VAULT_KEY_REFUSAL);
  });

  it('gets past the key on the one the environment delivered (control)', async () => {
    // The managed hook needs its control plane; the status poll gets an allowing answer.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ allowed: true, balance_cents: 100, spend_gate: 'balance' }) }));
    const { data, init } = await boot({
      LYNOX_BILLING_TIER: 'managed', LYNOX_VAULT_KEY: KEY, LYNOX_VAULT_KEY_SOURCE: 'env',
      LYNOX_MANAGED_CONTROL_PLANE_URL: 'https://cp.test', LYNOX_MANAGED_INSTANCE_ID: 'inst-1',
    });
    await expect(init).resolves.toBeUndefined();
    expect(vaultKeySource()).toBe('env');
    expect(existsSync(join(data, 'vault.key'))).toBe(false);
  });

  it('leaves a self-hosted first boot as it was: it generates a key (control)', async () => {
    const { data, init } = await boot({});
    await expect(init).resolves.toBeUndefined();
    expect(existsSync(join(data, 'vault.key'))).toBe(true);
  });
});
