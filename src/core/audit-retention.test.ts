import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineDb } from './engine-db.js';
import { AuditLog, newCorrelationId } from './audit-log.js';
import { AUDIT_RETENTION_MS, FOLDED_POLLS, FOLD_DAYS_PER_SWEEP, RETENTION_ACTION, RETENTION_ACTOR, sweepAuditLog } from './audit-retention.js';
import { buildTrail, INTERFACE_POLLS, readTrailPage, type TrailEvent, type TrailSources } from './audit-trail-view.js';
import type { RequestPrincipal } from './request-principal.js';

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;
const ana: RequestPrincipal = { kind: 'mandate', email: 'ana@example.invalid', mandateId: 'm-ana', display: 'Ana' };
const ben: RequestPrincipal = { kind: 'mandate', email: 'ben@example.invalid', mandateId: 'm-ben', display: 'Ben' };
const PROVIDERS = 'GET /api/providers/status';
const ACTIVE = 'GET /api/runs/active';
/** On the interface-poll list, but also opened on purpose (the Tasks view): never folded. */
const TASK_LIST = 'GET /api/tasks';

/** A sweep in these tests that must not refuse a day: a refusal fails the test. */
const noFail = (day: string, err: unknown): void => { throw new Error(`day ${day} refused: ${String(err)}`); };

const quiet: TrailSources = {
  runStatus: () => undefined,
  questionOfRun: () => false,
  questionInSession: () => false,
  planRunRunning: () => false,
  bulkRunOpen: () => false,
  approvalOf: () => undefined,
};

interface Row {
  id: number; ts: string; actor_kind: string; actor_email: string | null; actor_display: string | null; mandate_id: string | null;
  action: string; target: string | null; phase: string; correlation_id: string; poll_count: number | null; poll_last: string | null;
}

