import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { assertHostPolicy } from './network-guard.js';
import { hostPolicyOf } from './tool-context.js';
import type { LynoxConfig } from '../types/index.js';

/**
 * The egress settings (`network_policy`, the operator host floor, `enforce_https`) are written
 * onto the engine's ToolContext at boot. A change through the config route reaches the engine
 * as `reloadUserConfig`; this proves the tools then enforce the NEW value, in both directions,
 * without a restart. Real Engine against a tmp data dir, the same shape as
 * `engine-init-wiring-boot.test.ts`.
 */
describe('Engine — egress settings follow a config reload', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const ENV_KEYS = [
    'LYNOX_DATA_DIR', 'LYNOX_NETWORK_POLICY', 'LYNOX_NETWORK_ALLOWED_HOSTS',
    'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_VAULT_KEY',
  ] as const;
  const saved = new Map<string, string | undefined>();

  function setEnv(key: string, value: string | undefined): void {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    saved.clear();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    reloadConfig();
  });

  function freshDataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-egress-reload-'));
    dirs.push(dir);
    for (const k of ENV_KEYS) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    return dir;
  }

  function writeUserConfig(dir: string, config: Record<string, unknown>): void {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
  }

  async function boot(): Promise<Engine> {
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    return engine;
  }

  async function reloadWith(engine: Engine, dir: string, config: Record<string, unknown>): Promise<void> {
    writeUserConfig(dir, config);
    reloadConfig();
    await engine.reloadUserConfig();
  }

  /** The gate `http_request` runs before every request, on the engine's own context. */
  function gate(engine: Engine, url: string): () => void {
    return () => assertHostPolicy(url, { surface: 'full-control' }, hostPolicyOf(engine.getToolContext()));
  }

  it('a policy tightened at runtime is enforced on the next call, and loosening lifts it again', async () => {
    const dir = freshDataDir();
    writeUserConfig(dir, {});
    const engine = await boot();
    // CONTROL: the boot value lets the request through.
    expect(gate(engine, 'https://api.example.com/v1')).not.toThrow();

    await reloadWith(engine, dir, { network_policy: 'deny-all' });
    // FIXTURE GUARD: the new value reached the engine's config.
    expect(engine.getUserConfig().network_policy).toBe('deny-all');
    expect(gate(engine, 'https://api.example.com/v1')).toThrow(/network_policy=deny-all/);

    await reloadWith(engine, dir, {});
    expect(gate(engine, 'https://api.example.com/v1')).not.toThrow();
  });

  it('a host floor changed at runtime replaces the boot floor under allow-list', async () => {
    const dir = freshDataDir();
    writeUserConfig(dir, { network_policy: 'allow-list', network_allowed_hosts: ['old.example.com'] });
    const engine = await boot();
    expect(gate(engine, 'https://old.example.com/')).not.toThrow();
    expect(gate(engine, 'https://new.example.com/')).toThrow(/Blocked/);

    await reloadWith(engine, dir, { network_policy: 'allow-list', network_allowed_hosts: ['*.new.example.com', 'new.example.com'] });
    expect(gate(engine, 'https://new.example.com/')).not.toThrow();
    expect(gate(engine, 'https://api.new.example.com/')).not.toThrow();
    expect(gate(engine, 'https://old.example.com/')).toThrow(/Blocked/);
  });

  it('a reload the endpoint gate refuses leaves the egress settings at their previous value', async () => {
    const dir = freshDataDir();
    writeUserConfig(dir, {});
    const engine = await boot();

    // An unaccepted custom endpoint makes the reload throw and roll the config back. The policy
    // in the same file must not take effect either: the refused config is not the active one.
    writeUserConfig(dir, {
      provider: 'openai', api_base_url: 'https://my-litellm.example.com/v1', openai_model_id: 'gpt-4o-mini',
      network_policy: 'deny-all',
    });
    reloadConfig();
    await expect(engine.reloadUserConfig()).rejects.toThrow(/my-litellm\.example\.com/);
    // FIXTURE GUARD: the rollback happened.
    expect(engine.getUserConfig().network_policy).toBeUndefined();
    expect(gate(engine, 'https://api.example.com/v1')).not.toThrow();
  });

  it('a credential reload, which installs a freshly loaded config too, applies its egress settings', async () => {
    const dir = freshDataDir();
    writeUserConfig(dir, {});
    const engine = await boot();
    expect(gate(engine, 'https://api.example.com/v1')).not.toThrow();

    writeUserConfig(dir, { network_policy: 'deny-all' });
    reloadConfig();
    await engine.reloadCredentials();
    expect(engine.getUserConfig().network_policy).toBe('deny-all');
    expect(gate(engine, 'https://api.example.com/v1')).toThrow(/network_policy=deny-all/);
  });

  it('enforce_https switched on at runtime refuses plain http on the next call', async () => {
    const dir = freshDataDir();
    writeUserConfig(dir, {});
    const engine = await boot();
    expect(gate(engine, 'http://api.example.com/')).not.toThrow();

    await reloadWith(engine, dir, { enforce_https: true });
    expect(gate(engine, 'http://api.example.com/')).toThrow(/enforce_https/);
    // CONTROL: https on the same host is unaffected.
    expect(gate(engine, 'https://api.example.com/')).not.toThrow();
  });
});
