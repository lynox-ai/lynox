import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureVaultKey, loadVaultKeyFromDotEnv } from './engine-init.js';
import { reloadConfig } from './config.js';
import { createManagedHook } from './managed-hook.js';
import {
  VAULT_KEY_PATTERN, _resetVaultKeySource, keyDelivery, keyDeliveryHeaders, recordVaultKeySource, vaultKeySource,
} from './vault-key-source.js';

/**
 * A managed engine tells the control plane, on every status poll, where its vault key came from:
 * a word and whether the key is 64 characters long, never the key.
 */

const KEY64 = 'A'.repeat(32) + 'b'.repeat(31) + '=';
const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../contract/fixtures');
const fixture = (name: string): unknown => JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'lynox-key-source-'));
  _resetVaultKeySource();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  reloadConfig();
  _resetVaultKeySource();
  rmSync(tmp, { recursive: true, force: true });
});

describe('the word sent for each source', () => {
  it('names a well-formed key from the environment env, and one of another form malformed', () => {
    expect(keyDelivery('env', KEY64)).toBe('env');
    expect(keyDelivery('env', 'short')).toBe('malformed');
    expect(keyDelivery('env', KEY64 + '#')).toBe('malformed');
  });

  it('names a key from the volume, the data dir or this start fallback, whatever its form', () => {
    for (const source of ['volume-env', 'vault-key', 'minted', 'unknown'] as const) {
      expect(keyDelivery(source, KEY64)).toBe('fallback');
    }
  });

  it('names a key whose source was not recorded fallback, not env', () => {
    expect(keyDelivery(null, KEY64)).toBe('fallback');
  });

  it('names no key none, also when a source was recorded', () => {
    expect(keyDelivery('none', undefined)).toBe('none');
    expect(keyDelivery('env', '')).toBe('none');
  });

  it('says whether the key is 64 characters long, and nothing about length without a key', () => {
    expect(keyDeliveryHeaders('env', KEY64)).toEqual({ 'x-key-delivery': 'env', 'x-key-len64': '1' });
    expect(keyDeliveryHeaders('env', KEY64.slice(0, 40))).toEqual({ 'x-key-delivery': 'env', 'x-key-len64': '0' });
    expect(keyDeliveryHeaders('none', undefined)).toEqual({ 'x-key-delivery': 'none' });
  });

  it('never carries the key or a piece of it', () => {
    // A key with no lower-case letter shares no run of characters with the words, which are lower
    // case, or with the one-digit length flag: any run of it found in the headers came from the key.
    const key = 'QZ9/+XW7'.repeat(8);
    expect(key).toMatch(VAULT_KEY_PATTERN);
    for (const source of ['env', 'volume-env', 'vault-key', 'minted', 'none', 'unknown'] as const) {
      const sent = Object.values(keyDeliveryHeaders(source, key)).join('\n');
      for (let i = 0; i + 2 <= key.length; i++) expect(sent, key.slice(i, i + 2)).not.toContain(key.slice(i, i + 2));
    }
  });

  it('keeps the first source recorded', () => {
    recordVaultKeySource('vault-key');
    recordVaultKeySource('env');
    expect(vaultKeySource()).toBe('vault-key');
  });
});

