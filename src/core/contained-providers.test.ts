import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { createLLMClient } from './llm-client.js';
import { OpenAIAdapter } from './openai-adapter.js';
import {
  BATCH_REFUSAL,
  PROVIDER_NOT_ON_LIST_REFUSAL,
  refusedProfileClass,
  refusedProviderClass,
  refusedSnapshotClass,
} from './contained-providers.js';
import { FixedTextError, reducedErrorText } from './error-egress.js';
import { FIREWORKS_API_BASE } from './tier-presets.js';
import { MISTRAL_API_BASE } from '../types/models.js';
import { pollBatch, submitBatch } from './batch.js';
import { reportMistralAccountHealth } from './mistral-health-check.js';
import { hasSpeakProvider, getActiveSpeakProvider } from './speak/index.js';
import { hasTranscribeProvider, getActiveTranscribeProvider, hasWhisperCpp } from './transcribe/index.js';
import { judgeModelId, JUDGE_MODELS } from './bulk-judge.js';
import { setTierSetResolver } from './tier-resolver.js';
import type { TierSet } from '../types/index.js';

const POOL_ANTHROPIC = ['sk', 'ant', 'pool', 'value'].join('-');
const POOL_FIREWORKS = ['fw', 'pool', 'value'].join('-');
const USER_KEY = ['sk', 'ant', 'user', 'value'].join('-');

/** A managed instance connected to a Shopify store: pool keys from the control plane, the switch on. */
function managedShopInstance(): void {
  vi.stubEnv('LYNOX_SHOPIFY_EXCHANGE', '1');
  vi.stubEnv('LYNOX_BILLING_TIER', 'managed');
  vi.stubEnv('ANTHROPIC_API_KEY', POOL_ANTHROPIC);
  vi.stubEnv('FIREWORKS_API_KEY', POOL_FIREWORKS);
  vi.stubEnv('MISTRAL_API_KEY', ['mistral', 'pool'].join('-'));
  vi.stubEnv('ANTHROPIC_BASE_URL', undefined);
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', undefined);
}

/** What a client does at its first request: the refusal, or a send that is not one. */
async function firstRequest(client: Anthropic): Promise<string> {
  try {
    await client.messages.create({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] });
    return 'sent';
  } catch (err) {
    return err instanceof FixedTextError ? err.fixedText : 'other error';
  }
}

beforeEach(() => {
  managedShopInstance();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the provider list (§E7, per instance)', () => {
  it('lets Anthropic with the pool key and Fireworks at its canonical endpoint through', () => {
    expect(refusedProviderClass({ wire: 'anthropic', provider: 'anthropic', baseURL: 'https://api.anthropic.com', apiKey: POOL_ANTHROPIC })).toBeNull();
    expect(refusedProviderClass({ wire: 'openai', provider: 'openai', baseURL: FIREWORKS_API_BASE, apiKey: POOL_FIREWORKS })).toBeNull();
    expect(refusedProviderClass({ wire: 'openai', provider: 'openai', baseURL: `${FIREWORKS_API_BASE}/`, apiKey: POOL_FIREWORKS })).toBeNull();
  });

  it('refuses Mistral, Vertex, another base URL and a key the user brought, each by its class', () => {
    expect(refusedProviderClass({ wire: 'openai', provider: 'openai', baseURL: MISTRAL_API_BASE, apiKey: 'k' })).toBe('mistral');
    expect(refusedProviderClass({ wire: 'vertex', provider: 'vertex', baseURL: undefined, apiKey: undefined })).toBe('vertex');
    expect(refusedProviderClass({ wire: 'openai', provider: 'openai', baseURL: FIREWORKS_API_BASE, apiKey: POOL_FIREWORKS, googleVertexAuth: true })).toBe('vertex');
    expect(refusedProviderClass({ wire: 'anthropic', provider: 'anthropic', baseURL: 'https://proxy.example/v1', apiKey: POOL_ANTHROPIC })).toBe('custom_base');
    expect(refusedProviderClass({ wire: 'anthropic', provider: 'custom', baseURL: 'https://api.anthropic.com', apiKey: POOL_ANTHROPIC })).toBe('custom_base');
    expect(refusedProviderClass({ wire: 'openai', provider: 'openai', baseURL: 'https://api.fireworks.ai.evil.example/inference/v1', apiKey: POOL_FIREWORKS })).toBe('custom_base');
    expect(refusedProviderClass({ wire: 'anthropic', provider: 'anthropic', baseURL: 'https://api.anthropic.com', apiKey: USER_KEY })).toBe('byok');
    expect(refusedProviderClass({ wire: 'openai', provider: 'openai', baseURL: FIREWORKS_API_BASE, apiKey: 'fw-user' })).toBe('byok');
  });

  it('counts every key as the user\'s on a tier where the control plane supplies none', () => {
    vi.stubEnv('LYNOX_BILLING_TIER', 'hosted');
    expect(refusedProviderClass({ wire: 'anthropic', provider: 'anthropic', baseURL: 'https://api.anthropic.com', apiKey: POOL_ANTHROPIC })).toBe('byok');
  });
});

