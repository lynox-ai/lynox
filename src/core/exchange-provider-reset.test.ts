import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDataDir, reloadConfig, loadConfig } from './config.js';
import { resetProviderOffList, readProviderResetNotice, clearProviderResetNotice } from './exchange-provider-reset.js';
import { refusedProviderClass } from './contained-providers.js';

// An instance that picked Mistral in Settings gets the Shopify exchange. Left alone, no model call
// goes out and the page asks a managed customer for an Anthropic key of their own. The engine now
// puts the pick back on Anthropic at boot and keeps a notice of it for the line the page shows.

const MISTRAL = { provider: 'openai', api_base_url: 'https://api.eu.mistral.ai/v1', openai_model_id: 'mistral-large-2512' };
const POOL_KEY = 'sk-ant-pool-test';

let dir: string;

function writeConfig(cfg: Record<string, unknown>): void {
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg));
}
function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8')) as Record<string, unknown>;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-provider-reset-'));
  setDataDir(dir);
  reloadConfig();
  vi.stubEnv('LYNOX_SHOPIFY_EXCHANGE', '1');
  vi.stubEnv('LYNOX_BILLING_TIER', 'managed');
  vi.stubEnv('ANTHROPIC_API_KEY', POOL_KEY);
  vi.stubEnv('MISTRAL_API_KEY', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  setDataDir(null);
  reloadConfig();
  rmSync(dir, { recursive: true, force: true });
});

describe('a Mistral pick on an instance that gets the Shopify exchange', () => {
  it('goes back to Anthropic, keeps the rest of the config and records the notice', () => {
    writeConfig({ ...MISTRAL, default_tier: 'fast', api_key: 'mistral-key-staged', llm_mode: 'eu-sovereign' });
    const notice = resetProviderOffList(new Date('2026-11-13T12:00:00Z'));

    expect(notice).toEqual({ from: 'Mistral', at: '2026-11-13T12:00:00.000Z' });
    expect(readConfig()).toEqual({ provider: 'anthropic', default_tier: 'fast' });
    expect(readProviderResetNotice()).toEqual(notice);
  });

  it('then runs on Anthropic with the pool key, which the provider list lets through', () => {
    writeConfig(MISTRAL);
    resetProviderOffList();
    reloadConfig();
    const cfg = loadConfig();

    expect(cfg.provider).toBe('anthropic');
    expect(cfg.api_key).toBe(POOL_KEY);
    expect(refusedProviderClass({ wire: 'anthropic', provider: 'anthropic', baseURL: cfg.api_base_url, apiKey: cfg.api_key })).toBeNull();
  });

  it('keeps a stored key that is the pool key itself', () => {
    writeConfig({ ...MISTRAL, api_key: POOL_KEY });
    resetProviderOffList();
    expect(readConfig()['api_key']).toBe(POOL_KEY);
  });

  it('reads the global Mistral endpoint as Mistral too', () => {
    writeConfig({ ...MISTRAL, api_base_url: 'https://api.mistral.ai/v1' });
    expect(resetProviderOffList()).not.toBeNull();
    expect(readConfig()['provider']).toBe('anthropic');
  });
});

describe('where nothing changes', () => {
  it('without the exchange: the Mistral pick stays, and a notice from an earlier boot goes', () => {
    writeConfig(MISTRAL);
    resetProviderOffList();
    writeConfig(MISTRAL);
    vi.stubEnv('LYNOX_SHOPIFY_EXCHANGE', '');
    expect(resetProviderOffList()).toBeNull();
    expect(readConfig()).toEqual(MISTRAL);
    expect(readProviderResetNotice()).toBeNull();
  });

  it('keeps a residency setting the Mistral tile did not stage', () => {
    writeConfig({ ...MISTRAL, llm_mode: 'standard' });
    resetProviderOffList();
    expect(readConfig()['llm_mode']).toBe('standard');
  });

  it('when the control plane does not supply the keys (self-host, BYOK)', () => {
    vi.stubEnv('LYNOX_BILLING_TIER', 'hosted');
    writeConfig(MISTRAL);
    expect(resetProviderOffList()).toBeNull();
    expect(readConfig()).toEqual(MISTRAL);
  });

  it('without an Anthropic key to run on', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    writeConfig(MISTRAL);
    expect(resetProviderOffList()).toBeNull();
    expect(readConfig()).toEqual(MISTRAL);
  });

  it('on Anthropic already, on another OpenAI-compatible host, or with no config at all', () => {
    writeConfig({ provider: 'anthropic' });
    expect(resetProviderOffList()).toBeNull();
    writeConfig({ provider: 'openai', api_base_url: 'https://api.groq.com/openai/v1', openai_model_id: 'x' });
    expect(resetProviderOffList()).toBeNull();
    rmSync(join(dir, 'config.json'));
    expect(resetProviderOffList()).toBeNull();
    expect(existsSync(join(dir, 'config.json'))).toBe(false);
    expect(readProviderResetNotice()).toBeNull();
  });

  it('a host that only names Mistral in its path is not Mistral', () => {
    writeConfig({ provider: 'openai', api_base_url: 'https://attacker.example.com/api.mistral.ai/v1', openai_model_id: 'x' });
    expect(resetProviderOffList()).toBeNull();
  });
});

describe('the notice', () => {
  it('ends when cleared, and clearing twice is fine', () => {
    writeConfig(MISTRAL);
    resetProviderOffList();
    clearProviderResetNotice();
    expect(readProviderResetNotice()).toBeNull();
    expect(() => clearProviderResetNotice()).not.toThrow();
  });

  it('reads anything but its own shape as none', () => {
    for (const raw of ['not json', 'null', '{"from":""}', '{"from":"","at":"2026-11-13T12:00:00.000Z"}', '{"from":"Mistral"}', '{"from":3,"at":"x"}']) {
      writeFileSync(join(dir, 'provider-reset.json'), raw);
      expect(readProviderResetNotice(), raw).toBeNull();
    }
  });
});
