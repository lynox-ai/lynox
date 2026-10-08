import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MISTRAL_API_BASE } from '../types/index.js';

// The user's background-task model (`background_model`): the bounds it is held to,
// the load path that drops a refused choice, and the redaction of its key.

const tmpBase = mkdtempSync(join(tmpdir(), 'lynox-bgm-'));
const fakeHome = join(tmpBase, 'home');
const fakeProject = join(tmpBase, 'project');
mkdirSync(fakeHome, { recursive: true });
mkdirSync(fakeProject, { recursive: true });

vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => fakeHome };
});

const ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'MISTRAL_API_KEY', 'FIREWORKS_API_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_BLOCKED_MODEL_IDS',
  'LYNOX_MAX_MODEL_TIER', 'LYNOX_MAX_TIER', 'LYNOX_WORKER_PROFILE', 'LYNOX_MODEL_PROFILES_JSON', 'LYNOX_DATA_DIR', 'LYNOX_DIR',
] as const;
const savedEnv: Record<string, string | undefined> = {};
const originalCwd = process.cwd;
const userConfigPath = join(fakeHome, '.lynox', 'config.json');
const writeUserConfig = (raw: string): void => {
  mkdirSync(join(fakeHome, '.lynox'), { recursive: true });
  writeFileSync(userConfigPath, raw);
};

beforeEach(() => {
  process.cwd = () => fakeProject;
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  rmSync(join(fakeHome, '.lynox'), { recursive: true, force: true });
  rmSync(join(fakeProject, '.lynox'), { recursive: true, force: true });
  vi.resetModules();
});
afterEach(() => {
  process.cwd = originalCwd;
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
});

const MINISTRAL = { provider: 'openai' as const, model_id: 'ministral-14b-2512', api_base_url: 'https://api.mistral.ai/v1' };

describe('admitBackgroundModel — the bounds a user choice is held to', () => {
  it('self-host, no bounds: the slot as given', async () => {
    const { admitBackgroundModel } = await import('./config.js');
    const slot = { ...MINISTRAL, api_key: 'own-key' };
    expect(admitBackgroundModel(slot, {})).toEqual({ ok: true, slot });
  });

  it('self-host: a Mistral slot without an endpoint gets the canonical one, not an empty base', async () => {
    const { admitBackgroundModel } = await import('./config.js');
    expect(admitBackgroundModel({ provider: 'mistral', model_id: 'ministral-14b-2512' }, {}))
      .toEqual({ ok: true, slot: { provider: 'mistral', model_id: 'ministral-14b-2512', api_base_url: MISTRAL_API_BASE } });
  });

  it('a blocked model is refused as blocked', async () => {
    const { admitBackgroundModel } = await import('./config.js');
    expect(admitBackgroundModel(MINISTRAL, { blockedModelIds: ['ministral-'] })).toEqual({ ok: false, refusal: 'blocked' });
  });

  it('the ceiling reads the model id: a balanced model under a fast ceiling is refused, under balanced it runs', async () => {
    const { admitBackgroundModel } = await import('./config.js');
    expect(admitBackgroundModel(MINISTRAL, { maxTier: 'fast' })).toEqual({ ok: false, refusal: 'over_ceiling' });
    expect(admitBackgroundModel(MINISTRAL, { maxTier: 'balanced' }).ok).toBe(true);
  });

  it('an id the registry does not know passes only under a deep ceiling', async () => {
    const { admitBackgroundModel } = await import('./config.js');
    const unknown = { provider: 'openai' as const, model_id: 'some-unlisted-model', api_base_url: 'https://llm.example/v1' };
    expect(admitBackgroundModel(unknown, { maxTier: 'balanced' })).toEqual({ ok: false, refusal: 'over_ceiling' });
    expect(admitBackgroundModel(unknown, { maxTier: 'deep' }).ok).toBe(true);
  });

  it('managed: an endpoint off the provider allowlist is refused', async () => {
    process.env['MISTRAL_API_KEY'] = 'cp-mistral-key';
    const { admitBackgroundModel } = await import('./config.js');
    const offList = { provider: 'openai' as const, model_id: 'ministral-14b-2512', api_base_url: 'https://api.mistral.ai.example' };
    expect(admitBackgroundModel(offList, { cpSupplied: true })).toEqual({ ok: false, refusal: 'not_on_managed_allowlist' });
  });

  it('managed: an allowed slot runs on the control plane key and canonical base, never the tenant\'s', async () => {
    process.env['MISTRAL_API_KEY'] = 'cp-mistral-key';
    const { admitBackgroundModel } = await import('./config.js');
    const out = admitBackgroundModel({ ...MINISTRAL, api_key: 'tenant-key' }, { cpSupplied: true });
    expect(out).toEqual({ ok: true, slot: { provider: 'openai', model_id: 'ministral-14b-2512', api_key: 'cp-mistral-key', api_base_url: MISTRAL_API_BASE } });
  });
});

describe('loadConfig — background_model', () => {
  it('a config without the key loads as before, and loading does not write the file', async () => {
    const raw = JSON.stringify({ default_tier: 'balanced', worker_profile: 'w', model_profiles: { w: { provider: 'openai', api_base_url: 'https://api.mistral.ai/v1', api_key: 'k', model_id: 'ministral-14b-2512' } } });
    writeUserConfig(raw);
    const { loadConfig } = await import('./config.js');
    const config = loadConfig();
    expect('background_model' in config).toBe(false);
    expect(config.worker_profile).toBe('w');
    expect(readFileSync(userConfigPath, 'utf8')).toBe(raw);
  });

  it('an admitted choice is kept', async () => {
    writeUserConfig(JSON.stringify({ background_model: MINISTRAL }));
    const { loadConfig } = await import('./config.js');
    expect(loadConfig().background_model).toEqual(MINISTRAL);
  });

  it('a refused choice is dropped in memory only, and the operator default stays', async () => {
    const raw = JSON.stringify({ background_model: MINISTRAL, worker_profile: 'w', model_profiles: { w: { provider: 'openai', api_base_url: 'https://api.mistral.ai/v1', api_key: 'k', model_id: 'ministral-14b-2512' } } });
    writeUserConfig(raw);
    process.env['LYNOX_MAX_MODEL_TIER'] = 'fast';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { loadConfig } = await import('./config.js');
      const config = loadConfig();
      expect(config.background_model).toBeUndefined();
      // The operator's worker profile is NOT held to the ceiling: ministral is a
      // balanced model and runs under this fast ceiling exactly as it does today.
      expect(config.worker_profile).toBe('w');
      expect(warn.mock.calls.some((c) => String(c[0]).includes('over_ceiling'))).toBe(true);
      expect(readFileSync(userConfigPath, 'utf8')).toBe(raw);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('redaction — the slot\'s key never leaves', () => {
  it('GET /api/config shape and the plugin context both drop background_model.api_key', async () => {
    const { redactConfigForResponse, stripSecretsForPlugin } = await import('./secret-fields.js');
    const planted = ['planted', 'background', 'key'].join('-');
    const config = { background_model: { ...MINISTRAL, api_key: planted } };
    expect(JSON.stringify(redactConfigForResponse(config))).not.toContain(planted);
    expect((redactConfigForResponse(config)['background_model'] as Record<string, unknown>)['model_id']).toBe('ministral-14b-2512');
    expect(JSON.stringify(stripSecretsForPlugin(config))).not.toContain(planted);
    expect(config.background_model.api_key).toBe(planted);
  });
});
