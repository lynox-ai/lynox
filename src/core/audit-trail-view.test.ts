import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineDb } from './engine-db.js';
import { RunHistory } from './run-history.js';
import { AuditLog, newCorrelationId } from './audit-log.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';
import { buildTrail, readTrailPage, targetPairs, trailSources, type TrailRow, type TrailSources, type TrailPlanRun, type TrailBulkRun, type TrailStep } from './audit-trail-view.js';

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
  planRunRunning: () => false,
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

  it('puts every keyed row under its run; a write that returned makes the counts a lower bound', () => {
    // An agent's own write ends `returned` or `failed` (agent.ts `_trailOnSettle`): returned says
    // the tool came back, not that it wrote, so it is not counted and not counted as none either.
    const c1 = newCorrelationId();
    const c2 = newCorrelationId();
    const inner = [
      row({ action: 'http_request:read', phase: 'read', correlation_id: newCorrelationId() }),
      row({ action: 'http_request:POST', phase: 'attempt', correlation_id: c1 }), row({ action: 'http_request:POST', phase: 'returned', correlation_id: c1 }),
      row({ action: 'http_request:POST', phase: 'attempt', correlation_id: c2 }), row({ action: 'http_request:POST', phase: 'failed', correlation_id: c2 }),
    ];
    const entries = buildTrail(run('success', inner), quiet);
    expect(entries).toHaveLength(1);
    const plan = entries[0] as TrailPlanRun;
    expect(plan).toMatchObject({ kind: 'plan', trigger: 'po-1', startedBy: 'schedule', status: 'done', targets: { written: 0, failed: 1, atLeast: true } });
    expect(plan.entries.map((e) => e.kind)).toEqual(['event', 'step', 'step']);
  });

  it('counts a filed write the entry says was sent as written, and one rejected as not, without a lower bound', () => {
    const filing = (id: string): TrailRow[] => {
      const c = newCorrelationId();
      return [
        row({ action: 'mail_send:send', phase: 'attempt', correlation_id: c, run_id: 'r1', target: 'mail_send send' }),
        row({ action: 'mail_send:send', phase: 'returned', correlation_id: c, run_id: 'r1', target: `mail_send send approval=${id}` }),
      ];
    };
    const src: TrailSources = { ...quiet, approvalOf: (id) => (id === 'a1' ? { status: 'done', decidedBy: 'owner' } : { status: 'rejected', decidedBy: 'owner' }) };
    const plan = buildTrail(run('success', [...filing('a1'), ...filing('a2')]), src)[0] as TrailPlanRun;
    expect(plan.targets).toEqual({ written: 1, failed: 0, atLeast: false });
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

  it('reads a run without its end row as running only while this very run is its trigger\'s run in flight', () => {
    const key = newCorrelationId();
    const asked: Array<[string, string]> = [];
    const flying = (k: string): TrailSources => ({ ...quiet, planRunRunning: (t, kk) => { asked.push([t, kk]); return t === 'po-1' && kk === k; } });
    expect((buildTrail(run(null, [], key), flying(key))[0] as TrailPlanRun).status).toBe('running');
    expect(asked).toEqual([['po-1', key]]);
    // The trigger runs again, but as another run: this one lost its end row, it is not running.
    expect((buildTrail(run(null, [], key), flying('another-run'))[0] as TrailPlanRun).status).toBe('interrupted');
    expect((buildTrail(run(null), quiet)[0] as TrailPlanRun).status).toBe('interrupted');
  });

  it('gives a run without a key and without its end row no status: nothing can be asked about it', () => {
    const c = newCorrelationId();
    const head = row({ action: 'plan:run', phase: 'attempt', correlation_id: c, target: 'trigger=po-1 approved_by=owner started=hand' });
    expect((buildTrail([head], { ...quiet, planRunRunning: () => true })[0] as TrailPlanRun).status).toBeNull();
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
    const src = entryState({
      a2: { status: 'pending', decidedBy: null }, a3: { status: 'failed', decidedBy: 'owner' },
      a4: { status: 'rejected', decidedBy: 'mandate:eva@kanzlei.example' },
    });
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

  it('reads the entry before the send rows: a send that may have gone out is not "failed"', () => {
    // approval-executor.ts writes `failed` for every end but `done`, also for `unknown` (the
    // provider may have taken it) and for a send that is tried again.
    const rows = [...filed('a1'), ...sent('a1', 'failed')];
    const step = (st: string): unknown => {
      const got = buildTrail(rows, entryState({ a1: { status: st, decidedBy: 'owner' } }))[0] as TrailStep;
      return [got.status, got.note ?? null];
    };
    expect(step('unknown')).toEqual([null, 'send-unknown']);
    expect(step('approved'), 'a send tried again').toEqual(['running', null]);
    expect(step('failed')).toEqual(['failed', null]);
  });

  it('without the entry, reads only a done of the latest send attempt, and a failed end as no result', () => {
    const status = (rows: TrailRow[]): unknown => {
      const got = buildTrail(rows, quiet)[0] as TrailStep;
      return [got.status, got.note ?? null];
    };
    expect(status([...filed('a1'), ...sent('a1', 'done')])).toEqual(['done', null]);
    expect(status([...filed('a1'), ...sent('a1', 'failed')])).toEqual([null, 'no-result']);
    // Tried again: the first attempt's failed end does not speak for the second.
    expect(status([...filed('a1'), ...sent('a1', 'failed'), ...sent('a1', null)])).toEqual([null, 'no-result']);
    expect(status([...filed('a1'), ...sent('a1', 'failed'), ...sent('a1', 'done')])).toEqual(['done', null]);
    expect(status([...filed('a1'), ...sent('a1', 'done'), ...sent('a1', null)]), 'the latest attempt, not any').toEqual([null, 'no-result']);
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
    expect(status('unknown')).toEqual([null, 'send-unknown']);
    expect(status('something-new')).toEqual([null, 'no-result']);
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

describe('readTrailPage: the rows the view shows, a page at a time', () => {
  const MANDATE: RequestPrincipal = { kind: 'mandate', email: EVA.email, display: EVA.display, mandateId: EVA.mandateId };
  const withLog = (fn: (db: EngineDb, log: AuditLog) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'trail-view-'));
    const db = new EngineDb(join(dir, 'engine.db'), '');
    try { fn(db, new AuditLog(db.getDb())); } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const actions = (p: { rows: TrailRow[] }): string[] => p.rows.map((r) => `${r.action} ${r.phase}`);

  it('shows only rows written since the view existed, and only rows of a person with delegated access', () => {
    withLog((db, log) => {
      // A row from before the view (no trail_form), as a staging instance can hold one.
      db.getDb().prepare(
        `INSERT INTO audit_log (ts, actor_kind, actor_email, mandate_id, action, target, phase, correlation_id)
         VALUES ('2026-10-01T00:00:00.000Z', 'mandate', ?, ?, 'GET /api/files', NULL, 'read', 'old')`,
      ).run(EVA.email, EVA.mandateId);
      log.record({ principal: MANDATE, action: 'GET /api/files', phase: 'read', correlationId: newCorrelationId() });
      log.record({ principal: OWNER_PRINCIPAL, action: 'connection.erasure.run-history', target: 'c1 pending', phase: 'attempt', correlationId: newCorrelationId() });
      const page = readTrailPage(db.getDb(), { limit: 50 });
      expect(page.rows.map((r) => [r.action, r.actor_email])).toEqual([['GET /api/files', EVA.email]]);
      expect(page.rows[0]!.correlation_id).not.toBe('old');
      expect(page.before).toBeNull();
      // The page runs backwards from a cursor, and returns rows oldest first.
      log.record({ principal: MANDATE, action: 'GET /api/memory', phase: 'read', correlationId: newCorrelationId() });
      const all = readTrailPage(db.getDb(), { limit: 50 });
      expect(actions(all)).toEqual(['GET /api/files read', 'GET /api/memory read']);
      expect(actions(readTrailPage(db.getDb(), { limit: 50, beforeId: all.rows[1]!.id }))).toEqual(['GET /api/files read']);
      const first = readTrailPage(db.getDb(), { limit: 1 });
      expect(actions(first)).toEqual(['GET /api/memory read']);
      expect(first.before).toBe(all.rows[1]!.id);
    });
  });

  it('takes the rest of a run, a bulk run and a step its page cuts, on both sides of the edge', () => {
    withLog((db, log) => {
      const key = newCorrelationId();
      const step = newCorrelationId();
      const bulk = newCorrelationId();
      const rec = (action: string, phase: 'attempt' | 'done' | 'failed' | 'read' | 'returned', correlationId: string, more: { planRun?: string; runId?: string; target?: string } = {}): void => {
        log.record({ principal: MANDATE, action, phase, correlationId, target: more.target, runId: more.runId, planRun: more.planRun });
      };
      rec('plan:run', 'attempt', key, { planRun: key, target: 'trigger=po-1' });
      rec('bulk:apply', 'attempt', bulk, { runId: 'b1' });
      rec('http_request:POST', 'attempt', step);
      rec('GET /api/files', 'read', newCorrelationId());
      rec('bulk:apply', 'done', bulk, { runId: 'b1', target: 'outcome=done written=1 failed=0' });
      rec('http_request:POST', 'returned', step);
      rec('plan:run', 'done', key, { planRun: key, target: 'trigger=po-1 outcome=success' });
      // A page of one row holds the run's end, and takes its start, far below the edge.
      const top = readTrailPage(db.getDb(), { limit: 1 });
      expect(actions(top)).toEqual(['plan:run attempt', 'plan:run done']);
      const ids = (p: { rows: TrailRow[] }): number[] => p.rows.map((r) => r.id);
      expect(top.before).toBe(Math.max(...ids(top)));
      // The next page holds the step's end and takes its attempt; the one after, the bulk end.
      const second = readTrailPage(db.getDb(), { limit: 1, beforeId: top.before! });
      expect(actions(second)).toEqual(['http_request:POST attempt', 'http_request:POST returned']);
      const third = readTrailPage(db.getDb(), { limit: 1, beforeId: second.before! });
      expect(actions(third)).toEqual(['bulk:apply attempt', 'bulk:apply done']);
      // A run read from a cut page is the same entry as read whole.
      const whole = buildTrail(readTrailPage(db.getDb(), { limit: 50 }).rows, quiet);
      expect(buildTrail(top.rows, quiet)).toEqual(whole.filter((e) => e.id === `plan:${key}`));
    });
  });

  it('takes the send rows of a filing it holds, and the filing of a send it holds', () => {
    withLog((db, log) => {
      const c = newCorrelationId();
      const s = newCorrelationId();
      const target = 'approval a-77: mail_send, 1 recipient, approved by owner';
      log.record({ principal: MANDATE, action: 'mail_send:send', phase: 'attempt', correlationId: c, target: 'mail_send send', runId: 'r1' });
      log.record({ principal: MANDATE, action: 'mail_send:send', phase: 'returned', correlationId: c, target: 'mail_send send approval=a-77', runId: 'r1' });
      for (let i = 0; i < 3; i++) log.record({ principal: MANDATE, action: 'GET /api/files', phase: 'read', correlationId: newCorrelationId() });
      log.record({ principal: MANDATE, action: 'mail_send:send', phase: 'attempt', correlationId: s, target, runId: 'r1' });
      log.record({ principal: MANDATE, action: 'mail_send:send', phase: 'done', correlationId: s, target, runId: 'r1' });
      // Another entry's send, whose id begins like this one's: not taken.
      log.record({ principal: MANDATE, action: 'mail_send:send', phase: 'done', correlationId: newCorrelationId(), target: 'approval a-777: mail_send, 1 recipient, approved by owner', runId: 'r1' });
      const all = readTrailPage(db.getDb(), { limit: 50 }).rows;
      const sendEnd = all.find((r) => r.correlation_id === s && r.phase === 'done')!;
      const fromSend = readTrailPage(db.getDb(), { limit: 1, beforeId: sendEnd.id + 1 });
      expect(fromSend.rows.map((r) => r.target)).toEqual(['mail_send send', 'mail_send send approval=a-77', target, target]);
      const fromFiling = readTrailPage(db.getDb(), { limit: 1, beforeId: all[1]!.id + 1 });
      expect(fromFiling.rows.map((r) => r.target)).toEqual(['mail_send send', 'mail_send send approval=a-77', target, target]);
      const steps = buildTrail(fromFiling.rows, quiet) as TrailStep[];
      expect(steps.map((st) => [st.id, st.status])).toEqual([[`step:${c}`, 'done']]);
    });
  });
});

describe('trailSources over run history', () => {
  const sources = (db: import('better-sqlite3').Database | null, over: Partial<Parameters<typeof trailSources>[0]> = {}): TrailSources =>
    trailSources({ historyDb: db, runningPlanRun: () => undefined, bulkState: () => undefined, approval: () => undefined, ...over });
  const withHistory = (fn: (db: import('better-sqlite3').Database) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'trail-sources-'));
    const history = new RunHistory(join(dir, 'history.db'));
    try { fn(history.getDb()); } finally {
      history.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const addRun = (db: import('better-sqlite3').Database, id: string, at: string, status = 'failed'): void => {
    db.prepare("INSERT INTO runs (id, session_id, task_hash, task_text, model_tier, model_id, prompt_hash, status, created_at) VALUES (?, 's1', '', '', '', '', '', ?, ?)").run(id, status, at);
  };
  const ask = (db: import('better-sqlite3').Database, id: string, at: string, status: string): void => {
    db.prepare("INSERT INTO pending_prompts (id, session_id, prompt_type, question, status, created_at, expires_at) VALUES (?, 's1', 'ask_user', 'q', ?, ?, '2099-01-01 00:00:00')").run(id, status, at);
  };

  it('reads a run\'s status and the newest question of its session asked since the row, also in the row\'s second', () => {
    withHistory((db) => {
      addRun(db, 'r1', '2026-10-26 09:59:00');
      const src = sources(db);
      expect(src.runStatus('r1')).toBe('failed');
      expect(src.runStatus('nope')).toBeUndefined();
      expect(src.questionOfRun('r1', '2026-10-26T10:00:00.700Z')).toBeUndefined();
      // Asked in the same second as the row, written to the second: it counts.
      ask(db, 'p1', '2026-10-26 10:00:00', 'pending');
      expect(src.questionOfRun('r1', '2026-10-26T10:00:00.700Z')).toBe('pending');
      // A question from before the row is not this step's.
      expect(src.questionOfRun('r1', '2026-10-26T10:00:01.000Z')).toBeUndefined();
      ask(db, 'p2', '2026-10-26 10:05:00', 'expired');
      expect(src.questionOfRun('r1', '2026-10-26T10:00:00.700Z'), 'the newest one').toBe('expired');
      ask(db, 'p3', '2026-10-26 10:06:00', 'answered');
      expect(src.questionOfRun('r1', '2026-10-26T10:00:00.700Z'), 'answered says nothing').toBeUndefined();
      expect(sources(null).runStatus('r1'), 'no history: no run says anything').toBeUndefined();
      expect(sources(null).questionOfRun('r1', '2026-10-26T10:00:00.700Z')).toBeUndefined();
    });
  });

  it('does not give a run the question of a later run of the same thread', () => {
    withHistory((db) => {
      addRun(db, 'r1', '2026-10-26 09:59:00');
      ask(db, 'p1', '2026-10-26 10:01:00', 'pending');
      const src = sources(db);
      expect(src.questionOfRun('r1', '2026-10-26T10:00:00.000Z'), 'its own').toBe('pending');
      // Days later another run of the thread starts and asks; it expires.
      addRun(db, 'r2', '2026-10-29 08:00:00', 'completed');
      ask(db, 'p2', '2026-10-29 08:01:00', 'expired');
      expect(src.questionOfRun('r1', '2026-10-26T10:00:00.000Z'), 'still its own, not r2\'s').toBe('pending');
      expect(src.questionOfRun('r2', '2026-10-29T08:00:30.000Z')).toBe('expired');
    });
  });

  it('asks the worker by run, and the ledger by phase and halt', () => {
    const src = sources(null, {
      runningPlanRun: (t) => (t === 'po-1' ? 'k1' : undefined),
      bulkState: (id) => ({ b1: { phase: 'writing', haltReason: null }, b2: { phase: 'done', haltReason: null }, b4: { phase: 'writing', haltReason: 'stopped by the owner' }, b5: { phase: 'approved', haltReason: null } } as Record<string, { phase: string; haltReason: string | null }>)[id],
    });
    expect([src.planRunRunning('po-1', 'k1'), src.planRunRunning('po-1', 'k2'), src.planRunRunning('po-2', 'k1')]).toEqual([true, false, false]);
    // A run writing with a halt is stopped (bulk-ledger.ts isStopped): no window follows.
    expect(['b1', 'b2', 'b3', 'b4', 'b5'].map((id) => src.bulkRunOpen(id))).toEqual([true, false, false, false, true]);
  });
});
