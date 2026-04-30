import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { generateStrategistBrief, parseBrief } from './ads-strategist-brief.js';
import type { AuditResult } from './ads-audit-engine.js';

function makeAuditResult(): AuditResult {
  return {
    account: { ads_account_id: 'X', customer_id: 'C', account_label: 'Main',
      currency_code: 'CHF', timezone: 'Europe/Zurich', mode: 'OPTIMIZE',
      drive_folder_id: null, last_major_import_at: null,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
    customer: {
      customer_id: 'C', client_name: 'Aquanatura', business_model: 'Swiss-DE D2C',
      offer_summary: 'Water filters + kefir', primary_goal: 'Conversions',
      target_roas: 4.0, target_cpa_chf: null, monthly_budget_chf: 3000,
      typical_cpc_chf: null, country: 'CH', timezone: 'Europe/Zurich',
      languages: '["DE"]', top_products: '["wasserfilter","kefir"]',
      own_brands: '["aquanatura"]', sold_brands: '["hamoni"]',
      competitors: '["brita"]', pmax_owned_head_terms: '[]',
      naming_convention_pattern: null, tracking_notes: '{}',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    },
    run: { run_id: 1, ads_account_id: 'X', status: 'SUCCESS', mode: 'OPTIMIZE',
      started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:01:00Z',
      gas_export_lastrun: null, keywords_hash: null, previous_run_id: null,
      emitted_csv_hash: null, token_cost_micros: null, error_message: null },
    previousRun: null,
    kpis: { spend: 1000, conversions: 50, convValue: 5000, roas: 5.0, cpa: 20,
      ctr: 0.02, clicks: 200, impressions: 10000 },
    mode: { detected: 'OPTIMIZE', recordedRunMode: 'OPTIMIZE', recordedAccountMode: 'OPTIMIZE',
      detectedReason: 'normal', performanceDays: 30 },
    manualChanges: null, verification: null,
    findings: [
      { area: 'pmax_brand_inflation', severity: 'HIGH', text: 'PMax bedient Brand-Cluster',
        confidence: 0.9, evidence: {} },
    ],
  } as unknown as AuditResult;
}

function fakeClient(toolInput: unknown): Anthropic {
  return {
    beta: {
      messages: {
        stream: () => ({
          finalMessage: async () => ({
            content: [
              { type: 'tool_use', name: 'emit_strategist_brief', input: toolInput },
            ],
          }),
        }),
      },
    },
  } as unknown as Anthropic;
}

describe('generateStrategistBrief', () => {
  it('parses headline + 3 priorities + risks + do_not_touch from the model', async () => {
    const client = fakeClient({
      headline: 'PMax Brand-Inflation: dedizierte Brand-Search ist der Hebel des Cycles.',
      priorities: [
        { title: 'Brand-Search aufsetzen', rationale: 'pmax_brand_inflation: 60-80% billiger',
          actions: ['Search-Brand-Kampagne mit Exact + Phrase', 'Tagesbudget 18 CHF'] },
        { title: 'Theme-Coverage füllen', rationale: 'pmax_theme_coverage_gap',
          actions: ['Asset-Group für Glas anlegen'] },
        { title: 'PMax-Negatives staffeln', rationale: 'change concentration vermeiden',
          actions: ['Erst Brand-Search live, dann Negatives'] },
      ],
      risks: [
        'Brand-Traffic-Gap während PMax-Negative-Aktivierung',
        'Smart-Bidding Re-Learn nach AG-Split',
      ],
      do_not_touch: ['PMax | Wasserfilter'],
    });

    const result = await generateStrategistBrief(makeAuditResult(), 'messy_running',
      'Restructure required', { client });

    expect(result.llmFailed).toBe(false);
    expect(result.headline).toMatch(/Brand-Inflation/);
    expect(result.priorities).toHaveLength(3);
    expect(result.priorities[0]!.actions.length).toBeGreaterThan(0);
    expect(result.risks).toHaveLength(2);
    expect(result.doNotTouch).toEqual(['PMax | Wasserfilter']);
  });

  it('returns fallback brief when the LLM throws', async () => {
    const throwing = {
      beta: { messages: { stream: () => ({ finalMessage: async () => { throw new Error('5xx'); } }) } },
    } as unknown as Anthropic;
    const result = await generateStrategistBrief(makeAuditResult(), 'messy_running',
      'Restructure required', { client: throwing });
    expect(result.llmFailed).toBe(true);
    expect(result.failureReason).toMatch(/5xx/);
    // Fallback synthesizes one priority per HIGH finding.
    expect(result.priorities.length).toBeGreaterThan(0);
    expect(result.risks[0]).toMatch(/LLM strategist unavailable/);
  });

  it('returns fallback when the model returns no tool_use block', async () => {
    const empty = {
      beta: { messages: { stream: () => ({ finalMessage: async () => ({ content: [] }) }) } },
    } as unknown as Anthropic;
    const result = await generateStrategistBrief(makeAuditResult(), 'structured_optimizing',
      'normal', { client: empty });
    expect(result.llmFailed).toBe(true);
  });
});

describe('parseBrief', () => {
  it('rejects empty input as failed', () => {
    const result = parseBrief({});
    expect(result.llmFailed).toBe(true);
  });

  it('rejects malformed input as failed', () => {
    const result = parseBrief('not an object');
    expect(result.llmFailed).toBe(true);
  });

  it('skips priorities without title', () => {
    const result = parseBrief({
      headline: 'X', priorities: [
        { title: '', rationale: 'r', actions: ['a'] },
        { title: 'Valid', rationale: 'r', actions: ['a'] },
      ],
      risks: [], do_not_touch: [],
    });
    expect(result.priorities).toHaveLength(1);
    expect(result.priorities[0]!.title).toBe('Valid');
  });
});
