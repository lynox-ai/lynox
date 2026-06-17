import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyManagedTierSetConstraints } from './config.js';
import { MISTRAL_API_BASE } from '../types/index.js';

// PR-3d: the managed tier_set is a TENANT-WRITABLE surface. These assert the
// ship-blocker security boundary — a managed tenant cannot point a slot at an
// off-allowlist endpoint, inject a key/base_url, or spoof the Mistral host.
describe('applyManagedTierSetConstraints (PR-3d managed ship-blocker)', () => {
  const saved = { a: process.env['ANTHROPIC_API_KEY'], m: process.env['MISTRAL_API_KEY'] };
  beforeEach(() => {
    process.env['ANTHROPIC_API_KEY'] = 'cp-anthropic-key';
    process.env['MISTRAL_API_KEY'] = 'cp-mistral-key';
  });
  afterEach(() => {
    if (saved.a === undefined) delete process.env['ANTHROPIC_API_KEY']; else process.env['ANTHROPIC_API_KEY'] = saved.a;
    if (saved.m === undefined) delete process.env['MISTRAL_API_KEY']; else process.env['MISTRAL_API_KEY'] = saved.m;
  });

  it('keeps an anthropic slot, sourcing the CP key + stripping injected creds', () => {
    const out = applyManagedTierSetConstraints({
      deep: { provider: 'anthropic', model_id: 'claude-opus-4-6', api_key: 'tenant-injected', api_base_url: 'https://evil.example' },
    });
    expect(out.deep).toEqual({ provider: 'anthropic', model_id: 'claude-opus-4-6', api_key: 'cp-anthropic-key' });
    expect(out.deep!.api_base_url).toBeUndefined(); // injected base_url stripped
  });

  it('keeps a mistral slot, forcing the canonical base + CP key (no host spoof)', () => {
    const out = applyManagedTierSetConstraints({
      fast: { provider: 'mistral', model_id: 'ministral-8b-2512', api_key: 'tenant-key', api_base_url: 'https://api.mistral.ai.evil.com' },
    });
    expect(out.fast).toEqual({
      provider: 'mistral', model_id: 'ministral-8b-2512', api_key: 'cp-mistral-key', api_base_url: MISTRAL_API_BASE,
    });
  });

  it('drops an off-allowlist provider (egress block)', () => {
    const out = applyManagedTierSetConstraints({
      fast: { provider: 'openai', model_id: 'gpt-x', api_base_url: 'https://attacker.example' },
      balanced: { provider: 'custom', model_id: 'm' },
      deep: { provider: 'evil-proxy', model_id: 'm' },
    });
    expect(Object.keys(out)).toHaveLength(0);
  });

  it('drops a slot whose CP key is absent (fail-closed)', () => {
    delete process.env['MISTRAL_API_KEY'];
    const out = applyManagedTierSetConstraints({ fast: { provider: 'mistral', model_id: 'ministral-8b-2512' } });
    expect(out.fast).toBeUndefined();
  });

  // PR-4: the settings UI persists a Mistral slot in the LLMProvider form
  // (provider 'openai' + the Mistral host), matching standard-mode config —
  // NOT the registry-canonical 'mistral'. The transform must recognise it so
  // managed Hybrid works, while STILL dropping a non-Mistral 'openai' host.
  it('accepts the UI Mistral form (provider openai + Mistral host), forcing CP key + canonical base', () => {
    const out = applyManagedTierSetConstraints({
      fast: { provider: 'openai', model_id: 'ministral-8b-2512', api_base_url: 'https://api.mistral.ai/v1' },
    });
    expect(out.fast).toEqual({
      provider: 'openai', model_id: 'ministral-8b-2512', api_key: 'cp-mistral-key', api_base_url: MISTRAL_API_BASE,
    });
  });

  it('drops a provider-openai slot whose host SPOOFS Mistral (suffix attack)', () => {
    const out = applyManagedTierSetConstraints({
      fast: { provider: 'openai', model_id: 'm', api_base_url: 'https://api.mistral.ai.evil.com' },
    });
    expect(out.fast).toBeUndefined();
  });
});
