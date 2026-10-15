import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory } from './run-history.js';
import { checkPersistentBudget, configurePersistentBudget } from './session-budget.js';

/**
 * The bulk judge's spend (PRD bulk-loop §3.1, history.db v62): it calls a model without a run
 * of its own, so these rows are what puts its spend into the day, the model breakdown, the
 * totals — and the daily and monthly limits, which count from `getCostByDay`.
 */
describe('RunHistory — the bulk judge\'s spend (bulk_cost_days)', () => {
  const dirs: string[] = [];
  const histories: RunHistory[] = [];
  afterEach(() => {
    configurePersistentBudget({ costProvider: null });
    for (const h of histories) h.close();
    histories.length = 0;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });
  function history(): RunHistory {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-bulkcost-'));
    dirs.push(dir);
    const h = new RunHistory(join(dir, 'history.db'));
    histories.push(h);
    return h;
  }

  it('adds spend to today, never a run or a turn — also on a day with no run at all', () => {
    const h = history();
    h.recordBulkJudgeCost({ runId: 'b1', modelId: 'claude-haiku-4-5', tokensIn: 1000, tokensOut: 50, costUsd: 0.25 });
    h.recordBulkJudgeCost({ runId: 'b1', modelId: 'claude-haiku-4-5', tokensIn: 1000, tokensOut: 50, costUsd: 0.5 });
    const today = new Date().toISOString().slice(0, 10);
    expect(h.getCostByDay(7)).toEqual([{ day: today, cost_usd: 0.75, run_count: 0, user_turns: 0 }]);
  });

  it('adds to a day that also has runs, and to the run\'s model, without counting a run', () => {
    const h = history();
    const id = h.insertRun({ taskText: 'chat', modelTier: 'fast', modelId: 'claude-haiku-4-5' });
    h.updateRun(id, { costUsd: 1, tokensIn: 10, tokensOut: 1, status: 'completed' });
    h.recordBulkJudgeCost({ runId: 'b1', modelId: 'claude-haiku-4-5', tokensIn: 100, tokensOut: 5, costUsd: 0.5 });
    const today = new Date().toISOString().slice(0, 10);
    const [day] = h.getCostByDay(7);
    expect(day).toMatchObject({ day: today, cost_usd: 1.5, run_count: 1 });
    expect(h.getCostByModel()).toEqual([
      { model_id: 'claude-haiku-4-5', cost_usd: 1.5, run_count: 1, tokens_in: 110, tokens_out: 6, tokens_cache_read: 0, tokens_cache_write: 0 },
    ]);
  });

  it('buckets by the reader\'s timezone over the stored timestamp, like a run', () => {
    const h = history();
    const db = h.getDb();
    // 23:30 UTC yesterday is today in UTC+2 (tzOffsetMin -120).
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 3600_000).toISOString().slice(0, 10);
    db.prepare(`INSERT INTO bulk_cost_days (created_at, run_id, model_id, tokens_in, tokens_out, cost_usd) VALUES (?, 'b1', 'm', 0, 0, 1.25)`)
      .run(`${yesterday} 23:30:00`);
    const utc = h.getCostByDay(7);
    const local = h.getCostByDay(7, { tzOffsetMin: -120 });
    expect(utc).toEqual([{ day: yesterday, cost_usd: 1.25, run_count: 0, user_turns: 0 }]);
    const shifted = new Date(new Date(`${yesterday}T23:30:00Z`).getTime() + 120 * 60_000).toISOString().slice(0, 10);
    expect(local).toEqual([{ day: shifted, cost_usd: 1.25, run_count: 0, user_turns: 0 }]);
    expect(shifted).not.toBe(yesterday);
  });

  it('adds to the model breakdown and the totals without counting a run', () => {
    const h = history();
    h.recordBulkJudgeCost({ runId: 'b1', modelId: 'acme-local-7b', tokensIn: 200, tokensOut: 30, costUsd: 0.1 });
    expect(h.getCostByModel()).toEqual([
      { model_id: 'acme-local-7b', cost_usd: 0.1, run_count: 0, tokens_in: 200, tokens_out: 30, tokens_cache_read: 0, tokens_cache_write: 0 },
    ]);
    const stats = h.getStats();
    expect(stats.total_cost_usd).toBeCloseTo(0.1, 12);
    expect(stats.total_tokens_in).toBe(200);
    expect(stats.total_tokens_out).toBe(30);
    expect(stats.total_runs).toBe(0);
    expect(stats.cost_by_model.map((e) => e.model_id)).toEqual(['acme-local-7b']);
  });

  it('shows in the usage dashboard as the limits see it: day, model and kind, never a run', () => {
    const h = history();
    const id = h.insertRun({ taskText: 'chat', modelTier: 'fast', modelId: 'claude-haiku-4-5' });
    h.updateRun(id, { costUsd: 0.5, tokensIn: 10, tokensOut: 1, status: 'completed' });
    h.recordBulkJudgeCost({ runId: 'b1', modelId: 'claude-haiku-4-5', tokensIn: 100, tokensOut: 5, costUsd: 0.25 });
    h.recordBulkJudgeCost({ runId: 'b1', modelId: 'acme-local-7b', tokensIn: 200, tokensOut: 30, costUsd: 1 });
    // Yesterday to tomorrow: the window compares ISO bounds against `datetime('now')` text, as for
    // runs, so a row on the window's first day is not in it — the same for both.
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const start = new Date(today.getTime() - 24 * 3600_000);
    const end = new Date(today.getTime() + 24 * 3600_000);
    const u = h.getUsageSummary({ startIso: start.toISOString(), endIso: end.toISOString(), source: 'rolling', label: 'today' });
    expect(u.used_cents).toBe(175);
    expect(u.daily).toEqual([
      { date: start.toISOString().slice(0, 10), cost_cents: 0 },
      { date: today.toISOString().slice(0, 10), cost_cents: 175 },
    ]);
    expect(u.by_model.map((m) => [m.model_id, m.cost_cents, m.run_count, m.tokens_in, m.tokens_out])).toEqual([
      ['acme-local-7b', 100, 0, 200, 30],
      ['claude-haiku-4-5', 75, 1, 110, 6],
    ]);
    expect(u.by_kind).toEqual([{ kind: 'llm', cost_cents: 175, unit_count: 346, unit_label: 'tokens', run_count: 1 }]);
    // The headline matches what the daily limit counts.
    expect(h.getCostByDay(1)[0]!.cost_usd).toBeCloseTo(1.75, 12);
  });

  it('reaches the daily limit', () => {
    const h = history();
    configurePersistentBudget({ costProvider: h, dailyCapUSD: 1, monthlyCapUSD: 100 });
    expect(checkPersistentBudget().allowed).toBe(true);
    h.recordBulkJudgeCost({ runId: 'b1', modelId: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0.6 });
    h.recordBulkJudgeCost({ runId: 'b2', modelId: 'm', tokensIn: 0, tokensOut: 0, costUsd: 0.6 });
    expect(checkPersistentBudget().allowed).toBe(false);
  });
});
