import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineDb } from './engine-db.js';
import { AuditLog, newCorrelationId } from './audit-log.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';
import { buildTrail, readTrailRows, targetPairs, type TrailRow, type TrailSources, type TrailPlanRun, type TrailBulkRun, type TrailStep } from './audit-trail-view.js';

const EVA = { email: 'eva@kanzlei.example', display: 'Eva Muster', mandateId: 'TEST-GRANT-EVA' };

let nextId = 1;
function row(over: Partial<TrailRow> & Pick<TrailRow, 'action' | 'phase' | 'correlation_id'>): TrailRow {
  const id = nextId++;
  return {
    id, ts: `2026-10-26T10:${String(id).padStart(2, '0')}:00.000Z`, actor_kind: 'mandate',
    actor_email: EVA.email, actor_display: EVA.display, mandate_id: EVA.mandateId,
    target: null, run_id: null, plan_run: null, ...over,
  };
}

const quiet: TrailSources = {
  runStatus: () => undefined,
  questionOfRun: () => undefined,
  triggerRunning: () => false,
  bulkRunOpen: () => false,
  approvalOf: () => undefined,
};

describe('a bulk run: one entry over its windows', () => {
  const window = (runId: string, end: string | null): TrailRow[] => {
    const c = newCorrelationId();
    const start = row({ action: 'bulk:apply', phase: 'attempt', correlation_id: c, run_id: runId, target: 'host=shop.example.com approved_by=owner' });
    return end === null ? [start] : [start, row({ action: 'bulk:apply', phase: end.startsWith('outcome=done') ? 'done' : 'failed', correlation_id: c, run_id: runId, target: `host=shop.example.com approved_by=owner ${end}` })];
  };

  it('sums the targets of every window into one entry', () => {
    const rows = [...window('b1', 'outcome=pending written=3 failed=0'), ...window('b1', 'outcome=done written=2 failed=1')];
    const [entry] = buildTrail(rows, quiet) as TrailBulkRun[];
    expect(buildTrail(rows, quiet)).toHaveLength(1);
    expect(entry).toMatchObject({ kind: 'bulk', runId: 'b1', windows: 2, status: 'done', host: 'shop.example.com', targets: { written: 5, failed: 1, atLeast: false } });
  });

  it('counts a window whose numbers are unknown as "or more", never as zero', () => {
    const rows = [...window('b1', 'outcome=pending written=3 failed=0'), ...window('b1', 'outcome=done written=unread failed=unread')];
    expect((buildTrail(rows, quiet)[0] as TrailBulkRun).targets).toEqual({ written: 3, failed: 0, atLeast: true });
  });

  it('shows a window without its end row as interrupted, never as done', () => {
    const rows = [...window('b1', 'outcome=pending written=3 failed=0'), ...window('b1', null)];
    const entry = buildTrail(rows, quiet)[0] as TrailBulkRun;
    expect(entry.status).toBe('interrupted');
    expect(entry.targets.atLeast).toBe(true);
  });

  it('reads a run as running only while the ledger holds it open, after a pending window or one still writing', () => {
    const open: TrailSources = { ...quiet, bulkRunOpen: (id) => id === 'b1' };
    expect((buildTrail(window('b1', 'outcome=pending written=1 failed=0'), open)[0] as TrailBulkRun).status).toBe('running');
    expect((buildTrail(window('b1', null), open)[0] as TrailBulkRun).status).toBe('running');
    expect((buildTrail(window('b1', 'outcome=pending written=1 failed=0'), quiet)[0] as TrailBulkRun).status).toBe('interrupted');
  });

  it('maps each outcome of the last window to its status, and tells a planned halt from another', () => {
    const cases: Array<[string, string]> = [['done', 'done'], ['halted', 'halted'], ['refused', 'refused'], ['stopped', 'ended'], ['aborted', 'failed'], ['error', 'failed']];
    for (const [outcome, status] of cases) {
      expect((buildTrail(window('b1', `outcome=${outcome} written=0 failed=0`), quiet)[0] as TrailBulkRun).status, outcome).toBe(status);
    }
    expect((buildTrail(window('b1', 'outcome=halted written=4 failed=0 planned=yes'), quiet)[0] as TrailBulkRun).planned).toBe(true);
    expect((buildTrail(window('b1', 'outcome=halted written=4 failed=0'), quiet)[0] as TrailBulkRun).planned).toBe(false);
  });
});

