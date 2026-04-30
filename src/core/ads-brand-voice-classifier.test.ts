import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  classifyBrandVoiceDrift, parseClassification,
} from './ads-brand-voice-classifier.js';
import type { CustomerProfileRow } from './ads-data-store.js';

const customer: CustomerProfileRow = {
  customer_id: 'aquanatura',
  client_name: 'Aquanatura',
  business_model: 'Swiss-DE D2C',
  offer_summary: 'Wasserfilter, Kefir-Sets',
  primary_goal: 'Conversions',
  target_roas: null, target_cpa_chf: null, monthly_budget_chf: null, typical_cpc_chf: null,
  country: 'CH', timezone: 'Europe/Zurich',
  languages: JSON.stringify(['DE']),
  top_products: JSON.stringify([]),
  own_brands: JSON.stringify([]),
  sold_brands: JSON.stringify([]),
  competitors: JSON.stringify([]),
  pmax_owned_head_terms: JSON.stringify([]),
  naming_convention_pattern: null,
  tracking_notes: '{}',
  personas_json: '[]',
  brand_voice_json: JSON.stringify({
    tone: 'direkt, technisch, no marketing fluff',
    do_not_use: ['game-changer', 'revolutionary', 'world-class'],
  }),
  usp_json: '[]',
  compliance_constraints: '',
  pricing_strategy: '',
  seasonal_patterns: '',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function fakeClient(toolInput: unknown): Anthropic {
  return {
    beta: {
      messages: {
        stream: () => ({
          finalMessage: async () => ({
            content: [{ type: 'tool_use', name: 'classify_brand_voice_drift', input: toolInput }],
          }),
        }),
      },
    },
  } as unknown as Anthropic;
}

describe('classifyBrandVoiceDrift', () => {
  it('routes lines into on_brand / drift / uncertain buckets', async () => {
    const client = fakeClient({
      classifications: [
        { text: 'Wasserfilter direkt vom Hersteller', category: 'on_brand',
          reason: 'matches direkt-tone, no fluff' },
        { text: 'A revolutionary game-changer for water!', category: 'drift',
          reason: 'uses both forbidden phrases' },
        { text: 'Vitalität für deinen Alltag', category: 'uncertain',
          reason: 'tone neutral but not on the do_not_use list' },
      ],
    });
    const result = await classifyBrandVoiceDrift([
      { text: 'Wasserfilter direkt vom Hersteller' },
      { text: 'A revolutionary game-changer for water!' },
      { text: 'Vitalität für deinen Alltag' },
    ], customer, { client });

    expect(result.byCategory.on_brand).toEqual(['Wasserfilter direkt vom Hersteller']);
    expect(result.byCategory.drift).toEqual(['A revolutionary game-changer for water!']);
    expect(result.byCategory.uncertain).toEqual(['Vitalität für deinen Alltag']);
  });

  it('falls back to all-uncertain when LLM throws', async () => {
    const throwing = {
      beta: { messages: { stream: () => ({ finalMessage: async () => { throw new Error('502'); } }) } },
    } as unknown as Anthropic;
    const result = await classifyBrandVoiceDrift([{ text: 'x' }], customer, { client: throwing });
    expect(result.byCategory.uncertain).toEqual(['x']);
  });

  it('deduplicates input items', async () => {
    const client = fakeClient({
      classifications: [{ text: 'same', category: 'on_brand', reason: 'ok' }],
    });
    const result = await classifyBrandVoiceDrift([
      { text: 'same' }, { text: 'same' }, { text: 'same' },
    ], customer, { client });
    expect(result.classifications).toHaveLength(1);
  });

  it('returns empty for empty input', async () => {
    const result = await classifyBrandVoiceDrift([], customer);
    expect(result.classifications).toHaveLength(0);
  });
});

describe('parseClassification', () => {
  it('rejects unknown categories silently', () => {
    const result = parseClassification(
      [{ text: 'x' }],
      { classifications: [{ text: 'x', category: 'NOT-A-CATEGORY', reason: '' }] },
    );
    expect(result.classifications[0]!.category).toBe('uncertain');
  });
});
