import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  classifyCompetitorTermIntent, parseClassification,
} from './ads-competitor-term-classifier.js';
import type { CustomerProfileRow } from './ads-data-store.js';

const customer: CustomerProfileRow = {
  customer_id: 'aquanatura',
  client_name: 'Aquanatura',
  business_model: 'Swiss-DE D2C water-filter shop',
  offer_summary: 'Water filters, glass bottles, kefir/kombucha kits',
  primary_goal: 'Conversions',
  target_roas: null, target_cpa_chf: null, monthly_budget_chf: null, typical_cpc_chf: null,
  country: 'CH',
  timezone: 'Europe/Zurich',
  languages: JSON.stringify(['DE']),
  top_products: JSON.stringify(['wasserfilter', 'kefir']),
  own_brands: JSON.stringify(['aquanatura']),
  sold_brands: JSON.stringify([]),
  competitors: JSON.stringify(['brita', 'soulbottle']),
  pmax_owned_head_terms: JSON.stringify([]),
  naming_convention_pattern: null,
  tracking_notes: '{}',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function fakeClient(toolInput: unknown): Anthropic {
  return {
    beta: {
      messages: {
        stream: () => ({
          finalMessage: async () => ({
            content: [
              { type: 'tool_use', name: 'classify_competitor_term_intent', input: toolInput },
            ],
          }),
        }),
      },
    },
  } as unknown as Anthropic;
}

describe('classifyCompetitorTermIntent', () => {
  it('routes terms into intentional / leak / uncertain buckets', async () => {
    const client = fakeClient({
      classifications: [
        { term: 'brita filter', matched_competitor: 'brita',
          category: 'unintentional_leak', reason: 'small DTC, not running conquest campaigns' },
        { term: 'brita alternative', matched_competitor: 'brita',
          category: 'intentional_competitive', reason: 'alternative-keyword pattern is a deliberate conquest play' },
        { term: 'soulbottle', matched_competitor: 'soulbottle',
          category: 'uncertain', reason: 'could be either' },
      ],
    });
    const result = await classifyCompetitorTermIntent([
      { term: 'brita filter', matched_competitor: 'brita' },
      { term: 'brita alternative', matched_competitor: 'brita' },
      { term: 'soulbottle', matched_competitor: 'soulbottle' },
    ], customer, { client });

    expect(result.byCategory.unintentional_leak).toEqual(['brita filter']);
    expect(result.byCategory.intentional_competitive).toEqual(['brita alternative']);
    expect(result.byCategory.uncertain).toEqual(['soulbottle']);
  });

  it('falls back to all-uncertain when the LLM throws', async () => {
    const throwing = {
      beta: { messages: { stream: () => ({ finalMessage: async () => { throw new Error('502'); } }) } },
    } as unknown as Anthropic;
    const result = await classifyCompetitorTermIntent([
      { term: 'a', matched_competitor: 'x' },
      { term: 'b', matched_competitor: 'y' },
    ], customer, { client: throwing });
    expect(result.byCategory.uncertain).toEqual(['a', 'b']);
    expect(result.classifications.every(c => c.category === 'uncertain')).toBe(true);
  });

  it('backfills missing items as uncertain', async () => {
    const client = fakeClient({
      classifications: [{ term: 'brita filter', matched_competitor: 'brita',
        category: 'unintentional_leak', reason: 'leak' }],
    });
    const result = await classifyCompetitorTermIntent([
      { term: 'brita filter', matched_competitor: 'brita' },
      { term: 'soulbottle', matched_competitor: 'soulbottle' },
    ], customer, { client });
    expect(result.byCategory.unintentional_leak).toEqual(['brita filter']);
    expect(result.byCategory.uncertain).toEqual(['soulbottle']);
  });

  it('returns empty for empty input', async () => {
    const result = await classifyCompetitorTermIntent([], customer);
    expect(result.classifications).toHaveLength(0);
  });

  it('deduplicates input items by (term, competitor)', async () => {
    const client = fakeClient({
      classifications: [{ term: 'brita filter', matched_competitor: 'brita',
        category: 'unintentional_leak', reason: 'leak' }],
    });
    const result = await classifyCompetitorTermIntent([
      { term: 'brita filter', matched_competitor: 'brita' },
      { term: 'brita filter', matched_competitor: 'brita' },
      { term: 'brita filter', matched_competitor: 'brita' },
    ], customer, { client });
    expect(result.classifications).toHaveLength(1);
  });
});

describe('parseClassification', () => {
  it('rejects unknown categories silently', () => {
    const result = parseClassification(
      [{ term: 'x', matched_competitor: 'y' }],
      { classifications: [{ term: 'x', matched_competitor: 'y', category: 'NOT-A-CATEGORY', reason: '' }] },
    );
    expect(result.classifications[0]!.category).toBe('uncertain');
  });

  it('returns all uncertain when input is malformed', () => {
    const result = parseClassification(
      [{ term: 'a', matched_competitor: 'b' }],
      'garbage',
    );
    expect(result.byCategory.uncertain).toEqual(['a']);
  });
});
