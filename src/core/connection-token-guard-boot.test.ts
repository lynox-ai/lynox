import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LynoxConfig } from '../types/index.js';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import type { ApiProfile } from './api-store.js';

/**
 * The engine puts the B9 check on its own secret store at boot (PRD customer-granted-operator-
 * access §3.13): a token of a connection whose mandate is not live is handed out to nobody.
 *
 * `connectionTokenAllowed` is proven on its own; that says nothing about whether `Engine.init`
 * installs it. Delete the line that does and every unit test stays green while every token
 * resolves. So this boots a real Engine and asks its store.
 */
describe('Engine boot — a mandate\'s connection ends with the mandate', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const saved = new Map<string, string | undefined>();
  const setEnv = (k: string, v: string | undefined): void => {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    saved.clear();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    reloadConfig();
  });

  it('withholds the token of an ended mandate\'s connection, and hands out the owner\'s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-connguardboot-'));
    dirs.push(dir);
    setEnv('LYNOX_DATA_DIR', dir);
    setEnv('LYNOX_VAULT_KEY', 'test-vault-key-for-boot-0000000000');
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await engine.init();
    } finally {
      stderr.mockRestore();
    }

    const apis = engine.getApiStore()!;
    const secrets = engine.getSecretStore()!;
    const profile = (id: string, grant: ApiProfile['oauth_grant']): ApiProfile => ({
      id, name: id, base_url: `https://${id}.example`, description: 'd',
      auth: { type: 'oauth2', vault_keys: [], oauth: { client_id_key: 'X_CLIENT_ID' } },
      oauth_grant: grant,
    });
    apis.register(profile('ended-api', { connected_by: 'mandate:helper@example.invalid', connected_mandate_id: 'M-ENDED' }));
    apis.register(profile('owner-api', { connected_by: 'owner' }));
    secrets.set('ENDED_API_ACCESS_TOKEN', 'ended-token-value');
    secrets.set('OWNER_API_ACCESS_TOKEN', 'owner-token-value');

    expect(secrets.resolve('ENDED_API_ACCESS_TOKEN')).toBeNull();
    expect(secrets.resolve('OWNER_API_ACCESS_TOKEN')).toBe('owner-token-value');
  });
});
