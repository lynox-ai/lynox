// === Provider-binding round-trip tests ===
//
// Pins the F1-prevention contract surfaced by the 2026-05-17 staging QA:
// switching Mistral → Anthropic via the UI must NOT leave the Mistral
// api_base_url or openai_model_id in the PUT body, or the Anthropic
// adapter initialises with `baseURL = api.mistral.ai` and every chat 404s.

import { describe, it, expect } from 'vitest';
import {
  buildLLMConfigUpdate,
  type CatalogProvider,
  type LLMConfigUpdateInput,
} from './llm-config-update.js';

const anthropic: CatalogProvider = {
  provider: 'anthropic',
  display_name: 'Anthropic',
  models: [],
  requires_base_url: false,
  requires_region: false,
  default_residency: 'US (Anthropic; DPA + GDPR)',
};

const mistral: CatalogProvider = {
  provider: 'openai',
  preset_id: 'mistral',
  display_name: 'Mistral',
  models: [],
  requires_base_url: false,
  requires_region: false,
  default_residency: 'EU-Paris',
  base_url_default: 'https://api.mistral.ai/v1',
};

const openaiCompat: CatalogProvider = {
  provider: 'openai',
  preset_id: 'openai-compat',
  display_name: 'OpenAI-compatible endpoint',
  models: [],
  requires_base_url: true,
  requires_region: false,
  default_residency: 'depends',
};

const customAnthropicCompat: CatalogProvider = {
  provider: 'custom',
  display_name: 'Anthropic-compatible endpoint',
  models: [],
  requires_base_url: true,
  requires_region: false,
  default_residency: 'depends',
};

const vertex: CatalogProvider = {
  provider: 'vertex',
  display_name: 'Google Vertex AI',
  models: [],
  requires_base_url: false,
  requires_region: true,
  default_residency: 'GCP',
};

function input(overrides: Partial<LLMConfigUpdateInput> = {}): LLMConfigUpdateInput {
  return {
    providerLocked: false,
    activeProvider: 'anthropic',
    activeProviderEntry: anthropic,
    config: {},
    ...overrides,
  };
}

