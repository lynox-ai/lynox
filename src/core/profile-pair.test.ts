import { describe, it, expect } from 'vitest';
import { pinnedModelOf, pinConfigModel, pinnedModelOfConfig } from './profile-pair.js';
import type { ProviderConfigSnapshot } from '../types/agent.js';

const pinned: ProviderConfigSnapshot = {
  provider: 'openai', apiKey: 'test-profile-key', apiBaseURL: 'https://api.mistral.ai/v1',
  openaiModelId: 'ministral-14b-2512', openaiAuth: undefined, modelPinnedByProfile: true,
};

describe('profile pair — the inherited snapshot', () => {
  it('a pinned snapshot names its model', () => {
    expect(pinnedModelOf(pinned)).toBe('ministral-14b-2512');
  });

  it('an unpinned snapshot leaves the choice to the caller, even with an openai model id', () => {
    expect(pinnedModelOf({ ...pinned, modelPinnedByProfile: undefined })).toBeUndefined();
    expect(pinnedModelOf({ ...pinned, modelPinnedByProfile: false })).toBeUndefined();
  });

  it('a pinned snapshot without a model id pins nothing, and no snapshot is no pin', () => {
    expect(pinnedModelOf({ ...pinned, openaiModelId: undefined })).toBeUndefined();
    expect(pinnedModelOf(null)).toBeUndefined();
    expect(pinnedModelOf(undefined)).toBeUndefined();
  });
});

describe('profile pair — a config overlay built from a pinned snapshot', () => {
  it('carries the pin through the object spreads the overlay goes through', () => {
    const overlay = pinConfigModel({ api_base_url: 'https://api.mistral.ai/v1' }, 'ministral-14b-2512');
    const spread = { ...overlay, disabled_tools: ['bash'] };
    expect(pinnedModelOfConfig(overlay)).toBe('ministral-14b-2512');
    expect(pinnedModelOfConfig(spread)).toBe('ministral-14b-2512');
  });

  it('cannot be set from JSON — a config file or a request body carries no pin', () => {
    const overlay = pinConfigModel({ api_base_url: 'x' }, 'ministral-14b-2512');
    expect(pinnedModelOfConfig(JSON.parse(JSON.stringify(overlay)) as object)).toBeUndefined();
    expect(pinnedModelOfConfig(JSON.parse('{"profilePinnedModel":"x","lynox.profilePinnedModel":"x"}') as object)).toBeUndefined();
  });

  it('no model id marks nothing', () => {
    expect(pinnedModelOfConfig(pinConfigModel({}, undefined))).toBeUndefined();
  });
});
