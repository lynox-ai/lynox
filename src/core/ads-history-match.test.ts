import { describe, it, expect } from 'vitest';
import { matchHistory } from './ads-history-match.js';
import type { MatchableEntity } from './ads-history-match.js';

const ent = (externalId: string, name: string, status?: string, payload?: Record<string, unknown>): MatchableEntity =>
  ({ externalId, name, ...(status !== undefined ? { status } : {}), ...(payload !== undefined ? { payload } : {}) });

describe('matchHistory', () => {
  it('returns empty decisions for empty inputs', () => {
    const r = matchHistory([], []);
    expect(r.decisions).toEqual([]);
    expect(r.counts).toEqual({ KEEP: 0, RENAME: 0, NEW: 0, PAUSE: 0 });
  });

  it('keeps entities matched by stable ID', () => {
    const prev = [ent('c1', 'Search_Brand_DE'), ent('c2', 'Search_Generic_DE')];
    const curr = [ent('c1', 'Search_Brand_DE'), ent('c2', 'Search_Generic_DE')];
    const r = matchHistory(prev, curr);
    expect(r.counts.KEEP).toBe(2);
    expect(r.counts.RENAME + r.counts.NEW + r.counts.PAUSE).toBe(0);
  });

  it('keeps id-matched entities even when name changes (RENAME-via-id)', () => {
    const prev = [ent('c1', 'Search_Brand_DE')];
    const curr = [ent('c1', 'DE-Search-Brand-Exact')];
    const r = matchHistory(prev, curr);
    expect(r.decisions[0]?.kind).toBe('KEEP');
    expect(r.decisions[0]?.rationale).toMatch(/Stable Google-ID/);
  });

  it('marks id-matched entity as PAUSE when current status indicates removal', () => {
    const prev = [ent('c1', 'Search_Brand_DE')];
    const curr = [ent('c1', 'Search_Brand_DE', 'PAUSED')];
    const r = matchHistory(prev, curr);
    expect(r.decisions[0]?.kind).toBe('PAUSE');
    expect(r.decisions[0]?.rationale).toMatch(/Status PAUSED/);
  });

  it('detects RENAME when ID changes but token-set ≥ threshold', () => {
    // Tokens identical, only separator changes → ratio = 1.0
    const prev = [ent('old-id', 'Search_Brand_DE_Exact')];
    const curr = [ent('new-id', 'Search-Brand-DE-Exact')];
    const r = matchHistory(prev, curr);
    expect(r.decisions[0]?.kind).toBe('RENAME');
    expect(r.decisions[0]?.previousExternalId).toBe('old-id');
    expect(r.decisions[0]?.confidence).toBe(1);
  });

  it('does NOT detect RENAME when token-set < threshold', () => {
    // {search, brand, old} vs {search, generic, new} → 1/5 = 0.2
    const prev = [ent('old-id', 'Search_Brand_Old')];
    const curr = [ent('new-id', 'Search_Generic_New')];
    const r = matchHistory(prev, curr);
    expect(r.counts.RENAME).toBe(0);
    expect(r.counts.NEW).toBe(1);
    expect(r.counts.PAUSE).toBe(1);
  });

  it('greedily picks the best rename pair when multiple candidates exist', () => {
    const prev = [ent('p1', 'Search-Brand-DE-Exact')];
    const curr = [
      ent('c1', 'Search-Brand-DE-Phrase'),       // 3/5 = 0.6 → below threshold
      ent('c2', 'Search-Brand-DE-Exact-2026'),   // 4/5 = 0.8 → at threshold
    ];
    const r = matchHistory(prev, curr);
    expect(r.counts.RENAME).toBe(1);
    const rename = r.decisions.find(d => d.kind === 'RENAME')!;
    expect(rename.externalId).toBe('c2');
    // c1 had 0.6 < 0.8, should be NEW; c2 was renamed; p1 was paired.
    expect(r.counts.NEW).toBe(1);
    expect(r.counts.PAUSE).toBe(0);
  });

  it('does not double-pair when one prev would match multiple curr above threshold', () => {
    const prev = [ent('p1', 'Brand-Exact')];
    const curr = [
      ent('c1', 'Brand-Exact-DE'),        // 2/3 = 0.67 → below threshold
      ent('c2', 'Brand-Exact-FR'),        // 2/3 = 0.67 → below threshold
    ];
    const r = matchHistory(prev, curr);
    // Both below threshold → no rename, all NEW + 1 PAUSE
    expect(r.counts.RENAME).toBe(0);
    expect(r.counts.NEW).toBe(2);
    expect(r.counts.PAUSE).toBe(1);
  });

  it('classifies only-in-current as NEW', () => {
    const prev = [ent('c1', 'Search_Brand_DE')];
    const curr = [ent('c1', 'Search_Brand_DE'), ent('c2', 'Display_Awareness_2026')];
    const r = matchHistory(prev, curr);
    const newDecision = r.decisions.find(d => d.kind === 'NEW')!;
    expect(newDecision.externalId).toBe('c2');
    expect(newDecision.previousExternalId).toBeNull();
  });

  it('classifies only-in-prev as PAUSE', () => {
    const prev = [ent('c1', 'Search_Brand_DE'), ent('c2', 'Display_Old_2025')];
    const curr = [ent('c1', 'Search_Brand_DE')];
    const r = matchHistory(prev, curr);
    const pause = r.decisions.find(d => d.kind === 'PAUSE')!;
    expect(pause.externalId).toBe('c2');
    expect(pause.previousExternalId).toBe('c2');
  });

  it('forwards payload from current entity onto KEEP/RENAME/NEW decisions', () => {
    const prev = [ent('c1', 'Search_Brand_DE')];
    const curr = [ent('c1', 'Search_Brand_DE', 'ENABLED', { budget: 100 })];
    const r = matchHistory(prev, curr);
    expect(r.decisions[0]?.payload).toEqual({ budget: 100 });
  });

  it('respects custom rename threshold', () => {
    const prev = [ent('p1', 'Search_Brand_Old')];
    const curr = [ent('c1', 'Search_Brand_New')];
    const r70 = matchHistory(prev, curr);  // 0.5 < default 0.8
    expect(r70.counts.RENAME).toBe(0);
    const r40 = matchHistory(prev, curr, { renameThreshold: 0.4 });
    expect(r40.counts.RENAME).toBe(1);
  });

  it('respects custom pausedStatuses set', () => {
    const prev = [ent('c1', 'Search_Brand_DE')];
    const curr = [ent('c1', 'Search_Brand_DE', 'CUSTOM_DEAD')];
    const r = matchHistory(prev, curr, { pausedStatuses: ['CUSTOM_DEAD'] });
    expect(r.decisions[0]?.kind).toBe('PAUSE');
  });
});
