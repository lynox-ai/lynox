import { describe, it, expect } from 'vitest';
import { classifyAccountState } from './ads-account-state.js';
import type { AuditResult } from './ads-audit-engine.js';

function makeResult(overrides: {
  spend?: number; clicks?: number; impressions?: number;
  conversions?: number; convValue?: number; roas?: number | null; cpa?: number | null;
  mode?: 'BOOTSTRAP' | 'FIRST_IMPORT' | 'OPTIMIZE';
  highCount?: number; mediumCount?: number; blockCount?: number;
  targetRoas?: number | null;
} = {}): AuditResult {
  const findings = [
    ...Array(overrides.highCount ?? 0).fill(0).map((_, i) => ({
      area: `high_finding_${i}`, severity: 'HIGH' as const, text: '', confidence: 1, evidence: {},
    })),
    ...Array(overrides.mediumCount ?? 0).fill(0).map((_, i) => ({
      area: `medium_finding_${i}`, severity: 'MEDIUM' as const, text: '', confidence: 1, evidence: {},
    })),
    ...Array(overrides.blockCount ?? 0).fill(0).map((_, i) => ({
      area: `block_finding_${i}`, severity: 'BLOCK' as const, text: '', confidence: 1, evidence: {},
    })),
  ];
  return {
    account: {
      ads_account_id: 'X', customer_id: 'C', account_label: 'Main',
      currency_code: 'CHF', timezone: 'Europe/Zurich', mode: 'BOOTSTRAP',
      drive_folder_id: null, last_major_import_at: null,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    },
    customer: {
      customer_id: 'C', client_name: 'Test', business_model: null, offer_summary: null,
      primary_goal: null, target_roas: overrides.targetRoas ?? null,
      target_cpa_chf: null, monthly_budget_chf: null, typical_cpc_chf: null,
      country: 'CH', timezone: 'Europe/Zurich',
      languages: '["DE"]', top_products: '[]', own_brands: '[]', sold_brands: '[]',
      competitors: '[]', pmax_owned_head_terms: '[]', naming_convention_pattern: null,
      tracking_notes: '{}',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    },
    run: {
      run_id: 1, ads_account_id: 'X', status: 'SUCCESS', mode: 'BOOTSTRAP',
      started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:01:00Z',
      gas_export_lastrun: null, keywords_hash: null, previous_run_id: null,
      emitted_csv_hash: null, token_cost_micros: null, error_message: null,
    },
    previousRun: null,
    kpis: {
      spend: overrides.spend ?? 0, clicks: overrides.clicks ?? 0,
      impressions: overrides.impressions ?? 0, conversions: overrides.conversions ?? 0,
      convValue: overrides.convValue ?? 0, roas: overrides.roas ?? null, cpa: overrides.cpa ?? null,
      ctr: null,
    },
    mode: {
      detected: overrides.mode ?? 'OPTIMIZE',
      recordedRunMode: 'OPTIMIZE', recordedAccountMode: 'OPTIMIZE',
      detectedReason: 'test', performanceDays: 30,
    },
    manualChanges: null, verification: null, findings,
  } as unknown as AuditResult;
}

describe('classifyAccountState', () => {
  it('returns greenfield when there is no spend/clicks/impressions', () => {
    const v = classifyAccountState(makeResult({ spend: 0, clicks: 0, impressions: 0 }));
    expect(v.state).toBe('greenfield');
  });

  it('returns bootstrap on BOOTSTRAP mode regardless of finding count', () => {
    const v = classifyAccountState(makeResult({
      mode: 'BOOTSTRAP', spend: 100, clicks: 50, impressions: 5000, highCount: 5,
    }));
    expect(v.state).toBe('bootstrap');
  });

  it('returns bootstrap on FIRST_IMPORT mode', () => {
    const v = classifyAccountState(makeResult({
      mode: 'FIRST_IMPORT', spend: 100, clicks: 50, impressions: 5000,
    }));
    expect(v.state).toBe('bootstrap');
  });

  it('returns high_performance when ROAS ≥ 1.3× target and clean findings', () => {
    const v = classifyAccountState(makeResult({
      spend: 1000, clicks: 200, impressions: 10000, mode: 'OPTIMIZE',
      roas: 5.5, targetRoas: 4.0, highCount: 0, mediumCount: 1, blockCount: 0,
    }));
    expect(v.state).toBe('high_performance');
    expect(v.reason).toMatch(/13[78]% of target/);
  });

  it('returns messy_running when ≥ 3 HIGH findings', () => {
    const v = classifyAccountState(makeResult({
      spend: 1000, clicks: 200, impressions: 10000, mode: 'OPTIMIZE',
      roas: 3.5, targetRoas: 4.0, highCount: 3,
    }));
    expect(v.state).toBe('messy_running');
    expect(v.reason).toMatch(/3 HIGH-severity findings/);
  });

  it('returns messy_running when ROAS < 0.7× target', () => {
    const v = classifyAccountState(makeResult({
      spend: 1000, clicks: 200, impressions: 10000, mode: 'OPTIMIZE',
      roas: 2.0, targetRoas: 4.0, highCount: 0,
    }));
    expect(v.state).toBe('messy_running');
    expect(v.reason).toMatch(/under-delivers/);
  });

  it('returns messy_running on any BLOCK finding', () => {
    const v = classifyAccountState(makeResult({
      spend: 1000, clicks: 200, impressions: 10000, mode: 'OPTIMIZE',
      roas: 4.0, targetRoas: 4.0, blockCount: 1,
    }));
    expect(v.state).toBe('messy_running');
    expect(v.reason).toMatch(/1 BLOCK-severity findings/);
  });

  it('returns structured_optimizing as the default healthy state', () => {
    const v = classifyAccountState(makeResult({
      spend: 1000, clicks: 200, impressions: 10000, mode: 'OPTIMIZE',
      roas: 4.0, targetRoas: 4.0, highCount: 0, mediumCount: 1,
    }));
    expect(v.state).toBe('structured_optimizing');
  });

  it('falls back to structured_optimizing when target_roas is missing', () => {
    const v = classifyAccountState(makeResult({
      spend: 1000, clicks: 200, impressions: 10000, mode: 'OPTIMIZE',
      roas: 5.0, targetRoas: null, highCount: 1,
    }));
    expect(v.state).toBe('structured_optimizing');
  });
});