describe('the source as a start settles the key', () => {
  const dataDir = (): string => {
    const dir = join(tmp, 'data');
    mkdirSync(dir, { recursive: true });
    vi.stubEnv('LYNOX_DATA_DIR', dir);
    reloadConfig();
    return dir;
  };

  it('a key in the environment is env', () => {
    dataDir();
    vi.stubEnv('LYNOX_VAULT_KEY', KEY64);
    vi.stubEnv('LYNOX_VAULT_KEY_SOURCE', undefined);
    ensureVaultKey();
    expect(vaultKeySource()).toBe('env');
  });

  it('takes the entrypoint\'s word for a key it put into the environment', () => {
    dataDir();
    vi.stubEnv('LYNOX_VAULT_KEY', KEY64);
    for (const [said, recorded] of [['volume-env', 'volume-env'], ['minted', 'minted'], ['env', 'env'], ['none', 'unknown'], ['something', 'unknown'], ['', 'env']] as const) {
      _resetVaultKeySource();
      vi.stubEnv('LYNOX_VAULT_KEY_SOURCE', said);
      ensureVaultKey();
      expect(vaultKeySource(), said).toBe(recorded);
    }
  });

  it('a key read from the data dir\'s vault.key is vault-key, and a later call keeps it', () => {
    const dir = dataDir();
    vi.stubEnv('LYNOX_VAULT_KEY', '');
    writeFileSync(join(dir, 'vault.key'), KEY64 + '\n');
    ensureVaultKey();
    expect(process.env['LYNOX_VAULT_KEY']).toBe(KEY64);
    expect(vaultKeySource()).toBe('vault-key');
    ensureVaultKey();
    expect(vaultKeySource()).toBe('vault-key');
  });

  it('a key generated on a first start is minted', () => {
    const dir = dataDir();
    vi.stubEnv('LYNOX_VAULT_KEY', '');
    ensureVaultKey();
    expect(readFileSync(join(dir, 'vault.key'), 'utf8').trim()).toBe(process.env['LYNOX_VAULT_KEY']);
    expect(vaultKeySource()).toBe('minted');
  });

  it('no key over an existing vault is none', () => {
    const dir = dataDir();
    vi.stubEnv('LYNOX_VAULT_KEY', '');
    writeFileSync(join(dir, 'vault.db'), '');
    ensureVaultKey();
    expect(process.env['LYNOX_VAULT_KEY']).toBe('');
    expect(vaultKeySource()).toBe('none');
  });

  it('a key from ~/.lynox/.env is volume-env, also after the start settles the key', () => {
    const home = join(tmp, 'home');
    mkdirSync(join(home, '.lynox'), { recursive: true });
    writeFileSync(join(home, '.lynox', '.env'), `LYNOX_VAULT_KEY=${KEY64}\n`, { mode: 0o600 });
    vi.stubEnv('HOME', home);
    vi.stubEnv('LYNOX_VAULT_KEY', '');
    vi.stubEnv('LYNOX_VAULT_KEY_SOURCE', undefined);
    dataDir();
    loadVaultKeyFromDotEnv();
    expect(process.env['LYNOX_VAULT_KEY']).toBe(KEY64);
    ensureVaultKey();
    expect(vaultKeySource()).toBe('volume-env');
  });
});

describe('the status poll', () => {
  beforeEach(() => {
    vi.stubEnv('LYNOX_MANAGED_CONTROL_PLANE_URL', 'https://cp.test');
    vi.stubEnv('LYNOX_MANAGED_INSTANCE_ID', 'inst-1');
    vi.stubEnv('LYNOX_HTTP_SECRET', 'secret');
  });

  async function statusHeaders(): Promise<Record<string, string>> {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ allowed: true, balance_cents: 100, spend_gate: 'balance' }) });
    vi.stubGlobal('fetch', fetchSpy);
    const hook = createManagedHook();
    await hook.onInit?.();
    await hook.onShutdown?.();
    const call = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/status'));
    expect(call, 'the start polls the status').toBeDefined();
    return (call![1] as { headers: Record<string, string> }).headers;
  }

  it('carries the usage-status-request-headers fixture for a well-formed key from the environment (generator test)', async () => {
    vi.stubEnv('LYNOX_VAULT_KEY', KEY64);
    recordVaultKeySource('env');
    const headers = await statusHeaders();
    const { 'x-instance-secret': secret, ...statement } = headers;
    expect(secret).toBe('secret');
    expect(statement).toEqual(fixture('usage-status-request-headers.json'));
    expect(JSON.stringify(headers)).not.toContain(KEY64.slice(0, 8));
  });

  it('carries the usage-status-request-headers.none fixture without a key (generator test)', async () => {
    vi.stubEnv('LYNOX_VAULT_KEY', '');
    recordVaultKeySource('none');
    const { 'x-instance-secret': _secret, ...statement } = await statusHeaders();
    expect(statement).toEqual(fixture('usage-status-request-headers.none.json'));
  });

  it('says fallback for a key the start generated', async () => {
    vi.stubEnv('LYNOX_VAULT_KEY', KEY64);
    recordVaultKeySource('minted');
    const headers = await statusHeaders();
    expect(headers['x-key-delivery']).toBe('fallback');
    expect(headers['x-key-len64']).toBe('1');
  });
});