describe('buildLLMConfigUpdate — provider-binding round-trip', () => {
  describe('legacy hard-lock', () => {
    it('returns empty update when providerLocked is true', () => {
      expect(buildLLMConfigUpdate(input({ providerLocked: true }))).toEqual({});
    });

    it('returns empty update when activeProvider is null', () => {
      expect(buildLLMConfigUpdate(input({ activeProvider: null }))).toEqual({});
    });
  });

  describe('Anthropic (no base_url, no model_id)', () => {
    it('stages provider + empty api_base_url + empty openai_model_id', () => {
      const update = buildLLMConfigUpdate(input({
        activeProvider: 'anthropic',
        activeProviderEntry: anthropic,
        config: {},
      }));
      expect(update.provider).toBe('anthropic');
      expect(update.api_base_url).toBe('');
      expect(update.openai_model_id).toBe('');
    });

    it('F1 regression-pin: switching Mistral → Anthropic CLEARS stale api_base_url + openai_model_id', () => {
      // Form state still holds the previous Mistral values when the user
      // clicks Anthropic. Save must overwrite them with empty strings,
      // not omit the fields (which would let the backend merge keep them).
      const update = buildLLMConfigUpdate(input({
        activeProvider: 'anthropic',
        activeProviderEntry: anthropic,
        config: {
          api_base_url: 'https://api.mistral.ai/v1',
          openai_model_id: 'mistral-large-2512',
        },
      }));
      expect(update.api_base_url).toBe('');
      expect(update.openai_model_id).toBe('');
      // Anthropic doesn't take custom_endpoints
      expect(update.custom_endpoints).toBeUndefined();
    });
  });

  describe('Mistral preset (pinned base_url)', () => {
    it('stages the catalog base_url_default even when local config has no value', () => {
      const update = buildLLMConfigUpdate(input({
        activeProvider: 'openai',
        activeProviderEntry: mistral,
        config: {},
      }));
      expect(update.provider).toBe('openai');
      expect(update.api_base_url).toBe('https://api.mistral.ai/v1');
    });

    it('stages openai_model_id when set', () => {
      const update = buildLLMConfigUpdate(input({
        activeProvider: 'openai',
        activeProviderEntry: mistral,
        config: {
          api_base_url: 'https://api.mistral.ai/v1',
          openai_model_id: 'mistral-large-2512',
        },
      }));
      expect(update.openai_model_id).toBe('mistral-large-2512');
    });

    it('stages empty openai_model_id when blank — backend clears', () => {
      const update = buildLLMConfigUpdate(input({
        activeProvider: 'openai',
        activeProviderEntry: mistral,
        config: { api_base_url: 'https://api.mistral.ai/v1' },
      }));
      expect(update.openai_model_id).toBe('');
    });
  });

  describe('OpenAI-compatible (free-text base_url)', () => {
    it('stages user-supplied api_base_url', () => {
      const update = buildLLMConfigUpdate(input({
        activeProvider: 'openai',
        activeProviderEntry: openaiCompat,
        config: {
          api_base_url: 'https://litellm.local/v1',
          openai_model_id: 'gpt-5.4',
        },
      }));
      expect(update.api_base_url).toBe('https://litellm.local/v1');
      expect(update.openai_model_id).toBe('gpt-5.4');
    });

    it('drops a stale Mistral URL when user did not supply one', () => {
      // Edge case: previously-pinned Mistral URL kept around, user switched
      // to "OpenAI-compatible" but never typed a new URL → empty stage.
      const update = buildLLMConfigUpdate(input({
        activeProvider: 'openai',
        activeProviderEntry: openaiCompat,
        config: { api_base_url: '' },
      }));
      expect(update.api_base_url).toBe('');
    });
  });

  describe('Custom Anthropic-compatible (free-text + custom_endpoints)', () => {
    it('stages api_base_url + openai_model_id + custom_endpoints', () => {
      const update = buildLLMConfigUpdate(input({
        activeProvider: 'custom',
        activeProviderEntry: customAnthropicCompat,
        config: {
          api_base_url: 'https://anthropic-proxy.local',
          openai_model_id: 'claude-opus-4.7',
          custom_endpoints: [{ id: 'a', name: 'A', base_url: 'https://a.local' }],
        },
      }));
      expect(update.custom_endpoints).toHaveLength(1);
      expect(update.openai_model_id).toBe('claude-opus-4.7');
    });

    it('always passes [] for custom_endpoints when activeProvider is custom', () => {
      const update = buildLLMConfigUpdate(input({
        activeProvider: 'custom',
        activeProviderEntry: customAnthropicCompat,
        config: {},
      }));
      expect(update.custom_endpoints).toEqual([]);
    });
  });

  describe('Vertex (requires_region)', () => {
    it('attaches gcp_project_id + gcp_region when set', () => {
      const update = buildLLMConfigUpdate(input({
        activeProvider: 'vertex',
        activeProviderEntry: vertex,
        config: {
          gcp_project_id: 'my-proj',
          gcp_region: 'europe-west4',
        },
      }));
      expect(update.gcp_project_id).toBe('my-proj');
      expect(update.gcp_region).toBe('europe-west4');
      // Vertex has no base_url_default and no requires_base_url → clears
      expect(update.api_base_url).toBe('');
    });
  });

  describe('default_tier passthrough', () => {
    it('stages default_tier when set', () => {
      const update = buildLLMConfigUpdate(input({
        activeProvider: 'anthropic',
        activeProviderEntry: anthropic,
        config: { default_tier: 'opus' },
      }));
      expect(update.default_tier).toBe('opus');
    });

    it('omits default_tier when not set', () => {
      const update = buildLLMConfigUpdate(input({
        activeProvider: 'anthropic',
        activeProviderEntry: anthropic,
        config: {},
      }));
      expect(update).not.toHaveProperty('default_tier');
    });
  });

  describe('round-trip simulation (the exact bug from 2026-05-17 staging QA)', () => {
    it('Anthropic → Mistral → Anthropic leaves NO Mistral leak in final PUT', () => {
      // Step 1: start on Anthropic, save.
      const step1 = buildLLMConfigUpdate(input({
        activeProvider: 'anthropic',
        activeProviderEntry: anthropic,
        config: {},
      }));
      expect(step1.api_base_url).toBe('');
      expect(step1.openai_model_id).toBe('');

      // Step 2: user clicks Mistral. selectCatalogEntry stamps the pinned
      // base_url into local form state. Save sends it through.
      const step2 = buildLLMConfigUpdate(input({
        activeProvider: 'openai',
        activeProviderEntry: mistral,
        config: { api_base_url: 'https://api.mistral.ai/v1' },
      }));
      expect(step2.api_base_url).toBe('https://api.mistral.ai/v1');

      // Step 3: user clicks Anthropic again. With the F1 fix applied at
      // the selectCatalogEntry layer, local form state should be cleared.
      // Even if NOT cleared (defence-in-depth here), the build helper
      // still wipes both fields because Anthropic has neither
      // requires_base_url nor base_url_default.
      const step3WithStaleState = buildLLMConfigUpdate(input({
        activeProvider: 'anthropic',
        activeProviderEntry: anthropic,
        // Stale Mistral state — the bug scenario.
        config: {
          api_base_url: 'https://api.mistral.ai/v1',
          openai_model_id: 'mistral-large-2512',
        },
      }));
      expect(step3WithStaleState.api_base_url).toBe('');
      expect(step3WithStaleState.openai_model_id).toBe('');
    });

    it('Mistral → OpenAI-compat keeps the user-supplied URL if they typed one', () => {
      // Switching pinned-preset → free-text. User typed a fresh URL.
      const update = buildLLMConfigUpdate(input({
        activeProvider: 'openai',
        activeProviderEntry: openaiCompat,
        config: { api_base_url: 'https://litellm.local/v1' },
      }));
      expect(update.api_base_url).toBe('https://litellm.local/v1');
    });
  });
});
