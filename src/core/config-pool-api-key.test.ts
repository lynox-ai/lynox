import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The legacy `api_key` in config.json on a pool tier. The raw `api_key` consumers
// (spawn, pipeline, plan-task, process, the orchestrator) read it without the key
// resolver, so a key the user left in the file (from a hosted or self-host past)
// ran in the pool's place whenever the pool key was missing. On a pool tier only
// the pool key in the environment may sit there; the resolver half is in
// `llm/provider-keys.test.ts`.

const tmpBase = mkdtempSync(join(tmpdir(), 'lynox-pool-cfg-'));
const fakeHome = join(tmpBase, 'home');
const fakeProject = join(tmpBase, 'project');
mkdirSync(fakeHome, { recursive: true });
mkdirSync(fakeProject, { recursive: true });

vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => fakeHome };
});

const ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'MISTRAL_API_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_API_BASE_URL', 'ANTHROPIC_BASE_URL',
  'LYNOX_DATA_DIR', 'LYNOX_DIR', 'LYNOX_MODEL_PROFILES_JSON', 'LYNOX_WORKER_PROFILE',
] as const;
const savedEnv: Record<string, string | undefined> = {};
const originalCwd = process.cwd;
const writeUserConfig = (config: Record<string, unknown>): void => {
  mkdirSync(join(fakeHome, '.lynox'), { recursive: true });
  writeFileSync(join(fakeHome, '.lynox', 'config.json'), JSON.stringify(config));
};

beforeEach(() => {
  process.cwd = () => fakeProject;
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  rmSync(join(fakeHome, '.lynox'), { recursive: true, force: true });
  vi.resetModules();
});
afterEach(() => {
  process.cwd = originalCwd;
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

describe('loadConfig — the config file\'s api_key on a pool tier', () => {
  it.each(['managed', 'managed_pro', 'managed_max'])('%s without the pool key: the file\'s key is not loaded', async (tier) => {
    process.env['LYNOX_BILLING_TIER'] = tier;
    writeUserConfig({ api_key: 'user-file-key' });
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().api_key).toBeUndefined();
  });

  it('a pool tier with the pool key set loads the pool key', async () => {
    process.env['LYNOX_BILLING_TIER'] = 'managed';
    process.env['ANTHROPIC_API_KEY'] = 'pool-anthropic';
    writeUserConfig({ api_key: 'user-file-key' });
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().api_key).toBe('pool-anthropic');
  });

  it('a pool tier on the Mistral endpoint without the Mistral pool key does not fall back to the file\'s key', async () => {
    process.env['LYNOX_BILLING_TIER'] = 'managed';
    process.env['ANTHROPIC_API_KEY'] = 'pool-anthropic';
    writeUserConfig({ api_key: 'user-file-key', provider: 'openai', api_base_url: 'https://api.mistral.ai/v1' });
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().api_key).toBeUndefined();
  });

  it('managed BYOK (hosted) still loads the file\'s key', async () => {
    process.env['LYNOX_BILLING_TIER'] = 'hosted';
    writeUserConfig({ api_key: 'user-file-key' });
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().api_key).toBe('user-file-key');
  });

  it('self-host still loads the file\'s key', async () => {
    writeUserConfig({ api_key: 'user-file-key' });
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().api_key).toBe('user-file-key');
  });
});