describe('the actor trail keeps what it holds for a set time', () => {
  let dir: string;
  let engine: EngineDb;
  let log: AuditLog;
  const all = (): Row[] => engine.getDb().prepare('SELECT * FROM audit_log ORDER BY id').all() as Row[];
  const read = (who: RequestPrincipal, action: string, at: string): void => {
    log.record({ principal: who, action, target: action.slice(4), phase: 'read', correlationId: newCorrelationId(), at });
  };
  const step = (who: RequestPrincipal, at: string): void => {
    const c = newCorrelationId();
    log.record({ principal: who, action: 'POST /api/tasks', target: '/api/tasks', phase: 'attempt', correlationId: c, at });
    log.record({ principal: who, action: 'POST /api/tasks', target: '/api/tasks', phase: 'done', correlationId: c, at });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-audit-retention-'));
    engine = new EngineDb(join(dir, 'engine.db'));
    log = new AuditLog(engine.getDb());
  });
  afterEach(() => { engine.close(); rmSync(dir, { recursive: true, force: true }); });

  describe('polls are folded into one row per person, route and day once the day is 30 days past', () => {
    it('folds each person\'s polls of a route into a day row with the count, the first and the last time', () => {
      read(ana, PROVIDERS, '2026-10-20T08:00:00.000Z');
      read(ana, ACTIVE, '2026-10-20T08:00:01.000Z');
      read(ana, PROVIDERS, '2026-10-20T09:30:00.000Z');
      read(ben, PROVIDERS, '2026-10-20T10:00:00.000Z');
      read(ana, PROVIDERS, '2026-10-20T17:45:00.000Z');
      read(ana, ACTIVE, '2026-10-20T17:45:01.000Z');
      const firstProviders = all().find((r) => r.action === PROVIDERS && r.actor_email === ana.email)!.id;

      expect(sweepAuditLog(engine.getDb(), NOW, noFail)).toEqual({ folded: 6, dayRows: 3, deleted: 0 });

      const rows = all();
      expect(rows).toHaveLength(3);
      const anaProviders = rows.find((r) => r.action === PROVIDERS && r.actor_email === ana.email)!;
      expect(anaProviders).toMatchObject({
        id: firstProviders, ts: '2026-10-20T08:00:00.000Z', poll_last: '2026-10-20T17:45:00.000Z', poll_count: 3,
        phase: 'read', actor_kind: 'mandate', actor_display: 'Ana', mandate_id: 'm-ana', target: null,
      });
      expect(rows.find((r) => r.action === ACTIVE)).toMatchObject({ poll_count: 2, ts: '2026-10-20T08:00:01.000Z', poll_last: '2026-10-20T17:45:01.000Z' });
      expect(rows.find((r) => r.actor_email === ben.email)).toMatchObject({ poll_count: 1, ts: '2026-10-20T10:00:00.000Z', poll_last: '2026-10-20T10:00:00.000Z' });
    });

    it('folds a day only once it is entirely more than 30 days past', () => {
      read(ana, PROVIDERS, '2026-10-24T23:59:59.000Z');
      read(ana, PROVIDERS, '2026-10-24T23:59:59.500Z');
      read(ana, PROVIDERS, '2026-10-25T00:00:00.000Z');
      read(ana, PROVIDERS, '2026-10-25T12:00:00.000Z');

      expect(sweepAuditLog(engine.getDb(), NOW, noFail)).toEqual({ folded: 2, dayRows: 1, deleted: 0 });
      const rows = all();
      expect(rows.map((r) => [r.ts, r.poll_count])).toEqual([
        ['2026-10-24T23:59:59.000Z', 2],
        ['2026-10-25T00:00:00.000Z', null],
        ['2026-10-25T12:00:00.000Z', null],
      ]);
    });

    it('folds only routes no person opens on purpose, all of them on the interface-poll list', () => {
      expect(FOLDED_POLLS.length).toBeGreaterThan(0);
      for (const r of FOLDED_POLLS) expect(INTERFACE_POLLS.has(r)).toBe(true);
      expect(FOLDED_POLLS).not.toContain(TASK_LIST);
      expect(FOLDED_POLLS).not.toContain('GET /api/history/cost/daily');
    });

    it('keeps a read the person made themselves, a read of a route also opened on purpose, and every step as single rows', () => {
      read(ana, 'GET /api/inbox/items', '2026-10-20T08:00:00.000Z');
      read(ana, 'GET /api/inbox/items', '2026-10-20T08:05:00.000Z');
      read(ana, TASK_LIST, '2026-10-20T08:06:00.000Z');
      read(ana, TASK_LIST, '2026-10-20T08:07:00.000Z');
      read(ana, 'GET /api/history/cost/daily', '2026-10-20T08:08:00.000Z');
      read(ana, 'GET /api/history/cost/daily', '2026-10-20T08:09:00.000Z');
      step(ana, '2026-10-20T08:10:00.000Z');
      // A route on the poll list, but not a read: never folded.
      log.record({ principal: ana, action: PROVIDERS, target: '/api/tasks', phase: 'refused', correlationId: newCorrelationId(), at: '2026-10-20T08:20:00.000Z' });
      const before = all();

      expect(sweepAuditLog(engine.getDb(), NOW, noFail)).toEqual({ folded: 0, dayRows: 0, deleted: 0 });
      expect(all()).toEqual(before);
    });

    it('keeps two rows when the person\'s name changed during the day', () => {
      read(ana, PROVIDERS, '2026-10-20T08:00:00.000Z');
      read({ ...ana, display: 'Ana B.' }, PROVIDERS, '2026-10-20T09:00:00.000Z');
      read(ana, PROVIDERS, '2026-10-20T10:00:00.000Z');

      sweepAuditLog(engine.getDb(), NOW, noFail);
      expect(all().map((r) => [r.actor_display, r.poll_count])).toEqual([['Ana', 2], ['Ana B.', 1]]);
    });

    it('folds a group whose person has no name and no grant, and keeps them unnamed', () => {
      const anon: RequestPrincipal = { kind: 'mandate', email: 'anon@example.invalid' };
      read(anon, PROVIDERS, '2026-10-20T08:00:00.000Z');
      read(anon, PROVIDERS, '2026-10-20T09:00:00.000Z');
      expect(sweepAuditLog(engine.getDb(), NOW, noFail)).toEqual({ folded: 2, dayRows: 1, deleted: 0 });
      expect(all()).toEqual([expect.objectContaining({ actor_email: 'anon@example.invalid', actor_display: null, mandate_id: null, poll_count: 2 })]);
    });

    it('folds the oldest days first and at most a set number per sweep; the next sweep goes on', () => {
      const days = FOLD_DAYS_PER_SWEEP + 2;
      // The newer days on the route an index on (action, ts) lists first, so only the order by day
      // puts the oldest first.
      for (let d = 0; d < days; d++) {
        const at = new Date(Date.parse('2026-09-01T08:00:00.000Z') + d * DAY).toISOString();
        const route = d < 2 ? ACTIVE : PROVIDERS;
        read(ana, route, at);
        read(ana, route, at.replace('T08', 'T09'));
      }
      expect(sweepAuditLog(engine.getDb(), NOW, noFail)).toEqual({ folded: 2 * FOLD_DAYS_PER_SWEEP, dayRows: FOLD_DAYS_PER_SWEEP, deleted: 0 });
      const folded = all().filter((r) => r.poll_count !== null).map((r) => r.ts.slice(0, 10));
      expect(folded).toEqual(Array.from({ length: FOLD_DAYS_PER_SWEEP }, (_, d) => new Date(Date.parse('2026-09-01T00:00:00.000Z') + d * DAY).toISOString().slice(0, 10)));
      expect(sweepAuditLog(engine.getDb(), NOW, noFail)).toEqual({ folded: 4, dayRows: 2, deleted: 0 });
      expect(all().every((r) => r.poll_count === 2)).toBe(true);
    });

    it('does not fold a day row again', () => {
      read(ana, PROVIDERS, '2026-10-20T08:00:00.000Z');
      read(ana, PROVIDERS, '2026-10-20T09:00:00.000Z');
      sweepAuditLog(engine.getDb(), NOW, noFail);
      const once = all();

      expect(sweepAuditLog(engine.getDb(), NOW + DAY, noFail)).toEqual({ folded: 0, dayRows: 0, deleted: 0 });
      expect(all()).toEqual(once);
    });

    it('leaves the trail\'s order and shows the day row as one grouped read with its count', () => {
      read(ana, PROVIDERS, '2026-10-20T08:00:00.000Z');
      step(ana, '2026-10-20T08:30:00.000Z');
      read(ana, PROVIDERS, '2026-10-20T09:00:00.000Z');
      read(ana, PROVIDERS, '2026-11-20T09:00:00.000Z');
      sweepAuditLog(engine.getDb(), NOW, noFail);

      const page = readTrailPage(engine.getDb(), { limit: 50 });
      expect(page.rows.map((r) => [r.phase, r.poll_count ?? null])).toEqual([['read', 2], ['attempt', null], ['done', null], ['read', null]]);
      const events = buildTrail(page.rows, quiet, { complete: page.complete }).filter((e): e is TrailEvent => e.kind === 'event');
      const day = events.find((e) => e.count !== undefined)!;
      expect(day).toMatchObject({ auto: true, count: 2, at: '2026-10-20T08:00:00.000Z', until: '2026-10-20T09:00:00.000Z' });
      // Control: a poll not yet folded carries no count.
      const single = events.find((e) => e.at === '2026-11-20T09:00:00.000Z')!;
      expect(single.auto).toBe(true);
      expect(single.count).toBeUndefined();
      expect(single.until).toBeUndefined();
    });
  });

  describe('every row is deleted 365 days after its time', () => {
    it('deletes what is older, keeps what is younger, and leaves a row with the span and count only', () => {
      const old = new Date(NOW - AUDIT_RETENTION_MS - 1000).toISOString();
      const older = new Date(NOW - AUDIT_RETENTION_MS - 5 * DAY).toISOString();
      const young = new Date(NOW - AUDIT_RETENTION_MS + 1000).toISOString();
      step(ana, older);
      read(ana, 'GET /api/inbox/items', old);
      read(ana, 'GET /api/inbox/items', young);

      expect(sweepAuditLog(engine.getDb(), NOW, noFail)).toEqual({ folded: 0, dayRows: 0, deleted: 3 });
      const rows = all();
      expect(rows.map((r) => r.ts)).toEqual([young, new Date(NOW).toISOString()]);
      const mark = rows[1]!;
      expect(mark).toMatchObject({
        actor_kind: RETENTION_ACTOR, action: RETENTION_ACTION, phase: 'done', actor_email: null, actor_display: null, mandate_id: null,
        target: `3 rows, ${older}..${old}`,
      });
      // The owner's view reads people's rows only.
      expect(readTrailPage(engine.getDb(), { limit: 50 }).rows.map((r) => r.ts)).toEqual([young]);
    });

    it('writes no row when nothing was deleted', () => {
      read(ana, 'GET /api/inbox/items', new Date(NOW - DAY).toISOString());
      expect(sweepAuditLog(engine.getDb(), NOW, noFail).deleted).toBe(0);
      expect(all()).toHaveLength(1);
    });

    it('keeps a day row until its last read is 365 days old', () => {
      read(ana, PROVIDERS, '2025-11-24T08:00:00.000Z');
      read(ana, PROVIDERS, '2025-11-24T20:00:00.000Z');
      // Folded on day 31, as the hourly sweep does.
      sweepAuditLog(engine.getDb(), Date.parse('2025-12-26T00:00:00.000Z'), noFail);
      const at = Date.parse('2025-11-24T08:00:00.000Z') + AUDIT_RETENTION_MS + DAY / 2; // first read past, last not
      expect(sweepAuditLog(engine.getDb(), at, noFail).deleted).toBe(0);
      expect(all().map((r) => r.poll_count)).toEqual([2]);

      const later = Date.parse('2025-11-24T20:00:00.000Z') + AUDIT_RETENTION_MS + 1000;
      expect(sweepAuditLog(engine.getDb(), later, noFail).deleted).toBe(1);
      expect(all().map((r) => r.action)).toEqual([RETENTION_ACTION]);
    });

    it('deletes its own row by the same rule, and leaves no new one for it', () => {
      read(ana, 'GET /api/inbox/items', new Date(NOW - AUDIT_RETENTION_MS - DAY).toISOString());
      sweepAuditLog(engine.getDb(), NOW, noFail);
      expect(all().map((r) => r.action)).toEqual([RETENTION_ACTION]);

      const next = NOW + AUDIT_RETENTION_MS + 1000;
      expect(sweepAuditLog(engine.getDb(), next, noFail).deleted).toBe(1);
      expect(all()).toEqual([]);
    });

    it('leaves a row when a person\'s row goes with its own rows', () => {
      read(ana, 'GET /api/inbox/items', new Date(NOW - AUDIT_RETENTION_MS - DAY).toISOString());
      sweepAuditLog(engine.getDb(), NOW, noFail);
      const later = new Date(NOW + 10 * DAY).toISOString();
      read(ana, 'GET /api/inbox/items', later);
      expect(sweepAuditLog(engine.getDb(), NOW + 10 * DAY + AUDIT_RETENTION_MS + 1000, noFail).deleted).toBe(2);
      expect(all()).toEqual([expect.objectContaining({ action: RETENTION_ACTION, target: `2 rows, ${new Date(NOW).toISOString()}..${later}` })]);
    });
  });

  it('leaves a refused day as it was, reports it, deletes, and folds the days before and after it', () => {
    const expired = new Date(NOW - AUDIT_RETENTION_MS - DAY).toISOString();
    read(ana, 'GET /api/inbox/items', expired);
    read(ana, PROVIDERS, '2026-10-18T08:00:00.000Z');
    read(ana, PROVIDERS, '2026-10-19T08:00:00.000Z');
    read(ana, ACTIVE, '2026-10-19T09:00:01.000Z');
    read(ana, PROVIDERS, '2026-10-20T08:00:00.000Z');
    read(ana, PROVIDERS, '2026-10-20T09:00:00.000Z');
    const refusedDay = all().filter((r) => r.ts.startsWith('2026-10-19'));
    engine.getDb().exec("CREATE TRIGGER refuse_day_rows BEFORE INSERT ON audit_log WHEN NEW.poll_count IS NOT NULL AND NEW.ts LIKE '2026-10-19%' BEGIN SELECT RAISE(ABORT, 'refused'); END;");
    const failed: Array<[string, string]> = [];

    expect(sweepAuditLog(engine.getDb(), NOW, (day, err) => { failed.push([day, err instanceof Error ? err.message : String(err)]); }))
      .toEqual({ folded: 3, dayRows: 2, deleted: 1 });
    expect(failed).toEqual([['2026-10-19', 'refused']]);
    const rows = all();
    expect(rows.some((r) => r.ts === expired)).toBe(false);
    expect(rows.filter((r) => r.ts.startsWith('2026-10-18'))).toEqual([expect.objectContaining({ poll_count: 1 })]);
    expect(rows.filter((r) => r.ts.startsWith('2026-10-19'))).toEqual(refusedDay);
    expect(rows.filter((r) => r.ts.startsWith('2026-10-20'))).toEqual([expect.objectContaining({ poll_count: 2 })]);
  });

  it('applies nothing when the delete is refused', () => {
    read(ana, 'GET /api/inbox/items', new Date(NOW - AUDIT_RETENTION_MS - DAY).toISOString());
    read(ana, PROVIDERS, '2026-10-19T08:00:00.000Z');
    const before = all();
    engine.getDb().exec("CREATE TRIGGER refuse_marks BEFORE INSERT ON audit_log WHEN NEW.actor_kind = 'retention' BEGIN SELECT RAISE(ABORT, 'refused'); END;");

    expect(() => sweepAuditLog(engine.getDb(), NOW, noFail)).toThrow('refused');
    expect(all()).toEqual(before);
  });
});
