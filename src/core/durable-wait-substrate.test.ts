import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { RunHistory } from './run-history.js';
import { TaskManager } from './task-manager.js';
import type { TaskStatus } from '../types/pipeline.js';

/**
 * The durable substrate for a parked trigger (PRD-DURABLE-WAIT-STATE §0, wave 1):
 * the two columns, the widened status type, and the two queries that PARTITION the
 * `triggers` table on it. Nothing parks a trigger yet — the park and the sweep
 * wiring land in the following slices. What is provable here is that a parked row
 * is representable, is invisible to the loop that would re-fire it, and is visible
 * to exactly the query built to end its wait.
 *
 * `waiting` is written the way the park will write it: `history.updateTrigger`,
 * which reaches `TriggerStore.updateFields` and does NOT validate. That is
 * deliberate and is itself asserted below — `TaskManager.update` still rejects the
 * value, so the parked state can never be set by a caller (agent tool, HTTP route).
 */
describe('durable wait state — the substrate (§0 E1a/E4/T3/E5)', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];
  const histories: RunHistory[] = [];

  function make(): { history: RunHistory; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-wait-'));
    tmpDirs.push(dir);
    const history = new RunHistory(join(dir, 'history.db'));
    histories.push(history);
    const engine = new EngineDb(join(dir, 'engine.db'));
    engines.push(engine);
    history.setVerbGraph(engine);
    return { history, engine };
  }

  /** A confirmed, enabled, due `run_agent` trigger — the shape that IS due. */
  function seedTrigger(history: RunHistory, id: string, nextRunAt: string): void {
    history.insertTrigger({
      id, title: 'Daily report', source: 'cron', effect: 'run_agent',
      scheduleCron: '0 9 * * *', nextRunAt, confirmedAt: '2026-01-01T00:00:00.000Z',
    });
  }

  const PAST = '2026-01-01T00:00:00.000Z';
  const NOW = '2026-06-01T00:00:00.000Z';
  const FUTURE = '2026-12-01T00:00:00.000Z';

  afterEach(() => {
    for (const h of histories) { try { h.close(); } catch { /* already closed */ } }
    histories.length = 0;
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    engines.length = 0;
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  // ── E4: the two columns, one per database ────────────────────────────────

  it('engine.db carries triggers.waiting_until (E4a, migration v12)', () => {
    const { engine } = make();
    const cols = engine.getDb().prepare('PRAGMA table_info(triggers)').all() as { name: string }[];
    expect(cols.map(c => c.name)).toContain('waiting_until');
  });

  it('history.db carries pending_prompts.trigger_id (E4b, migration v53)', () => {
    const { history } = make();
    const cols = history.getDb().prepare('PRAGMA table_info(pending_prompts)').all() as { name: string }[];
    expect(cols.map(c => c.name)).toContain('trigger_id');
  });

  it('the pointer is on the PROMPT side only — triggers gains no prompt column (E4b)', () => {
    // The direction is the decision, not an implementation detail: a second pointer
    // on the trigger side would re-open the cross-file lookup this design avoids.
    const { engine } = make();
    const cols = (engine.getDb().prepare('PRAGMA table_info(triggers)').all() as { name: string }[])
      .map(c => c.name);
    expect(cols).not.toContain('prompt_id');
    expect(cols).not.toContain('pending_prompt_id');
  });

  // ── T3 / A3 / A4: a parked trigger is not due ────────────────────────────

  it('A3 — getDue does not select a parked trigger', () => {
    const { history } = make();
    seedTrigger(history, 'due-1', PAST);
    seedTrigger(history, 'parked-1', PAST);
    expect(history.getDueTriggers().map(t => t.id).sort()).toEqual(['due-1', 'parked-1']);

    history.updateTrigger('parked-1', { status: 'waiting', waitingUntil: FUTURE });

    expect(history.getDueTriggers().map(t => t.id)).toEqual(['due-1']);
  });

  it('A4 — moving run_at into the past does not make a parked trigger due', () => {
    // The second entry point onto the same exclusion: `task_update run_at` is how a
    // user (or an injected instruction) would otherwise force a parked trigger to
    // fire while its question is still open.
    const { history } = make();
    seedTrigger(history, 'parked-1', FUTURE);
    history.updateTrigger('parked-1', { status: 'waiting', waitingUntil: FUTURE });

    history.updateTrigger('parked-1', { nextRunAt: PAST });

    expect(history.getDueTriggers()).toEqual([]);
  });

  it('A3 — the exclusion does not disturb the failed-cron auto-recovery it sits beside', () => {
    // getDue is a DENYLIST and must stay one. A failed trigger WITH a cron schedule
    // is still due (that is how a cron trigger recovers itself); rewriting the
    // clause as an allowlist of remembered statuses would silently drop it.
    const { history } = make();
    seedTrigger(history, 'failed-cron', PAST);
    history.updateTrigger('failed-cron', { status: 'failed' });

    expect(history.getDueTriggers().map(t => t.id)).toEqual(['failed-cron']);
  });

  // ── E5 / A12: the other half of the partition ────────────────────────────

  it('A12 — getExpiredWaiting selects a parked trigger whose wait has run out', () => {
    const { history } = make();
    seedTrigger(history, 'parked-1', PAST);
    history.updateTrigger('parked-1', { status: 'waiting', waitingUntil: PAST });

    expect(history.getExpiredWaitingTriggers(NOW).map(t => t.id)).toEqual(['parked-1']);
  });

  it('A12 — a parked trigger whose wait has NOT run out is left alone', () => {
    const { history } = make();
    seedTrigger(history, 'parked-1', PAST);
    history.updateTrigger('parked-1', { status: 'waiting', waitingUntil: FUTURE });

    expect(history.getExpiredWaitingTriggers(NOW)).toEqual([]);
  });

  it('the two queries PARTITION a parked trigger — it is in exactly one, always', () => {
    // The invariant the pair exists for. getDue going blind to `waiting` is only
    // safe because something else sees it; if both queries ever miss the same row
    // the trigger waits forever, and that is invisible from either query alone.
    const { history } = make();
    seedTrigger(history, 't1', PAST);

    const inExactlyOne = (now: string): boolean => {
      const due = history.getDueTriggers().some(t => t.id === 't1');
      const swept = history.getExpiredWaitingTriggers(now).some(t => t.id === 't1');
      return due !== swept;
    };

    expect(inExactlyOne(NOW)).toBe(true);                       // open + due
    history.updateTrigger('t1', { status: 'waiting', waitingUntil: PAST });
    expect(inExactlyOne(NOW)).toBe(true);                       // parked + expired
    history.updateTrigger('t1', { waitingUntil: FUTURE });
    expect(history.getDueTriggers().some(t => t.id === 't1')).toBe(false);
    expect(history.getExpiredWaitingTriggers(NOW)).toEqual([]); // parked + still waiting
  });

  it('a parked row with no deadline is NOT swept — the invariant is not silently repaired', () => {
    const { history } = make();
    seedTrigger(history, 'parked-1', PAST);
    history.updateTrigger('parked-1', { status: 'waiting' });

    expect(history.getTrigger('parked-1')?.waiting_until).toBeUndefined();
    expect(history.getExpiredWaitingTriggers(NOW)).toEqual([]);
  });

  it('the sweep is not gated on enabled or on the run_agent consent gate', () => {
    // Both gates decide whether a trigger may START a run. This query decides only
    // whether a wait that already started may END — a trigger disabled or
    // un-confirmed while parked would otherwise have no path out of `waiting`.
    const { history, engine } = make();
    seedTrigger(history, 'parked-1', PAST);
    history.updateTrigger('parked-1', { status: 'waiting', waitingUntil: PAST });
    history.setTriggerEnabled('parked-1', false);
    engine.getDb().prepare('UPDATE triggers SET confirmed_at = NULL WHERE id = ?').run('parked-1');

    expect(history.getDueTriggers()).toEqual([]);
    expect(history.getExpiredWaitingTriggers(NOW).map(t => t.id)).toEqual(['parked-1']);
  });

  // ── E4a / G2: the write path, and the one that stays closed ──────────────

  it('A8/G2 — waiting_until round-trips through history.updateTrigger → getTrigger', () => {
    const { history } = make();
    seedTrigger(history, 'parked-1', PAST);

    history.updateTrigger('parked-1', { status: 'waiting', waitingUntil: FUTURE });

    const back = history.getTrigger('parked-1');
    expect(back?.status).toBe('waiting');
    expect(back?.waiting_until).toBe(FUTURE);
  });

  it('un-parking CLEARS the deadline rather than only moving it', () => {
    const { history } = make();
    seedTrigger(history, 'parked-1', PAST);
    history.updateTrigger('parked-1', { status: 'waiting', waitingUntil: PAST });

    history.updateTrigger('parked-1', { status: 'open', waitingUntil: null });

    expect(history.getTrigger('parked-1')?.waiting_until).toBeUndefined();
    expect(history.getExpiredWaitingTriggers(NOW)).toEqual([]);
    expect(history.getDueTriggers().map(t => t.id)).toEqual(['parked-1']);
  });

  it('a trigger that LEFT `waiting` is not swept, even with its deadline still set', () => {
    // Defence in depth for the pair above: the status is what says "parked", the
    // deadline only says when. A sweep keyed on the deadline alone would end a run
    // that had already resumed — and the clearing test above cannot see that,
    // because it clears both at once.
    const { history, engine } = make();
    seedTrigger(history, 't1', PAST);
    history.updateTrigger('t1', { status: 'waiting', waitingUntil: PAST });
    // Leave the deadline behind deliberately — the shape a half-finished un-park has.
    engine.getDb().prepare("UPDATE triggers SET status = 'open' WHERE id = ?").run('t1');

    expect(history.getTrigger('t1')?.waiting_until).toBe(PAST);
    expect(history.getExpiredWaitingTriggers(NOW)).toEqual([]);
  });

  it('G1 — TaskManager.update still rejects `waiting`, for a trigger AND for a TODO', () => {
    // The engine-only property. `waiting` is reachable on the engine's own write
    // path and NOWHERE else: the tool/HTTP surface goes through TaskManager.update,
    // which validates against VALID_STATUSES. The cast is what an untyped caller
    // (the HTTP route's own cast, tools/builtin/task.ts) effectively does.
    const { history } = make();
    const tm = new TaskManager(history);
    seedTrigger(history, 'parked-1', PAST);
    const todo = tm.create({ title: 'buy milk', assignee: 'user' });

    expect(() => tm.update('parked-1', { status: 'waiting' as TaskStatus }))
      .toThrow('Invalid status: waiting');
    expect(() => tm.update(todo.id, { status: 'waiting' as TaskStatus }))
      .toThrow('Invalid status: waiting');
  });
});