describe('createLLMClient on an instance connected to a Shopify store', () => {
  it('builds Anthropic with the pool key and Fireworks as real clients', () => {
    expect(createLLMClient({ provider: 'anthropic' }) instanceof Anthropic).toBe(true);
    expect(createLLMClient({ provider: 'openai', apiKey: POOL_FIREWORKS, apiBaseURL: FIREWORKS_API_BASE, openaiModelId: 'm' }) instanceof OpenAIAdapter).toBe(true);
  });

  it('builds a client that sends nothing for Mistral, and says why', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const client = createLLMClient({ provider: 'openai', apiKey: 'k', apiBaseURL: MISTRAL_API_BASE, openaiModelId: 'ministral-8b-2512' });
    expect(client instanceof OpenAIAdapter).toBe(false);
    expect(await firstRequest(client)).toBe(PROVIDER_NOT_ON_LIST_REFUSAL);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses Vertex without needing its SDK', async () => {
    expect(await firstRequest(createLLMClient({ provider: 'vertex' }))).toBe(PROVIDER_NOT_ON_LIST_REFUSAL);
  });

  it('refuses a custom base URL, also one that only ANTHROPIC_BASE_URL sets', async () => {
    expect(await firstRequest(createLLMClient({ provider: 'custom', apiBaseURL: 'https://proxy.example/v1' }))).toBe(PROVIDER_NOT_ON_LIST_REFUSAL);
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://proxy.example/v1');
    expect(await firstRequest(createLLMClient({ provider: 'anthropic' }))).toBe(PROVIDER_NOT_ON_LIST_REFUSAL);
  });

  it('refuses a key the user brought', async () => {
    expect(await firstRequest(createLLMClient({ provider: 'anthropic', apiKey: USER_KEY }))).toBe(PROVIDER_NOT_ON_LIST_REFUSAL);
  });

  it('refuses a bearer token the SDK would read from the environment', async () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', ['bearer', 'user'].join('-'));
    expect(await firstRequest(createLLMClient({ provider: 'anthropic' }))).toBe(PROVIDER_NOT_ON_LIST_REFUSAL);
  });

  it('a refused request leaves as lynox\'s fixed text, quoting nothing', async () => {
    const client = createLLMClient({ provider: 'anthropic', apiKey: USER_KEY });
    let caught: unknown;
    try { client.beta.messages.stream({ model: 'm', max_tokens: 1, messages: [] }); } catch (err) { caught = err; }
    expect(reducedErrorText(caught)).toBe(PROVIDER_NOT_ON_LIST_REFUSAL);
  });

  it('without the switch builds every one of them as before', () => {
    vi.stubEnv('LYNOX_SHOPIFY_EXCHANGE', undefined);
    expect(createLLMClient({ provider: 'openai', apiKey: 'k', apiBaseURL: MISTRAL_API_BASE, openaiModelId: 'm' }) instanceof OpenAIAdapter).toBe(true);
    expect(createLLMClient({ provider: 'anthropic', apiKey: USER_KEY }) instanceof Anthropic).toBe(true);
    expect(() => createLLMClient({ provider: 'vertex' })).toThrow(/Vertex provider not initialized/);
  });
});

