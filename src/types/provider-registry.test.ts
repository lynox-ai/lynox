import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  getModelId,
  setOpenAIModelResolver,
  registerProvider,
  getProviderDescriptor,
  resolveModelIdViaRegistry,
  MODEL_MAP,
  VERTEX_MODEL_MAP,
  MISTRAL_MODEL_MAP,
  type ModelTier,
} from './models.js';

const TIERS: ModelTier[] = ['fast', 'balanced', 'deep'];

/** Reset the process-global openai tier resolver to the unbootstrapped state. */
function resetOpenAIResolver(): void {
  setOpenAIModelResolver({ map: null, fallbackModelId: null });
}

describe('provider registry — byte-parity resolution (PR-1a)', () => {
  beforeEach(resetOpenAIResolver);
  afterAll(resetOpenAIResolver);

  // The fixture matrix: every provider × every tier × every openai bootstrap
  // state must resolve identically to the pre-registry getModelId branches.

  describe('static providers route to their tier map', () => {
    for (const tier of TIERS) {
      it(`anthropic ${tier} → MODEL_MAP`, () => {
        expect(getModelId(tier, 'anthropic')).toBe(MODEL_MAP[tier]);
      });
      it(`vertex ${tier} → VERTEX_MODEL_MAP`, () => {
        expect(getModelId(tier, 'vertex')).toBe(VERTEX_MODEL_MAP[tier]);
      });
      it(`custom ${tier} → MODEL_MAP (proxy maps Anthropic ids)`, () => {
        expect(getModelId(tier, 'custom')).toBe(MODEL_MAP[tier]);
      });
    }
  });

  describe('openai 3-stage fallback parity', () => {
    it('unbootstrapped → Anthropic MODEL_MAP (legacy/test behaviour)', () => {
      for (const tier of TIERS) expect(getModelId(tier, 'openai')).toBe(MODEL_MAP[tier]);
    });
    it('fallback id only → that id for every tier', () => {
      setOpenAIModelResolver({ fallbackModelId: 'my-model-1' });
      for (const tier of TIERS) expect(getModelId(tier, 'openai')).toBe('my-model-1');
    });
    it('active map (Mistral) → map[tier]', () => {
      setOpenAIModelResolver({ map: MISTRAL_MODEL_MAP });
      for (const tier of TIERS) expect(getModelId(tier, 'openai')).toBe(MISTRAL_MODEL_MAP[tier]);
    });
    it('map wins over fallback id', () => {
      setOpenAIModelResolver({ map: MISTRAL_MODEL_MAP, fallbackModelId: 'ignored' });
      for (const tier of TIERS) expect(getModelId(tier, 'openai')).toBe(MISTRAL_MODEL_MAP[tier]);
    });
    it('reads resolver state at call time (config reload applies)', () => {
      expect(getModelId('balanced', 'openai')).toBe(MODEL_MAP['balanced']);
      setOpenAIModelResolver({ map: MISTRAL_MODEL_MAP });
      expect(getModelId('balanced', 'openai')).toBe(MISTRAL_MODEL_MAP['balanced']);
    });
  });

  describe('Mistral first-class identity', () => {
    it('registers id:mistral on the openai wire path', () => {
      const d = getProviderDescriptor('mistral');
      expect(d?.id).toBe('mistral');
      expect(d?.wireClient).toBe('openai');
    });
    it('resolves the Mistral tier ladder', () => {
      for (const tier of TIERS) {
        expect(resolveModelIdViaRegistry(tier, 'mistral')).toBe(MISTRAL_MODEL_MAP[tier]);
      }
    });
    it('is additive — does not change existing openai resolution', () => {
      // No caller resolves by the 'mistral' key; Mistral still flows through the
      // 'openai' provider + the dynamic map, so openai resolution is untouched.
      for (const tier of TIERS) expect(getModelId(tier, 'openai')).toBe(MODEL_MAP[tier]);
    });
  });

  describe('open registry — a stub registers + resolves without editing the enum', () => {
    it('a stub descriptor resolves via the registry', () => {
      registerProvider({
        id: 'stub-provider',
        wireClient: 'anthropic',
        defaultTierModels: MODEL_MAP,
        resolveModelId: () => 'stub-model-x',
      });
      expect(getProviderDescriptor('stub-provider')?.id).toBe('stub-provider');
      expect(resolveModelIdViaRegistry('deep', 'stub-provider')).toBe('stub-model-x');
    });
    it('an unregistered key degrades to MODEL_MAP instead of throwing', () => {
      expect(resolveModelIdViaRegistry('fast', 'never-registered')).toBe(MODEL_MAP['fast']);
    });
  });
});
