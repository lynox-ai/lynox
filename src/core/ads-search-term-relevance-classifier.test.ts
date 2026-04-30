import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  classifySearchTermRelevance, parseClassification,
} from './ads-search-term-relevance-classifier.js';
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
  competitors: JSON.stringify([]),
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
              { type: 'tool_use', name: 'classify_search_term_relevance', input: toolInput },
            ],
          }),
        }),
      },
    },
  } as unknown as Anthropic;
}

describe('classifySearchTermRelevance', () => {
  it('routes terms into relevant / irrelevant / uncertain buckets', async () => {
    const client = fakeClient({
      classifications: [
        { term: 'wasserfilter test', category: 'relevant', reason: 'core product' },
        { term: 'kaffeemaschine entkalken', category: 'irrelevant', reason: 'not in catalogue' },
        { term: 'duschkopf', category: 'irrelevant', reason: 'unrelated category' },
        { term: 'glas', category: 'uncertain', reason: 'plausible bottle category' },
      ],
    });
    const result = await classifySearchTermRelevance(
      ['wasserfilter test', 'kaffeemaschine entkalken', 'duschkopf', 'glas'],
      customer, { client },
    );
    expect(result.byCategory.relevant).toEqual(['wasserfilter test']);
    expect(result.byCategory.irrelevant).toEqual(['kaffeemaschine entkalken', 'duschkopf']);
    expect(result.byCategory.uncertain).toEqual(['glas']);
  });

  it('falls back to all-uncertain when the LLM fails', async () => {
    const throwing = {
      beta: { messages: { stream: () => ({ finalMessage: async () => { throw new Error('429'); } }) } },
    } as unknown as Anthropic;
    const result = await classifySearchTermRelevance(['a', 'b'], customer, { client: throwing });
    expect(result.byCategory.uncertain).toEqual(['a', 'b']);
    expect(result.classifications.every(c => c.category === 'uncertain')).toBe(true);
  });

  it('backfills missing terms as uncertain when the model omits some', async () => {
    const client = fakeClient({
      classifications: [{ term: 'wasserfilter', category: 'relevant', reason: 'core' }],
    });
    const result = await classifySearchTermRelevance(['wasserfilter', 'missing'], customer, { client });
    expect(result.byCategory.relevant).toEqual(['wasserfilter']);
    expect(result.byCategory.uncertain).toEqual(['missing']);
  });

  it('returns empty for empty input', async () => {
    const result = await classifySearchTermRelevance([], customer);
    expect(result.classifications).toHaveLength(0);
  });
});

describe('parseClassification', () => {
  it('rejects unknown category strings, routing them to uncertain', () => {
    const result = parseClassification(['x'], {
      classifications: [{ term: 'x', category: 'NOT-A-CATEGORY', reason: '' }],
    });
    expect(result.classifications[0]!.category).toBe('uncertain');
  });

  it('returns all uncertain when input is malformed', () => {
    const result = parseClassification(['a'], 'garbage');
    expect(result.byCategory.uncertain).toEqual(['a']);
  });
});
