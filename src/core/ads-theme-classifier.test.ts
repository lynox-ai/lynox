import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { classifyThemeTokens, parseClassification } from './ads-theme-classifier.js';
import type { CustomerProfileRow } from './ads-data-store.js';

const customer: CustomerProfileRow = {
  customer_id: 'aquanatura',
  client_name: 'Aquanatura GmbH',
  business_model: 'Swiss-DE direct-to-consumer e-commerce',
  offer_summary: 'Wasserfilter, Kefir-Sets, Kombucha-Brausets, Quellwasser-Karaffen',
  primary_goal: 'Conversions',
  target_roas: null, target_cpa_chf: null, monthly_budget_chf: null, typical_cpc_chf: null,
  country: 'CH',
  timezone: 'Europe/Zurich',
  languages: JSON.stringify(['DE']),
  top_products: JSON.stringify(['kefir', 'kombucha', 'wasserfilter', 'glasflasche']),
  own_brands: JSON.stringify(['aquanatura']),
  sold_brands: JSON.stringify(['hamoni', 'maunawai']),
  competitors: JSON.stringify(['brita']),
  pmax_owned_head_terms: JSON.stringify([]),
  naming_convention_pattern: null,
  tracking_notes: '{}',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function makeFakeClient(toolInput: unknown): Anthropic {
  return {
    beta: {
      messages: {
        stream: () => ({
          finalMessage: async () => ({
            content: [
              {
                type: 'tool_use',
                name: 'classify_theme_tokens',
                input: toolInput,
              },
            ],
          }),
        }),
      },
    },
  } as unknown as Anthropic;
}

describe('classifyThemeTokens', () => {
  it('routes funnel + irrelevant + actionable + uncertain into the right buckets', async () => {
    const fakeClient = makeFakeClient({
      classifications: [
        { token: 'kefir',     category: 'actionable', reason: 'core product line' },
        { token: 'kombucha',  category: 'actionable', reason: 'top product' },
        { token: 'kaufen',    category: 'funnel',     reason: 'commerce-intent verb' },
        { token: 'guenstig',  category: 'funnel',     reason: 'price modifier' },
        { token: 'water',     category: 'irrelevant', reason: 'EN word, customer is DE-only' },
        { token: 'schweiz',   category: 'irrelevant', reason: 'home market, no signal' },
        { token: 'fermenten', category: 'uncertain',  reason: 'plausibly product, unclear' },
      ],
    });

    const result = await classifyThemeTokens(
      ['kefir', 'kombucha', 'kaufen', 'guenstig', 'water', 'schweiz', 'fermenten'],
      customer, { client: fakeClient },
    );

    expect(result.byCategory.actionable).toEqual(['kefir', 'kombucha']);
    expect(result.byCategory.funnel).toEqual(['kaufen', 'guenstig']);
    expect(result.byCategory.irrelevant).toEqual(['water', 'schweiz']);
    expect(result.byCategory.uncertain).toEqual(['fermenten']);
  });

  it('falls back to all-uncertain on missing client', async () => {
    const result = await classifyThemeTokens(['kefir', 'kombucha'], customer, {
      client: null as unknown as Anthropic,
    });
    expect(result.byCategory.uncertain).toEqual(['kefir', 'kombucha']);
    expect(result.byCategory.actionable).toHaveLength(0);
    expect(result.classifications.every(c => c.category === 'uncertain')).toBe(true);
  });

  it('falls back to all-uncertain when the LLM stream throws', async () => {
    const throwingClient = {
      beta: {
        messages: {
          stream: () => ({ finalMessage: async () => { throw new Error('rate limited'); } }),
        },
      },
    } as unknown as Anthropic;
    const result = await classifyThemeTokens(['kefir'], customer, { client: throwingClient });
    expect(result.byCategory.uncertain).toEqual(['kefir']);
    expect(result.classifications[0]!.reason).toMatch(/rate limited/);
  });

  it('backfills missing tokens as uncertain when the model omits some', async () => {
    const fakeClient = makeFakeClient({
      classifications: [
        { token: 'kefir', category: 'actionable', reason: 'core' },
        // 'kombucha' missing — must backfill as uncertain.
      ],
    });
    const result = await classifyThemeTokens(['kefir', 'kombucha'], customer, { client: fakeClient });
    expect(result.byCategory.actionable).toEqual(['kefir']);
    expect(result.byCategory.uncertain).toEqual(['kombucha']);
  });

  it('returns empty classification for empty input', async () => {
    const result = await classifyThemeTokens([], customer);
    expect(result.classifications).toHaveLength(0);
    expect(result.byCategory.actionable).toHaveLength(0);
  });

  it('deduplicates input tokens before calling the model', async () => {
    const stream = vi.fn(() => ({
      finalMessage: async () => ({
        content: [{
          type: 'tool_use', name: 'classify_theme_tokens',
          input: { classifications: [{ token: 'kefir', category: 'actionable', reason: 'ok' }] },
        }],
      }),
    }));
    const fakeClient = { beta: { messages: { stream } } } as unknown as Anthropic;
    await classifyThemeTokens(['kefir', 'kefir', 'kefir'], customer, { client: fakeClient });
    const callArgs = stream.mock.calls[0]![0] as { messages: Array<{ content: string }> };
    // The user message should list the deduped token once, not three times.
    expect((callArgs.messages[0]!.content.match(/kefir/g) ?? []).length).toBe(1);
  });
});

describe('parseClassification', () => {
  it('rejects unknown categories silently', () => {
    const result = parseClassification(['kefir'], {
      classifications: [{ token: 'kefir', category: 'NOT-A-CATEGORY', reason: '' }],
    });
    expect(result.classifications[0]!.category).toBe('uncertain');
  });

  it('returns all uncertain when input is malformed', () => {
    const result = parseClassification(['a', 'b'], 'not an object');
    expect(result.byCategory.uncertain).toEqual(['a', 'b']);
  });
});