describe('a plan run: its head and the rows keyed to it', () => {
  const run = (end: string | null, inner: TrailRow[] = [], key = newCorrelationId()): TrailRow[] => {
    const start = row({ action: 'plan:run', phase: 'attempt', correlation_id: key, plan_run: key, target: 'trigger=po-1 approved_by=owner started=schedule' });
    const rows = [start, ...inner.map((r) => ({ ...r, plan_run: key }))];
    if (end !== null) rows.push(row({ action: 'plan:run', phase: 'done', correlation_id: key, plan_run: key, target: `trigger=po-1 approved_by=owner started=schedule outcome=${end}` }));
    return rows;
  };

  it('puts every keyed row under its run and counts its write steps', () => {
    const c1 = newCorrelationId();
    const c2 = newCorrelationId();
    const inner = [
      row({ action: 'http_request:read', phase: 'read', correlation_id: newCorrelationId() }),
      row({ action: 'mail_send:send', phase: 'attempt', correlation_id: c1 }), row({ action: 'mail_send:send', phase: 'done', correlation_id: c1 }),
      row({ action: 'http_request:POST', phase: 'attempt', correlation_id: c2 }), row({ action: 'http_request:POST', phase: 'failed', correlation_id: c2 }),
    ];
    const entries = buildTrail(run('success', inner), quiet);
    expect(entries).toHaveLength(1);
    const plan = entries[0] as TrailPlanRun;
    expect(plan).toMatchObject({ kind: 'plan', trigger: 'po-1', startedBy: 'schedule', status: 'done', targets: { written: 1, failed: 1, atLeast: false } });
    expect(plan.entries.map((e) => e.kind)).toEqual(['event', 'step', 'step']);
  });

  it('keeps the run with the person its rows name, also after that access ended', () => {
    // No lookup of the mandate: the person is the row's, so an ended access still reads.
    const plan = buildTrail(run('success'), quiet)[0] as TrailPlanRun;
    expect(plan.person).toEqual(EVA);
  });

  it('maps each end to its status, and an end that was not recorded to interrupted, not failed', () => {
    const cases: Array<[string, string]> = [['success', 'done'], ['failed', 'failed'], ['timeout', 'failed'], ['stopped', 'ended'], ['halted', 'halted'], ['interrupted', 'interrupted'], ['unrecorded', 'interrupted']];
    for (const [outcome, status] of cases) expect((buildTrail(run(outcome), quiet)[0] as TrailPlanRun).status, outcome).toBe(status);
  });

  it('reads a run without its end row as running only while its trigger runs', () => {
    expect((buildTrail(run(null), { ...quiet, triggerRunning: (t) => t === 'po-1' })[0] as TrailPlanRun).status).toBe('running');
    expect((buildTrail(run(null), quiet)[0] as TrailPlanRun).status).toBe('interrupted');
  });

  it('shows a run whose rows carry no key without steps under it and without any number, not even 0', () => {
    const c = newCorrelationId();
    const rows = [
      row({ action: 'plan:run', phase: 'attempt', correlation_id: c, target: 'trigger=po-1 approved_by=owner started=hand by=mandate' }),
      row({ action: 'plan:run', phase: 'done', correlation_id: c, target: 'trigger=po-1 approved_by=owner started=hand by=mandate outcome=success' }),
    ];
    const plan = buildTrail(rows, quiet)[0] as TrailPlanRun;
    expect(plan).toMatchObject({ key: null, startedBy: 'hand', status: 'done', targets: null, entries: [] });
  });
});