describe('the batch API', () => {
  it('is off on an instance connected to a Shopify store, before anything is sent', async () => {
    const create = vi.fn();
    const client = { messages: { batches: { create } } } as unknown as Anthropic;
    await expect(submitBatch(client, [], { modelTier: 'fast', maxTokens: 1, systemPrompt: undefined, systemPromptSuffix: undefined }, null, {} as never, 'ctx'))
      .rejects.toThrow(BATCH_REFUSAL);
    expect(create).not.toHaveBeenCalled();
  });

  it('does not poll a batch either, also one submitted before the switch', async () => {
    const retrieve = vi.fn();
    const client = { messages: { batches: { create: vi.fn(), retrieve, results: vi.fn() } } } as unknown as Anthropic;
    await expect(pollBatch(client, 'msgbatch_1')).rejects.toThrow(BATCH_REFUSAL);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('stops a poll that started before the switch at its next round', async () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv('LYNOX_SHOPIFY_EXCHANGE', undefined);
      // The switch comes on during the first round; without the check, the second round would
      // find the batch ended and fetch its results.
      const retrieve = vi.fn(async () => {
        if (retrieve.mock.calls.length > 1) return { processing_status: 'ended' };
        vi.stubEnv('LYNOX_SHOPIFY_EXCHANGE', '1');
        return { processing_status: 'in_progress' };
      });
      const results = vi.fn(async () => ({ async *[Symbol.asyncIterator]() { /* no items */ } }));
      const client = { messages: { batches: { create: vi.fn(), retrieve, results } } } as unknown as Anthropic;
      const polled = pollBatch(client, 'msgbatch_1');
      const outcome = expect(polled).rejects.toThrow(BATCH_REFUSAL);
      await vi.runAllTimersAsync();
      await outcome;
      expect(retrieve).toHaveBeenCalledTimes(1);
      expect(results).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the Mistral key check at listen', () => {
  it('contacts nothing on an instance connected to a Shopify store', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    await reportMistralAccountHealth();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.stubEnv('LYNOX_SHOPIFY_EXCHANGE', undefined);
    await reportMistralAccountHealth();
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

describe('speech on an instance connected to a Shopify store', () => {
  it('has no speech output and transcribes only with the local whisper.cpp', () => {
    expect(hasSpeakProvider()).toBe(false);
    expect(getActiveSpeakProvider()).toBeNull();
    expect(hasTranscribeProvider()).toBe(hasWhisperCpp());
    const stt = getActiveTranscribeProvider();
    expect(stt === null || stt.name !== 'mistral-voxtral').toBe(true);
  });

  it('without the switch a Mistral key makes both available', () => {
    vi.stubEnv('LYNOX_SHOPIFY_EXCHANGE', undefined);
    expect(hasSpeakProvider()).toBe(true);
    expect(hasTranscribeProvider()).toBe(true);
  });
});

describe('profiles and the judge', () => {
  it('drops a Mistral profile and keeps a Fireworks one', () => {
    expect(refusedProfileClass({ provider: 'openai', api_base_url: MISTRAL_API_BASE, api_key: 'k' })).toBe('mistral');
    expect(refusedProfileClass({ provider: 'openai', api_base_url: FIREWORKS_API_BASE, api_key: POOL_FIREWORKS })).toBeNull();
  });

  it('a snapshot without a base URL is Anthropic as the SDK resolves it', () => {
    expect(refusedSnapshotClass({ provider: 'anthropic' })).toBeNull();
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://proxy.example/v1');
    expect(refusedSnapshotClass({ provider: 'anthropic' })).toBe('custom_base');
  });

  it('gives a run whose tier runs at Mistral no judge, and an Anthropic run its judge', () => {
    const uc = { api_base_url: MISTRAL_API_BASE } as Parameters<typeof judgeModelId>[0];
    expect(judgeModelId(uc, 'fast', 'openai')).toBeNull();
    expect(judgeModelId({} as Parameters<typeof judgeModelId>[0], 'fast', 'anthropic')).toBe(JUDGE_MODELS.anthropic);
    vi.stubEnv('LYNOX_SHOPIFY_EXCHANGE', undefined);
    expect(judgeModelId(uc, 'fast', 'openai')).toBe(JUDGE_MODELS.mistral);
  });

  it('gives an Anthropic run behind the configured proxy no judge', () => {
    const uc = { api_base_url: 'https://proxy.example/v1' } as Parameters<typeof judgeModelId>[0];
    expect(judgeModelId(uc, 'fast', 'anthropic')).toBeNull();
    vi.stubEnv('LYNOX_SHOPIFY_EXCHANGE', undefined);
    expect(judgeModelId(uc, 'fast', 'anthropic')).toBe(JUDGE_MODELS.anthropic);
  });

  it('judges an Anthropic slot of a Fireworks instance at Anthropic, where its client goes', () => {
    // The slot has no base URL of its own, so its client goes to api.anthropic.com; the
    // instance's Fireworks base is not the slot's.
    const uc = { api_base_url: FIREWORKS_API_BASE } as Parameters<typeof judgeModelId>[0];
    try {
      setTierSetResolver({ routingMode: 'hybrid', tierSet: { fast: { provider: 'anthropic', model_id: JUDGE_MODELS.anthropic, api_key: POOL_ANTHROPIC } } as TierSet });
      expect(judgeModelId(uc, 'fast', 'openai')).toBe(JUDGE_MODELS.anthropic);
      // Without a key of its own the slot still changes the provider, so it gets its own client.
      setTierSetResolver({ tierSet: { fast: { provider: 'anthropic', model_id: JUDGE_MODELS.anthropic } } as TierSet });
      expect(judgeModelId(uc, 'fast', 'openai')).toBe(JUDGE_MODELS.anthropic);
      setTierSetResolver({ tierSet: { fast: { provider: 'anthropic', model_id: JUDGE_MODELS.anthropic, api_key: POOL_ANTHROPIC, api_base_url: 'https://proxy.example/v1' } } as TierSet });
      expect(judgeModelId(uc, 'fast', 'openai')).toBeNull();
      // A slot of the instance's own provider with a key of its own gets its own client too: the
      // instance's proxy is not where it goes.
      const behindProxy = { api_base_url: 'https://proxy.example/v1' } as Parameters<typeof judgeModelId>[0];
      setTierSetResolver({ tierSet: { fast: { provider: 'anthropic', model_id: JUDGE_MODELS.anthropic, api_key: POOL_ANTHROPIC } } as TierSet });
      expect(judgeModelId(behindProxy, 'fast', 'anthropic')).toBe(JUDGE_MODELS.anthropic);
    } finally {
      setTierSetResolver({ routingMode: 'standard', tierSet: null });
    }
  });
});
