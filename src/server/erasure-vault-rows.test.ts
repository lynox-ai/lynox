import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import type { SecretVault } from '../core/secret-vault.js';
import type { SecretStore } from '../core/secret-store.js';

/**
 * `DELETE /api/data` must empty the vault FILE, not only the secrets the store knew
 * about at boot.
 *
 * The store's map is filled from the vault once, in its constructor. Code that holds
 * the vault itself writes past it afterwards: a mail account stores its password
 * through `MailCredentialBackend` (the vault), and Google stores its OAuth tokens with
 * `vault.set('GOOGLE_OAUTH_TOKENS')`. Those rows are in `vault.db` and never in the
 * map, so an erasure that iterates the map leaves them on disk under its "all user
 * data has been permanently deleted".
 *
 * A real engine, because the property is the gap between two real objects (the map
 * and the file); a mocked store would hold whichever answer the fixture gave it.
 */
describe('erasure empties every vault row, including rows written after boot (real engine)', () => {
  // Built at RUNTIME: a key-shaped literal in a fixture is what the commit-time
  // secret scan looks for, and this repo is public.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  let api: LynoxHTTPApi;
  let baseUrl: string;
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE'];

  function engineOf(): { getSecretStore: () => SecretStore | null } {
    return (api as unknown as { engine: { getSecretStore: () => SecretStore | null } }).engine;
  }

  function vaultOf(): SecretVault {
    const v = (api as unknown as { engine: { secretVault: SecretVault | null } }).engine.secretVault;
    if (v === null) throw new Error('fixture: the engine opened no vault');
    return v;
  }

  /** Read from the file with its own connection, so the answer is the disk's. */
  function vaultRows(): string[] {
    const db = new BetterSqlite3(join(dir, 'vault.db'), { readonly: true, fileMustExist: true });
    try {
      return (db.prepare('SELECT name FROM vault_secrets ORDER BY name').all() as Array<{ name: string }>).map(r => r.name);
    } finally {
      db.close();
    }
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-erasure-vault-'));
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    // `denyOnManagedInstance` 403s the erasure on an instance with a billing tier.
    delete process.env['LYNOX_BILLING_TIER'];
    delete process.env['LYNOX_MANAGED_MODE'];
    reloadConfig();
    api = new LynoxHTTPApi();
    await api.init();
    await api.start(0);
    const addr = (api as unknown as { server: Server | null }).server?.address();
    if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${String(addr.port)}`;
  }, 120_000);

  afterAll(async () => {
    try {
      await api?.shutdown();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      reloadConfig();
    }
  });

  it('deletes rows that reached the vault after boot, and answers with the sentence only then', async () => {
    const store = engineOf().getSecretStore();
    if (store === null) throw new Error('fixture: no secret store');
    // One through the store (in the map AND the file), two past it (file only) — the
    // two shapes mail and Google write in.
    store.set('ZZ_STORE_SECRET', `s-${randomBytes(6).toString('hex')}`);
    vaultOf().set('MAIL_ACCOUNT_ZZ_PROBE', `p-${randomBytes(6).toString('hex')}`, 'any');
    vaultOf().set('GOOGLE_OAUTH_TOKENS', JSON.stringify({ refresh_token: `r-${randomBytes(6).toString('hex')}` }), 'any');
    // Positive control on the premise: the map does not know the two direct writes.
    expect(store.listNames()).toContain('ZZ_STORE_SECRET');
    expect(store.listNames()).not.toContain('MAIL_ACCOUNT_ZZ_PROBE');
    expect(store.listNames()).not.toContain('GOOGLE_OAUTH_TOKENS');
    expect(vaultRows()).toEqual(expect.arrayContaining(['GOOGLE_OAUTH_TOKENS', 'MAIL_ACCOUNT_ZZ_PROBE', 'ZZ_STORE_SECRET']));

    const res = await fetch(`${baseUrl}/api/data`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'DELETE_ALL_DATA' }),
    });
    const body = await res.json() as { deleted?: boolean; failed?: string[]; message?: string };

    expect(vaultRows(), 'a secret row survived the erasure in vault.db').toEqual([]);
    expect(res.status).toBe(200);
    expect(body.failed ?? []).toEqual([]);
    expect(body.message).toBe('All user data has been permanently deleted');
  }, 60_000);
});