describe('a step and its status', () => {
  const attempt = (runId: string | null): TrailRow => row({ action: 'mail_send:send', phase: 'attempt', correlation_id: newCorrelationId(), run_id: runId });

  it('maps an outcome row: done, refused, failed, and returned as ended — a tool that returned did not say it acted', () => {
    for (const [phase, status] of [['done', 'done'], ['refused', 'refused'], ['failed', 'failed'], ['returned', 'ended']] as const) {
      const a = attempt('r1');
      const step = buildTrail([a, row({ action: a.action, phase, correlation_id: a.correlation_id })], quiet)[0] as TrailStep;
      expect(step.status, phase).toBe(status);
    }
  });

  it('reads a step without its outcome from its run: running, ended or interrupted — and with no source, no status', () => {
    const src = (run: string | undefined, question?: 'pending' | 'expired'): TrailSources => ({ ...quiet, runStatus: () => run, questionOfRun: () => question });
    const status = (s: TrailSources, runId: string | null = 'r1'): unknown => (buildTrail([attempt(runId)], s)[0] as TrailStep).status;
    expect(status(src('running'))).toBe('running');
    expect(status(src('failed'))).toBe('interrupted');
    expect(status(src('completed'))).toBe('interrupted');
    expect(status(src(undefined))).toBeNull();
    expect(status(src('running'), null), 'a row without a run').toBeNull();
    // A question still open on the run's session: it waits for the owner, also after a restart swept the run.
    expect(status(src('failed', 'pending'))).toBe('running');
    // The question expired: the step ended without the act.
    expect(status(src('failed', 'expired'))).toBe('ended');
  });
});

describe('a write filed for the owner\'s approval', () => {
  // The step in the run, its end row naming the entry, and the send rows the approval writes later.
  const filed = (id: string, runId = 'r1'): TrailRow[] => {
    const c = newCorrelationId();
    return [
      row({ action: 'mail_send:send', phase: 'attempt', correlation_id: c, run_id: runId, target: 'mail_send send' }),
      row({ action: 'mail_send:send', phase: 'returned', correlation_id: c, run_id: runId, target: `mail_send send approval=${id}` }),
    ];
  };
  const sent = (id: string, phase: 'done' | 'failed' | null, runId = 'r1'): TrailRow[] => {
    const c = newCorrelationId();
    const target = `approval ${id}: mail_send, 1 recipient, approved by owner`;
    const start = row({ action: 'mail_send:send', phase: 'attempt', correlation_id: c, run_id: runId, target });
    return phase === null ? [start] : [start, row({ action: 'mail_send:send', phase, correlation_id: c, run_id: runId, target })];
  };
  const entryState = (states: Record<string, { status: string; decidedBy: string | null }>): TrailSources => ({ ...quiet, approvalOf: (id) => states[id] });

  it('pairs each step with its own send by the entry id, not by the run: four mails of one run, four answers', () => {
    const rows = [...filed('a1'), ...filed('a2'), ...filed('a3'), ...filed('a4'), ...sent('a3', 'failed'), ...sent('a1', 'done')];
    const src = entryState({ a2: { status: 'pending', decidedBy: null }, a4: { status: 'rejected', decidedBy: 'mandate:eva@kanzlei.example' } });
    const steps = buildTrail(rows, src).filter((e): e is TrailStep => e.kind === 'step');
    // The sends do not stand as entries of their own: each is under the step that filed it.
    expect(steps).toHaveLength(4);
    const byFiling = new Map(steps.map((st) => [st.at, st]));
    const ordered = rows.filter((r) => r.phase === 'attempt' && r.target === 'mail_send send').map((r) => byFiling.get(r.ts)!);
    expect(ordered.map((st) => [st.status, st.note ?? null, st.decidedBy ?? null])).toEqual([
      ['done', null, null],
      ['running', 'awaits-approval', null],
      ['failed', null, null],
      ['ended', 'approval-rejected', 'mandate:eva@kanzlei.example'],
    ]);
  });

  it('reads an entry with no send yet from the entry: expired is ended and not sent, a missing entry says nothing', () => {
    const status = (st: string | undefined): unknown => {
      const step = buildTrail(filed('a1'), entryState(st === undefined ? {} : { a1: { status: st, decidedBy: 'owner' } }))[0] as TrailStep;
      return [step.status, step.note ?? null];
    };
    expect(status('expired')).toEqual(['ended', 'approval-expired']);
    expect(status('approved')).toEqual(['running', null]);
    expect(status('executing')).toEqual(['running', null]);
    expect(status(undefined)).toEqual([null, 'no-result']);
    expect(status('unknown')).toEqual([null, 'no-result']);
  });

  it('shows a send whose filing step is not on the page as a step of its own', () => {
    const steps = buildTrail(sent('a9', 'done'), quiet) as TrailStep[];
    expect(steps.map((st) => [st.kind, st.status])).toEqual([['step', 'done']]);
  });

  it('notes why a step without its outcome has its status', () => {
    const a = row({ action: 'mail_send:send', phase: 'attempt', correlation_id: newCorrelationId(), run_id: 'r1' });
    const note = (src: TrailSources): unknown => (buildTrail([a], src)[0] as TrailStep).note ?? null;
    expect(note({ ...quiet, questionOfRun: () => 'pending' })).toBe('awaits-answer');
    expect(note({ ...quiet, questionOfRun: () => 'expired' })).toBe('unanswered');
    expect(note(quiet)).toBe('no-result');
    expect(note({ ...quiet, runStatus: () => 'running' })).toBeNull();
  });
});

describe('targetPairs', () => {
  it('reads the pairs namedTarget writes, undoing its escapes', () => {
    expect([...targetPairs('trigger=po%201 outcome=success list').entries()]).toEqual([['trigger', 'po 1'], ['outcome', 'success']]);
    expect(targetPairs(null).size).toBe(0);
  });
});

describe('readTrailRows: the rows the view shows', () => {
  const MANDATE: RequestPrincipal = { kind: 'mandate', email: EVA.email, display: EVA.display, mandateId: EVA.mandateId };

  it('shows only rows written since the view existed, and only rows of a person with delegated access', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trail-view-'));
    const db = new EngineDb(join(dir, 'engine.db'), '');
    try {
      const log = new AuditLog(db.getDb());
      // A row from before the view (no trail_form), as a staging instance can hold one.
      db.getDb().prepare(
        `INSERT INTO audit_log (ts, actor_kind, actor_email, mandate_id, action, target, phase, correlation_id)
         VALUES ('2026-10-01T00:00:00.000Z', 'mandate', ?, ?, 'GET /api/files', NULL, 'read', 'old')`,
      ).run(EVA.email, EVA.mandateId);
      log.record({ principal: MANDATE, action: 'GET /api/files', phase: 'read', correlationId: newCorrelationId() });
      log.record({ principal: OWNER_PRINCIPAL, action: 'connection.erasure.run-history', target: 'c1 pending', phase: 'attempt', correlationId: newCorrelationId() });
      const rows = readTrailRows(db.getDb(), { limit: 50 });
      expect(rows.map((r) => [r.action, r.actor_email])).toEqual([['GET /api/files', EVA.email]]);
      expect(rows[0]!.correlation_id).not.toBe('old');
      // The page runs backwards from a cursor, and returns rows oldest first.
      log.record({ principal: MANDATE, action: 'GET /api/memory', phase: 'read', correlationId: newCorrelationId() });
      const all = readTrailRows(db.getDb(), { limit: 50 });
      expect(all.map((r) => r.action)).toEqual(['GET /api/files', 'GET /api/memory']);
      expect(readTrailRows(db.getDb(), { limit: 50, beforeId: all[1]!.id }).map((r) => r.action)).toEqual(['GET /api/files']);
      expect(readTrailRows(db.getDb(), { limit: 1 }).map((r) => r.action)).toEqual(['GET /api/memory']);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
