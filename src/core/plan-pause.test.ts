import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { TaskManager } from './task-manager.js';
import { MandateEnds } from './mandate-ends.js';
import { TriggerStore } from './trigger-store.js';
import { ADVANCE_WARNING_S, PAUSE_NOTICE_BODY_MAX, advanceWarning, claimAdvanceWarnings, deliveredWarning, markWarningsDelivered, pauseNotice, pausePlanNow, type PausedFor } from './plan-pause.js';
import {
  claimPauseNotices, pauseEndedPlans, pausedForOf, planEndedMembers, rowPlanMembers, setPlanPauseForTests,
  writePause, PLAN_PAUSE_DEFAULT, type PausePlanRow,
} from './plan-pause.js';

/**
 * The plan pause (`plan-pause.ts`) on a real engine.db: the store's terms, the sweep, the login
 * listener and the owner's notice. Every case runs with the pause switched on unless it says
 * otherwise; the switch itself is pinned in `plan-pause-lock.test.ts`.
 */

const H = 3600;
const NOW = 1_800_000_000;
/** In the past of the real clock, which `getDue` reads. */
const DUE = '2026-01-15T09:00:00.000Z';

const dirs: string[] = [];
const closers: Array<() => void> = [];
let restore: () => void = () => undefined;

beforeEach(() => { restore = setPlanPauseForTests(true); });
afterEach(() => {
  restore();
  vi.restoreAllMocks();
  for (const c of closers.splice(0).reverse()) c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Box {
  history: RunHistory;
  engineDb: EngineDb;
  manager: TaskManager;
  ends: MandateEnds;
  db: ReturnType<EngineDb['getDb']>;
}

function box(dir = mkdtempSync(join(tmpdir(), 'lynox-pause-'))): Box {
  if (!dirs.includes(dir)) dirs.push(dir);
  const history = new RunHistory(join(dir, 'history.db'));
  const engineDb = new EngineDb(join(dir, 'engine.db'));
  history.setVerbGraph(engineDb);
  closers.push(() => { try { history.close(); } catch { /* twice is fine */ } });
  closers.push(() => { try { engineDb.close(); } catch { /* twice is fine */ } });
  return { history, engineDb, manager: new TaskManager(history), ends: new MandateEnds(engineDb.getDb()), db: engineDb.getDb() };
}

const tag = (email: string): string => `mandate:${email}`;

/** A stamped cron plan a mandate created, due at DUE. */
function plan(b: Box, id: string, over: {
  by?: string; grant?: string | null; effect?: 'run_agent' | 'run_workflow' | 'notify'; stamped?: boolean;
  workflow?: string; editor?: { email: string; grant: string | null };
} = {}): string {
  b.history.insertTrigger({
    id, title: `Plan ${id}`, source: 'cron', effect: over.effect ?? 'run_agent', scheduleCron: '0 9 * * 1', nextRunAt: DUE,
    ...(over.stamped === false ? {} : { confirmedAt: '2027-01-01T00:00:00.000Z', confirmedBy: 'owner' }),
    ...(over.by !== undefined ? { createdBy: tag(over.by), ...(over.grant !== null ? { createdMandateId: over.grant ?? `g-${over.by}` } : {}) } : {}),
    ...(over.workflow !== undefined ? { pipelineId: over.workflow } : {}),
  });
  if (over.editor !== undefined) {
    b.db.prepare("UPDATE triggers SET mandate_editor = ?, mandate_editor_id = ?, mandate_edited_at = datetime('now') WHERE id = ?")
      .run(tag(over.editor.email), over.editor.grant, id);
  }
  return id;
}

function workflow(b: Box, id: string, by?: { email: string; grant: string | null }): string {
  b.db.prepare("INSERT INTO workflows (id, name, definition_json, created_by, created_mandate_id) VALUES (?, 'W', '{}', ?, ?)")
    .run(id, by ? tag(by.email) : null, by?.grant ?? null);
  return id;
}

/** Writes a mandate's end the way a login does: `ends_at` at `endsAt`, signed at `issuedAt`. */
function login(b: Box, email: string, endsAt: number, issuedAt: number, grant = `g-${email}`): void {
  b.ends.record({ kind: 'mandate', email, mandateId: grant, mandateExp: endsAt }, issuedAt);
}

function col(b: Box, id: string): { paused_at: number | null; paused_due_at: string | null; paused_for: string | null; pause_noticed_at: number | null; next_run_at: string | null; status: string } {
  return b.db.prepare('SELECT paused_at, paused_due_at, paused_for, pause_noticed_at, next_run_at, status FROM triggers WHERE id = ?').get(id) as never;
}

const sweep = (b: Box, nowS = NOW, extra: Partial<Parameters<typeof pauseEndedPlans>[0]> = {}): ReturnType<typeof pauseEndedPlans> =>
  pauseEndedPlans({ db: b.db, endOf: (id) => b.ends.endRow(id), nowS, ...extra });

describe('the SQL function the store reads the switch through', () => {
  it('is registered once per handle, so a store built under an open iterate does not throw', () => {
    const b = box();
    plan(b, 'a', { by: 'h@x.ch' });
    plan(b, 'b', { by: 'h@x.ch' });
    new TriggerStore(b.engineDb);
    const seen: string[] = [];
    for (const row of b.db.prepare('SELECT id FROM triggers ORDER BY id').iterate() as Iterable<{ id: string }>) {
      // Registering a function again while a statement runs is refused by better-sqlite3.
      expect(() => new TriggerStore(b.engineDb)).not.toThrow();
      seen.push(row.id);
    }
    expect(seen).toEqual(['a', 'b']);
  });
});

describe('the switch', () => {
  it('is on by default (641c-2: the takeover is in the view), and off it pauses nothing and reads no pause', () => {
    expect(PLAN_PAUSE_DEFAULT).toBe(true);
    restore();
    restore = setPlanPauseForTests(false);
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    login(b, 'h@x.ch', NOW - H, NOW - 2 * H);
    expect(sweep(b).paused).toEqual([]);
    expect(col(b, 'p').paused_at).toBeNull();
    // A pause written in an on-period is not read while the switch is off: the plan is due as on main.
    b.db.prepare('UPDATE triggers SET paused_at = 1 WHERE id = ?').run('p');
    expect(b.manager.getDueTriggers().map((t) => t.id)).toEqual(['p']);
    expect(claimPauseNotices(b.db, NOW)).toEqual([]);
  });
});

describe('ACCEPTS leaves a paused plan out', () => {
  it('getDue does not list it, a webhook finds no receiver, and the consent reminder does not see it', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    plan(b, 'unstamped-agent', { stamped: false });
    expect(b.manager.getDueTriggers().map((t) => t.id)).toEqual(['p']);
    expect(b.manager.getAwaitingConsentUnreminded().map((t) => t.id)).toEqual(['unstamped-agent']);
    b.db.prepare('UPDATE triggers SET paused_at = ? WHERE id IN (?, ?)').run(NOW, 'p', 'unstamped-agent');
    expect(b.manager.getDueTriggers()).toEqual([]);
    expect(b.manager.getAwaitingConsentUnreminded()).toEqual([]);
    expect(b.engineDb.getDb().prepare('SELECT lease_until FROM triggers WHERE id = ?').get('p')).toEqual({ lease_until: null });
  });

  it('a webhook delivery to a paused plan finds no receiver', () => {
    const b = box();
    workflow(b, 'wf');
    b.history.insertWebhookTrigger({
      id: 'hook', title: 'Hook', pipelineId: 'wf', routeTokenHash: 'h1', spec: { verifier: 'shopify-hmac' },
      confirmedAt: '2027-01-01T00:00:00.000Z', confirmedBy: 'owner',
    });
    const store = (b.history as unknown as { _requireTriggerStore(): { findWebhookReceiver(h: string): unknown } })._requireTriggerStore();
    expect(store.findWebhookReceiver('h1')).toBeDefined();
    b.db.prepare('UPDATE triggers SET paused_at = ? WHERE id = ?').run(NOW, 'hook');
    expect(store.findWebhookReceiver('h1')).toBeUndefined();
  });
});

describe('who pauses: a member whose end is proven', () => {
  it('a member with a grant and an ended row pauses the plan, with who ended and why', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    login(b, 'h@x.ch', NOW - H, NOW - 2 * H);
    expect(sweep(b).paused).toEqual(['p']);
    const c = col(b, 'p');
    expect(c.paused_at).toBe(NOW);
    expect(c.paused_due_at).toBe(DUE);
    expect(c.pause_noticed_at).toBeNull();
    expect(pausedForOf(c.paused_for).entries).toEqual([
      // No warning was delivered for this end, so the entry says so (641c-2b).
      { mandateId: 'g-h@x.ch', email: 'h@x.ch', reason: 'expired', endsAt: NOW - H, roles: ['created'], closedPrompt: false, warned: false },
    ]);
  });

  it('a revoke reads as revoked', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    login(b, 'h@x.ch', NOW + H, NOW - H);
    b.ends.revoke('g-h@x.ch', NOW - 10);
    sweep(b);
    expect(pausedForOf(col(b, 'p').paused_for).entries[0]!.reason).toBe('revoked');
  });

  it('an unproven end pauses nothing: a member without a grant id, or without a row', () => {
    const b = box();
    plan(b, 'no-grant', { by: 'a@x.ch', grant: null });
    plan(b, 'no-row', { by: 'b@x.ch' });
    login(b, 'a@x.ch', NOW - H, NOW - 2 * H);
    expect(sweep(b).paused).toEqual([]);
    expect(col(b, 'no-grant').paused_at).toBeNull();
    expect(col(b, 'no-row').paused_at).toBeNull();
  });

  it('a live member pauses nothing', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    login(b, 'h@x.ch', NOW + H, NOW - H);
    expect(sweep(b).paused).toEqual([]);
  });

  it('a creator with no editor is the member, as the gate reads it', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    login(b, 'h@x.ch', NOW - H, NOW - 2 * H);
    const row = b.db.prepare('SELECT * FROM triggers WHERE id = ?').get('p') as PausePlanRow;
    const m = rowPlanMembers(row, () => undefined);
    expect(m.members).toEqual([{ kind: 'mandate', email: 'h@x.ch', mandateId: 'g-h@x.ch' }]);
    expect(planEndedMembers(m.members, (id) => b.ends.endRow(id), NOW)).toHaveLength(1);
  });

  it('an editor replaces the creator as the member, as the gate reads it (one member per side)', () => {
    const b = box();
    plan(b, 'p', { by: 'creator@x.ch', editor: { email: 'editor@x.ch', grant: 'g-editor@x.ch' } });
    login(b, 'creator@x.ch', NOW - H, NOW - 2 * H);
    login(b, 'editor@x.ch', NOW + H, NOW - H);
    expect(sweep(b).paused).toEqual([]);
    login(b, 'editor@x.ch', NOW - 1, NOW - 30);
    expect(sweep(b).paused).toEqual(['p']);
    expect(pausedForOf(col(b, 'p').paused_for).entries.map((e) => [e.email, e.roles])).toEqual([['editor@x.ch', ['edited']]]);
  });

  it('an owner plan without a stamp on a workflow a mandate wrote pauses: the predicate is the consent terms, not the stamp', () => {
    const b = box();
    workflow(b, 'wf', { email: 'h@x.ch', grant: 'g-h@x.ch' });
    plan(b, 'owner-wf', { effect: 'run_workflow', workflow: 'wf', stamped: false });
    login(b, 'h@x.ch', NOW - H, NOW - 2 * H);
    expect(sweep(b).paused).toEqual(['owner-wf']);
    expect(pausedForOf(col(b, 'owner-wf').paused_for).entries[0]!.roles).toEqual(['workflow-created']);
  });

  it("a mandate's unstamped proposal is left out: it does not run anyway", () => {
    const b = box();
    plan(b, 'proposal', { by: 'h@x.ch', stamped: false, effect: 'notify' });
    login(b, 'h@x.ch', NOW - H, NOW - 2 * H);
    expect(sweep(b).paused).toEqual([]);
  });

  it('a completed plan is not paused', () => {
    const b = box();
    plan(b, 'done', { by: 'h@x.ch' });
    b.db.prepare("UPDATE triggers SET status = 'completed' WHERE id = 'done'").run();
    login(b, 'h@x.ch', NOW - H, NOW - 2 * H);
    expect(sweep(b).paused).toEqual([]);
    expect(col(b, 'done').paused_at).toBeNull();
  });

  it('a workflow whose authorship cannot be read is skipped with a line on stderr, not paused, and the others go on', () => {
    const b = box();
    workflow(b, 'wf', { email: 'h@x.ch', grant: 'g-h@x.ch' });
    plan(b, 'via-wf', { effect: 'run_workflow', workflow: 'wf' });
    plan(b, 'own', { by: 'h@x.ch' });
    login(b, 'h@x.ch', NOW - H, NOW - 2 * H);
    // The workflow's authorship read fails; the sweep's own query over triggers does not.
    b.db.exec('ALTER TABLE workflows RENAME COLUMN mandate_edited_at TO gone');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(sweep(b)).toEqual({ paused: ['own'], skipped: ['via-wf'] });
    expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('plan via-wf: who set up its workflow could not be read');
    expect(col(b, 'via-wf').paused_at).toBeNull();
  });

  it('a second ended member is added to who ended, not skipped', () => {
    const b = box();
    workflow(b, 'wf', { email: 'w@x.ch', grant: 'g-w@x.ch' });
    plan(b, 'p', { by: 't@x.ch', effect: 'run_workflow', workflow: 'wf' });
    login(b, 't@x.ch', NOW - H, NOW - 2 * H);
    login(b, 'w@x.ch', NOW + H, NOW - 2 * H);
    sweep(b);
    const first = col(b, 'p');
    login(b, 'w@x.ch', NOW + 10, NOW - H);
    sweep(b, NOW + 20);
    const second = col(b, 'p');
    expect(second.paused_at).toBe(first.paused_at);
    expect(pausedForOf(second.paused_for).entries.map((e) => e.email)).toEqual(['t@x.ch', 'w@x.ch']);
  });

  it('a record of who ended that cannot be read is written again, and the pause holds', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    b.db.prepare("UPDATE triggers SET paused_at = 5, paused_for = '{not json' WHERE id = 'p'").run();
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    writePause(b.db, 'p', [{ mandateId: 'g', email: 'h@x.ch', reason: 'expired', endsAt: 1, roles: ['created'], closedPrompt: false }], NOW);
    expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('plan p');
    expect(col(b, 'p').paused_at).toBe(5);
    expect(pausedForOf(col(b, 'p').paused_for).entries).toHaveLength(1);
  });

  it('a writer that is not the pause leaves paused_* as they were', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    login(b, 'h@x.ch', NOW - H, NOW - 2 * H);
    sweep(b);
    const before = col(b, 'p');
    b.manager.recordTaskRun('p', 'done', 'success');
    b.manager.recordTaskRun('p', 'nope', 'failed');
    b.manager.setEnabled('p', false);
    b.manager.setEnabled('p', true);
    const after = col(b, 'p');
    expect([after.paused_at, after.paused_for, after.paused_due_at]).toEqual([before.paused_at, before.paused_for, before.paused_due_at]);
  });

  it('a failed run of a paused plan with retries left does not read as retrying', () => {
    const b = box();
    b.history.insertTrigger({ id: 'once', title: 'Once', source: 'cron', effect: 'notify', nextRunAt: DUE, maxRetries: 3, createdBy: tag('h@x.ch'), createdMandateId: 'g-h@x.ch', confirmedAt: '2027-01-01T00:00:00.000Z' });
    expect(b.manager.recordTaskRun('once', 'x', 'failed')).toBe(true);
    b.db.prepare('UPDATE triggers SET paused_at = 1 WHERE id = ?').run('once');
    expect(b.manager.recordTaskRun('once', 'x', 'failed')).toBe(false);
  });

  it('keepSchedule records the run and leaves status, next run and retries alone', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    const before = col(b, 'p');
    expect(b.manager.recordTaskRun('p', 'gate', 'stopped', { keepSchedule: true })).toBe(false);
    const after = b.db.prepare('SELECT status, next_run_at, last_run_status, last_run_result FROM triggers WHERE id = ?').get('p');
    expect(after).toEqual({ status: before.status, next_run_at: before.next_run_at, last_run_status: 'stopped', last_run_result: 'gate' });
  });
});

describe('the sweep, one plan at a time', () => {
  it('a plan whose write fails is said on stderr with its id, and the others are paused', () => {
    const b = box();
    plan(b, 'bad', { by: 'h@x.ch' });
    plan(b, 'good', { by: 'h@x.ch' });
    b.db.exec("CREATE TRIGGER boom BEFORE UPDATE OF paused_at ON triggers WHEN NEW.id = 'bad' BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
    login(b, 'h@x.ch', NOW - H, NOW - 2 * H);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const r = sweep(b);
    expect(r).toEqual({ paused: ['good'], skipped: ['bad'] });
    expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('plan bad');
    expect(col(b, 'bad').paused_at).toBeNull();
    expect(col(b, 'bad').paused_for).toBeNull();
  });

  it('closes the open question of every paused plan, and tries again while it stays open', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    login(b, 'h@x.ch', NOW - H, NOW - 2 * H);
    const closeQuestion = vi.fn().mockImplementationOnce(() => { throw new Error('locked'); });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    sweep(b, NOW, { closeQuestion });
    expect(col(b, 'p').paused_at).toBe(NOW);
    expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('closing its question');
    sweep(b, NOW + 300, { closeQuestion });
    expect(closeQuestion.mock.calls).toEqual([['p'], ['p']]);
  });
});

describe('the login that extends an ended grant', () => {
  function listen(b: Box): void {
    b.ends.onExtendAfterEnd((mandateId, before, nowS) => {
      pauseEndedPlans({ db: b.db, endOf: (id) => (id === mandateId ? before : undefined), onlyMandate: mandateId, nowS });
    });
  }

  it('pauses the plan before the extension commits, so it stays paused once the mandate is live again', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
    const b = box();
    listen(b);
    plan(b, 'p', { by: 'h@x.ch' });
    login(b, 'h@x.ch', NOW - H, NOW - 2 * H);
    expect(col(b, 'p').paused_at).toBeNull();
    login(b, 'h@x.ch', NOW + 30 * 24 * H, NOW - 10);
    expect(b.ends.isLive('g-h@x.ch')).toBe(true);
    const c = col(b, 'p');
    expect(c.paused_at).toBe(NOW);
    // `endsAt` is the end that had passed, from the row read before the upsert.
    expect(pausedForOf(c.paused_for).entries[0]!.endsAt).toBe(NOW - H);
    expect(b.manager.getDueTriggers()).toEqual([]);
    vi.useRealTimers();
  });

  it('does nothing for a login that changes nothing, or before the end', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
    const b = box();
    listen(b);
    // The listener's own contract: it hears only an extension of an end that had passed.
    const heard: string[] = [];
    b.ends.onExtendAfterEnd((mandateId) => { heard.push(mandateId); });
    plan(b, 'p', { by: 'h@x.ch' });
    login(b, 'h@x.ch', NOW + H, NOW - 2 * H);
    login(b, 'h@x.ch', NOW + 2 * H, NOW - H);
    expect(col(b, 'p').paused_at).toBeNull();
    expect(heard).toEqual([]);
    // The same listener hears the extension once the end has passed.
    vi.setSystemTime((NOW + 3 * H) * 1000);
    login(b, 'h@x.ch', NOW + 30 * H, NOW + 3 * H - 10);
    expect(heard).toEqual(['g-h@x.ch']);
    vi.useRealTimers();
  });

  it('a plan whose write fails fails the login: nothing commits, and the next login after the cause is gone pauses both', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
    const b = box();
    listen(b);
    plan(b, 'bad', { by: 'h@x.ch' });
    plan(b, 'good', { by: 'h@x.ch' });
    b.db.exec("CREATE TRIGGER boom BEFORE UPDATE OF paused_at ON triggers WHEN NEW.id = 'bad' BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
    login(b, 'h@x.ch', NOW - H, NOW - 2 * H);
    // After this login commits the end is no longer proven, so no sweep could pause 'bad' later.
    expect(() => login(b, 'h@x.ch', NOW + H, NOW - 10)).toThrow('plan bad: pausing it failed, the login is refused');
    expect(b.ends.isLive('g-h@x.ch')).toBe(false);
    expect(b.ends.endOf('g-h@x.ch')).toBe(NOW - H);
    expect(col(b, 'good').paused_at).toBeNull();
    expect(col(b, 'bad').paused_at).toBeNull();
    b.db.exec('DROP TRIGGER boom');
    login(b, 'h@x.ch', NOW + H, NOW - 10);
    expect(b.ends.isLive('g-h@x.ch')).toBe(true);
    expect(col(b, 'good').paused_at).toBe(NOW);
    expect(col(b, 'bad').paused_at).toBe(NOW);
    vi.useRealTimers();
  });

  it('a plan whose workflow cannot be read does not refuse the login: the login goes through, a plan of the mandate’s own schedule pauses, one it has only through the workflow does not, and stderr names both', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
    const b = box();
    listen(b);
    workflow(b, 'wf', { email: 'h@x.ch', grant: 'g-h@x.ch' });
    plan(b, 'via-wf', { effect: 'run_workflow', workflow: 'wf' });
    plan(b, 'own-on-wf', { by: 'h@x.ch', effect: 'run_workflow', workflow: 'wf' });
    plan(b, 'own', { by: 'h@x.ch' });
    login(b, 'h@x.ch', NOW - H, NOW - 2 * H);
    b.db.exec('ALTER TABLE workflows RENAME COLUMN mandate_edited_at TO gone');
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    login(b, 'h@x.ch', NOW + H, NOW - 10);
    const lines = err.mock.calls.map((c) => String(c[0]));
    err.mockRestore();
    b.db.exec('ALTER TABLE workflows RENAME COLUMN gone TO mandate_edited_at');
    expect(b.ends.endOf('g-h@x.ch')).toBe(NOW + H);
    expect(col(b, 'own').paused_at).toBe(NOW);
    expect(col(b, 'own-on-wf').paused_at).toBe(NOW);
    expect(col(b, 'via-wf').paused_at).toBeNull();
    expect(lines.filter((l) => l.includes("who set up its workflow could not be read, paused on the schedule's own marks only")).map((l) => l.slice(0, 22)))
      .toEqual(['[lynox] plan via-wf: w', '[lynox] plan own-on-wf']);
    vi.useRealTimers();
  });

  it('a failure of the transaction itself fails the login, records nothing, and the next login after the cause is gone succeeds', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    login(b, 'h@x.ch', NOW - H, NOW - 2 * H);
    const stop = b.ends.onExtendAfterEnd(() => { throw new Error('disk I/O error'); });
    expect(() => login(b, 'h@x.ch', NOW + H, NOW - 10)).toThrow('disk I/O error');
    // Nothing committed: the end is the old one, and the in-process cache did not take the login.
    expect(b.ends.endOf('g-h@x.ch')).toBe(NOW - H);
    stop();
    listen(b);
    login(b, 'h@x.ch', NOW + H, NOW - 10);
    expect(b.ends.endOf('g-h@x.ch')).toBe(NOW + H);
    expect(col(b, 'p').paused_at).toBe(NOW);
    vi.useRealTimers();
  });
});

describe("the owner's notice", () => {
  function paused(b: Box, id: string, email: string, reason: 'expired' | 'revoked' = 'expired'): void {
    plan(b, id, { by: email });
    writePause(b.db, id, [{ mandateId: `g-${email}`, email, reason, endsAt: NOW - H, roles: ['created'], closedPrompt: false }], NOW);
  }

  it('one notice per mandate with its count, claimed once', () => {
    const b = box();
    paused(b, 'a', 'h@x.ch');
    paused(b, 'b', 'h@x.ch');
    const first = claimPauseNotices(b.db, NOW);
    expect(first).toHaveLength(1);
    expect(first[0]!.title).toContain('2 plans are paused');
    expect(first[0]!.body).toContain('2 plans in which they created or changed something are paused');
    expect(claimPauseNotices(b.db, NOW + 60)).toEqual([]);
  });

  it('two processes on one file send it once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-pause-two-'));
    const a = box(dir);
    const c = box(dir);
    paused(a, 'p', 'h@x.ch');
    expect([...claimPauseNotices(a.db, NOW), ...claimPauseNotices(c.db, NOW)]).toHaveLength(1);
  });

  it('a second pause of the same plan is told again', () => {
    const b = box();
    paused(b, 'p', 'h@x.ch');
    expect(claimPauseNotices(b.db, NOW)).toHaveLength(1);
    b.db.prepare('UPDATE triggers SET paused_at = NULL WHERE id = ?').run('p');
    writePause(b.db, 'p', [], NOW + 10);
    expect(claimPauseNotices(b.db, NOW + 20)).toHaveLength(1);
  });

  it('a plan completed after its pause is not told and not counted', () => {
    const b = box();
    paused(b, 'p', 'h@x.ch');
    b.manager.complete('p');
    expect(claimPauseNotices(b.db, NOW)).toEqual([]);
  });

  it('a member that ends after the plan was told about is not told again (one notice per plan)', () => {
    const b = box();
    paused(b, 'p', 'first@x.ch');
    expect(claimPauseNotices(b.db, NOW)).toHaveLength(1);
    writePause(b.db, 'p', [{ mandateId: 'g-second', email: 'second@x.ch', reason: 'expired', endsAt: NOW, roles: ['edited'], closedPrompt: false }], NOW + 10);
    expect(pausedForOf(col(b, 'p').paused_for).entries).toHaveLength(2);
    expect(claimPauseNotices(b.db, NOW + 20)).toEqual([]);
  });

  it('one mandate with one end is one notice, as before the grouping by end', () => {
    const b = box();
    paused(b, 'a', 'h@x.ch');
    paused(b, 'c', 'h@x.ch');
    paused(b, 'd', 'h@x.ch');
    const notices = claimPauseNotices(b.db, NOW);
    expect(notices.map((n) => n.title)).toEqual(['⏸ 3 plans are paused']);
  });

  it('one mandate with two ends is two notices, each with its own date and count, and none is lost', () => {
    const b = box();
    const at = (id: string, endsAt: number): void => {
      plan(b, id, { by: 'h@x.ch' });
      writePause(b.db, id, [{ mandateId: 'g-h@x.ch', email: 'h@x.ch', reason: 'expired', endsAt, roles: ['created'], closedPrompt: false }], NOW);
    };
    at('a', Date.UTC(2026, 9, 31) / 1000);
    at('c', Date.UTC(2026, 10, 30) / 1000);
    at('d', Date.UTC(2026, 10, 30) / 1000);
    const bodies = claimPauseNotices(b.db, NOW).map((n) => n.body).sort();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatch(/^h@x\.ch had access until 2026-10-31\. A plan /);
    expect(bodies[1]).toMatch(/^h@x\.ch had access until 2026-11-30\. 2 plans /);
  });

  it('the sentence about a warning follows the entries of the group: all, some or none warned', () => {
    const b = box();
    const at = (id: string, email: string, warned: boolean): void => {
      plan(b, id, { by: email });
      writePause(b.db, id, [{ mandateId: `g-${email}`, email, reason: 'expired', endsAt: NOW - H, roles: ['created'], closedPrompt: false, warned }], NOW);
    };
    at('a1', 'all@x.ch', true);
    at('a2', 'all@x.ch', true);
    at('s1', 'some@x.ch', true);
    at('s2', 'some@x.ch', false);
    at('n1', 'none@x.ch', false);
    at('n2', 'none@x.ch', false);
    const byName = Object.fromEntries(claimPauseNotices(b.db, NOW).map((n) => [n.body.split(' ')[0]!, n.body]));
    expect(byName['all@x.ch']).not.toContain('advance notice');
    expect(byName['some@x.ch']!.endsWith(' Not all had advance notice.')).toBe(true);
    expect(byName['none@x.ch']!.endsWith(' There was no advance notice.')).toBe(true);
  });

  it('an expiry and a revoke of one mandate at one end are two notices: the expiry still says it had no warning', () => {
    const b = box();
    const at = (id: string, reason: 'expired' | 'revoked'): void => {
      plan(b, id, { by: 'h@x.ch' });
      writePause(b.db, id, [{ mandateId: 'g-h@x.ch', email: 'h@x.ch', reason, endsAt: NOW - H, roles: ['created'], closedPrompt: false, warned: false }], NOW);
    };
    // The revoke first, so a group by mandate and end alone would take its wording.
    at('r', 'revoked');
    at('e', 'expired');
    const bodies = claimPauseNotices(b.db, NOW).map((n) => n.body).sort();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.endsWith(' There was no advance notice.')).toBe(true);
    expect(bodies[1]!.startsWith("h@x.ch's access was revoked.")).toBe(true);
  });

  it('says a revoke as a revoke, and one plan in the singular', () => {
    const b = box();
    paused(b, 'p', 'h@x.ch', 'revoked');
    const [n] = claimPauseNotices(b.db, NOW);
    expect(n!.title).toBe('⏸ A plan is paused');
    expect(n!.body.startsWith("h@x.ch's access was revoked.")).toBe(true);
  });

  const ended = (email: string, reason: 'expired' | 'revoked'): PausedFor =>
    ({ mandateId: 'g', email, reason, endsAt: Date.UTC(2026, 9, 31) / 1000, roles: ['created'], closedPrompt: false });
  const EXTENDED = 'even if the access has since been extended.';
  const NO_ADVANCE = 'There was no advance notice.';

  it('the four wordings, exactly', () => {
    expect([1, 3].map((c) => pauseNotice(ended('h@x.ch', 'expired'), c, 'none').body)).toEqual([
      'h@x.ch had access until 2026-10-31. A plan in which they created or changed something is paused. It runs again only once you take it over, even if the access has since been extended. There was no advance notice.',
      'h@x.ch had access until 2026-10-31. 3 plans in which they created or changed something are paused. The plans run again only once you take them over, even if the access has since been extended. There was no advance notice.',
    ]);
    expect([1, 3].map((c) => pauseNotice(ended('h@x.ch', 'revoked'), c, 'none').body)).toEqual([
      "h@x.ch's access was revoked. A plan in which they created or changed something is paused. It runs again only once you take it over.",
      "h@x.ch's access was revoked. 3 plans in which they created or changed something are paused. The plans run again only once you take them over.",
    ]);
  });

  it('an expiry says whether its plans were warned, per entry; a revocation never does', () => {
    // The sentence follows the delivered warnings, not a switch (legal, POS-069 Nachtrag 5).
    for (const count of [1, 3]) {
      expect(pauseNotice(ended('h@x.ch', 'expired'), count, 'none').body.endsWith(NO_ADVANCE)).toBe(true);
      expect(pauseNotice(ended('h@x.ch', 'expired'), count, 'all').body.endsWith(EXTENDED)).toBe(true);
      for (const warned of ['all', 'some', 'none'] as const) {
        expect(pauseNotice(ended('h@x.ch', 'revoked'), count, warned).body).not.toContain('advance notice');
      }
    }
    expect(pauseNotice(ended('h@x.ch', 'expired'), 3, 'some').body.endsWith(' Not all had advance notice.')).toBe(true);
  });

  it('a tap on the notice opens the paused plans, for either reason', () => {
    for (const reason of ['expired', 'revoked'] as const) {
      expect(pauseNotice(ended('h@x.ch', reason), 2, 'none').data).toEqual({ pausedPlans: '1' });
    }
  });

  it('goes to the owner\'s devices only: it names a helper and how their access ended', () => {
    for (const reason of ['expired', 'revoked'] as const) {
      for (const count of [1, 3]) expect(pauseNotice(ended('h@x.ch', reason), count, 'none').audience).toBe('owner');
    }
  });

  it('a long name gives way with "…", and no sentence is cut', () => {
    const long = `${'a'.repeat(70)}@example.invalid`;
    for (const reason of ['expired', 'revoked'] as const) {
      for (const count of [1, 12, 1234]) {
        const body = pauseNotice(ended(long, reason), count, 'none').body;
        expect(body.length, `${reason} ${String(count)}`).toBeLessThanOrEqual(PAUSE_NOTICE_BODY_MAX);
        // Cut only where the full name does not fit, and then to the bound exactly.
        if (body.startsWith(long)) expect(body).not.toContain('…');
        else expect([body.length, /^a+…/.test(body)]).toEqual([PAUSE_NOTICE_BODY_MAX, true]);
        expect(body.endsWith(reason === 'expired' ? NO_ADVANCE : 'take it over.') || body.endsWith('take them over.')).toBe(true);
        if (reason === 'expired') expect(body).toContain(EXTENDED);
      }
    }
    // The expiry with a long name is the case that is cut.
    expect(pauseNotice(ended(long, 'expired'), 12, 'none').body).toMatch(/^a+… had access until/);
    // A name that fits is not touched. The sentence that no warning came leaves an expiry of 2–99
    // plans 24 characters of name: 24 fit, 25 give way.
    const fits = pauseNotice(ended(`${'b'.repeat(19)}@x.ch`, 'expired'), 12, 'none').body;
    expect(fits).toContain(`${'b'.repeat(19)}@x.ch had access until`);
    expect(fits).not.toContain('…');
    expect(pauseNotice(ended(`${'b'.repeat(20)}@x.ch`, 'expired'), 12, 'none').body).toContain('…');
    // A mixed group leaves 25 (ux U-065), and with every plan warned there is no sentence to make room for.
    expect(pauseNotice(ended(`${'b'.repeat(20)}@x.ch`, 'expired'), 12, 'some').body).not.toContain('…');
    expect(pauseNotice(ended(`${'b'.repeat(21)}@x.ch`, 'expired'), 12, 'some').body).toContain('…');
    expect(pauseNotice(ended(`${'b'.repeat(48)}@x.ch`, 'expired'), 12, 'all').body).not.toContain('…');
    expect(pauseNotice(ended(`${'b'.repeat(49)}@x.ch`, 'expired'), 12, 'all').body).toContain('…');
  });
});

describe("the owner's advance warning (641c-2b)", () => {
  /** A mandate whose end is `endsAt`, as its login wrote it. */
  const ending = (b: Box, endsAt: number, email = 'h@x.ch'): void => { login(b, email, endsAt, NOW - 2 * H); };
  const warnedRows = (b: Box): Array<{ trigger_id: string; delivered_at: number | null }> =>
    b.db.prepare('SELECT trigger_id, delivered_at FROM plan_advance_warnings ORDER BY trigger_id').all() as never;
  /** A one-off a mandate created, run once at `at`. */
  const oneOff = (b: Box, id: string, at: string, status?: string): void => {
    b.history.insertTrigger({
      id, title: `Plan ${id}`, source: 'manual', effect: 'run_agent', nextRunAt: at,
      confirmedAt: '2027-01-01T00:00:00.000Z', confirmedBy: 'owner', createdBy: tag('h@x.ch'), createdMandateId: 'g-h@x.ch',
    });
    if (status !== undefined) b.db.prepare('UPDATE triggers SET status = ? WHERE id = ?').run(status, id);
  };
  const iso = (s: number): string => new Date(s * 1000).toISOString();

  it('goes out once the end is less than a day away, not before, not once it has passed, never for a revoke', () => {
    expect(ADVANCE_WARNING_S).toBe(24 * 60 * 60);
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    ending(b, NOW + ADVANCE_WARNING_S);
    expect(claimAdvanceWarnings(b.db, NOW - 1)).toEqual([]);
    expect(claimAdvanceWarnings(b.db, NOW)).toHaveLength(1);

    const passed = box();
    plan(passed, 'p', { by: 'h@x.ch' });
    ending(passed, NOW);
    expect(claimAdvanceWarnings(passed.db, NOW)).toEqual([]);

    const revoked = box();
    plan(revoked, 'p', { by: 'h@x.ch' });
    ending(revoked, NOW + H);
    revoked.ends.revoke('g-h@x.ch', NOW - H);
    expect(claimAdvanceWarnings(revoked.db, NOW)).toEqual([]);
  });

  it('the plans there at the first sweep are one warning per mandate and end, with their count, and it goes once', () => {
    const b = box();
    plan(b, 'a', { by: 'h@x.ch' });
    plan(b, 'c', { by: 'h@x.ch' });
    plan(b, 'o', { by: 'other@x.ch' });
    ending(b, NOW + H);
    ending(b, NOW + 2 * H, 'other@x.ch');
    const first = claimAdvanceWarnings(b.db, NOW);
    expect(first.map((w) => [w.message.title, w.keys.length]).sort()).toEqual([['A plan will pause soon', 1], ['Plans will pause soon', 2]]);
    expect(first.find((w) => w.keys.length === 2)!.message.body).toContain('Then 2 plans in which they created');
    expect(claimAdvanceWarnings(b.db, NOW + 60)).toEqual([]);
    expect(warnedRows(b).map((r) => r.trigger_id)).toEqual(['a', 'c', 'o']);
  });

  it('a sweep with nothing new to claim writes nothing: no claiming statement is even prepared', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    ending(b, NOW + H);
    expect(claimAdvanceWarnings(b.db, NOW)).toHaveLength(1);
    const prepared: string[] = [];
    const prepare = b.db.prepare.bind(b.db);
    vi.spyOn(b.db, 'prepare').mockImplementation(((sql: string) => { prepared.push(sql); return prepare(sql); }) as typeof b.db.prepare);
    expect(claimAdvanceWarnings(b.db, NOW + 60)).toEqual([]);
    expect(prepared.filter((q) => q.startsWith('INSERT'))).toEqual([]);
  });

  it('a plan that joins after the warning gets its own, as one more plan; those named before are not named again', () => {
    const b = box();
    plan(b, 'a', { by: 'h@x.ch' });
    ending(b, NOW + H);
    const [first] = claimAdvanceWarnings(b.db, NOW);
    markWarningsDelivered(b.db, first!.keys, NOW + 1);
    plan(b, 'late', { by: 'h@x.ch' });
    const [w, ...rest] = claimAdvanceWarnings(b.db, NOW + 60);
    expect(rest).toEqual([]);
    expect(w!.keys.map((k) => k.triggerId)).toEqual(['late']);
    expect(w!.message.title).toBe('A plan will pause soon');
    expect(w!.message.body).toContain('Then one more plan in which they created');
  });

  it('a plan that joins after a warning no channel accepted is not "one more": the owner may have had none', () => {
    const b = box();
    plan(b, 'a', { by: 'h@x.ch' });
    ending(b, NOW + H);
    expect(claimAdvanceWarnings(b.db, NOW)).toHaveLength(1);
    plan(b, 'late', { by: 'h@x.ch' });
    const [w] = claimAdvanceWarnings(b.db, NOW + 60);
    expect(w!.keys.map((k) => k.triggerId)).toEqual(['late']);
    expect(w!.message.body).toContain('Then a plan in which they created');
  });

  it('an extension (a later end) warns again once that end is less than a day away', () => {
    const b = box();
    plan(b, 'a', { by: 'h@x.ch' });
    plan(b, 'c', { by: 'h@x.ch' });
    ending(b, NOW + H);
    expect(claimAdvanceWarnings(b.db, NOW)).toHaveLength(1);
    login(b, 'h@x.ch', NOW + 30 * H, NOW);
    expect(claimAdvanceWarnings(b.db, NOW + 60)).toEqual([]);
    const again = claimAdvanceWarnings(b.db, NOW + 6 * H);
    expect(again.map((w) => w.keys.length)).toEqual([2]);
    // A new end, so not "one more": the earlier warning was of another end.
    expect(again[0]!.message.body).toContain('Then 2 plans');
  });

  it('counts the plans the end would pause: through the workflow too, without completed, paused, disabled or unconsented ones, nor a one-off done by then', () => {
    const b = box();
    const end = NOW + H;
    ending(b, end);
    plan(b, 'cron', { by: 'h@x.ch' });
    workflow(b, 'wf', { email: 'h@x.ch', grant: 'g-h@x.ch' });
    plan(b, 'via-wf', { effect: 'run_workflow', workflow: 'wf' });
    plan(b, 'done', { by: 'h@x.ch' });
    b.manager.complete('done');
    plan(b, 'paused', { by: 'h@x.ch' });
    b.db.prepare('UPDATE triggers SET paused_at = 1 WHERE id = ?').run('paused');
    plan(b, 'off', { by: 'h@x.ch' });
    b.db.prepare('UPDATE triggers SET enabled = 0 WHERE id = ?').run('off');
    plan(b, 'proposal', { by: 'h@x.ch', stamped: false });
    plan(b, 'failed-cron', { by: 'h@x.ch' });
    b.db.prepare("UPDATE triggers SET status = 'failed' WHERE id = ?").run('failed-cron');
    oneOff(b, 'once-before', iso(end - 60));
    oneOff(b, 'once-after', iso(end + 60));
    oneOff(b, 'once-failed', iso(end + 60), 'failed');
    const [w] = claimAdvanceWarnings(b.db, NOW);
    expect(w!.keys.map((k) => k.triggerId).sort()).toEqual(['cron', 'failed-cron', 'once-after', 'via-wf']);
    expect(w!.message.body).toContain('Then 4 plans');
  });

  it('a plan whose workflow cannot be read is skipped with one line on stderr per process, and the others are warned', () => {
    const b = box();
    plan(b, 'a', { by: 'h@x.ch' });
    workflow(b, 'wf', { email: 'h@x.ch', grant: 'g-h@x.ch' });
    plan(b, 'via-wf', { effect: 'run_workflow', workflow: 'wf' });
    ending(b, NOW + H);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const prepare = b.db.prepare.bind(b.db);
    vi.spyOn(b.db, 'prepare').mockImplementation(((sql: string) => {
      if (sql.includes('FROM workflows WHERE id')) throw new Error('disk I/O error');
      return prepare(sql);
    }) as typeof b.db.prepare);
    const [w] = claimAdvanceWarnings(b.db, NOW);
    expect(w!.keys.map((k) => k.triggerId)).toEqual(['a']);
    claimAdvanceWarnings(b.db, NOW + 60);
    expect(err.mock.calls.filter(([l]) => String(l).includes('plan via-wf'))).toHaveLength(1);
  });

  it('the three wordings, exactly, to the owner only, with no tap target', () => {
    const end = Date.UTC(2026, 10, 12, 9) / 1000;
    expect([advanceWarning('h@x.ch', end, 3, false), advanceWarning('h@x.ch', end, 1, false), advanceWarning('h@x.ch', end, 1, true)]
      .map((m) => [m.title, m.body, m.audience, m.data])).toEqual([
      ['Plans will pause soon', 'h@x.ch has access until 2026-11-12. Then 3 plans in which they created or changed something will pause, even if you extended the access, unless they sign in once before then. Once paused, you can take them over.', 'owner', undefined],
      ['A plan will pause soon', 'h@x.ch has access until 2026-11-12. Then a plan in which they created or changed something will pause, even if you extended the access, unless they sign in once before then. Once paused, you can take it over.', 'owner', undefined],
      ['A plan will pause soon', 'h@x.ch has access until 2026-11-12. Then one more plan in which they created or changed something will pause, even if you extended the access, unless they sign in once before then. Once paused, you can take it over.', 'owner', undefined],
    ]);
  });

  it('every wording fits a push with a 30-character name and 99 plans, and a longer name gives way to the bound', () => {
    const end = Date.UTC(2026, 10, 12, 9) / 1000;
    const name = `${'n'.repeat(25)}@x.ch`;
    for (const [count, more] of [[99, false], [1, false], [1, true]] as const) {
      const body = advanceWarning(name, end, count, more).body;
      expect(body.length, `${String(count)} ${String(more)}`).toBeLessThanOrEqual(PAUSE_NOTICE_BODY_MAX);
      expect(body.startsWith(name)).toBe(true);
      const long = advanceWarning(`${'a'.repeat(70)}@example.invalid`, end, count, more).body;
      expect([long.length, /^a+… has access until/.test(long)]).toEqual([PAUSE_NOTICE_BODY_MAX, true]);
    }
  });

  it('a pause says warned only for a plan whose warning of that end was delivered, on every way of pausing', () => {
    const b = box();
    for (const id of ['delivered', 'claimed', 'gate']) plan(b, id, { by: 'h@x.ch' });
    ending(b, NOW + H);
    const [w] = claimAdvanceWarnings(b.db, NOW);
    markWarningsDelivered(b.db, w!.keys.filter((k) => k.triggerId !== 'claimed'), NOW + 1);
    const after = NOW + 2 * H;
    expect(pausePlanNow(b.db, 'gate', (id) => b.ends.endRow(id), false, after)).toBe(true);
    sweep(b, after);
    const warned = (id: string): boolean | undefined => pausedForOf(col(b, id).paused_for).entries[0]?.warned;
    expect([warned('delivered'), warned('claimed'), warned('gate')]).toEqual([true, false, true]);
  });

  it('a delivered warning of an earlier end does not make a pause at a later end warned', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    ending(b, NOW + H);
    const [w] = claimAdvanceWarnings(b.db, NOW);
    markWarningsDelivered(b.db, w!.keys, NOW);
    login(b, 'h@x.ch', NOW + 2 * H, NOW + 1);
    expect(deliveredWarning(b.db, 'p')('g-h@x.ch', NOW + H)).toBe(true);
    expect(deliveredWarning(b.db, 'p')('g-h@x.ch', NOW + 2 * H)).toBe(false);
    sweep(b, NOW + 3 * H);
    expect(pausedForOf(col(b, 'p').paused_for).entries[0]?.warned).toBe(false);
  });

  it('a warning a channel accepted only once the end had passed is not advance notice', () => {
    const b = box();
    for (const id of ['before', 'at', 'after']) plan(b, id, { by: 'h@x.ch' });
    ending(b, NOW + H);
    const [w] = claimAdvanceWarnings(b.db, NOW);
    const key = (id: string) => w!.keys.filter((k) => k.triggerId === id);
    markWarningsDelivered(b.db, key('before'), NOW + H - 1);
    markWarningsDelivered(b.db, key('at'), NOW + H);
    markWarningsDelivered(b.db, key('after'), NOW + H + 30);
    sweep(b, NOW + 2 * H);
    const warned = (id: string): boolean | undefined => pausedForOf(col(b, id).paused_for).entries[0]?.warned;
    expect([warned('before'), warned('at'), warned('after')]).toEqual([true, false, false]);
  });

  it('marks only the rows it is given, and keeps the first delivery time', () => {
    const b = box();
    plan(b, 'a', { by: 'h@x.ch' });
    plan(b, 'c', { by: 'h@x.ch' });
    ending(b, NOW + H);
    const [w] = claimAdvanceWarnings(b.db, NOW);
    markWarningsDelivered(b.db, w!.keys.filter((k) => k.triggerId === 'a'), NOW + 5);
    markWarningsDelivered(b.db, w!.keys, NOW + 9);
    expect(warnedRows(b)).toEqual([{ trigger_id: 'a', delivered_at: NOW + 5 }, { trigger_id: 'c', delivered_at: NOW + 9 }]);
  });

  it('with the switch off nothing is claimed', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    ending(b, NOW + H);
    restore();
    restore = setPlanPauseForTests(false);
    expect(claimAdvanceWarnings(b.db, NOW)).toEqual([]);
    expect(warnedRows(b)).toEqual([]);
  });

  it("a plan's rows go with the plan, and the owner's erasure empties the table", () => {
    const b = box();
    plan(b, 'a', { by: 'h@x.ch' });
    plan(b, 'c', { by: 'h@x.ch' });
    ending(b, NOW + H);
    claimAdvanceWarnings(b.db, NOW);
    b.db.prepare('DELETE FROM triggers WHERE id = ?').run('a');
    expect(warnedRows(b).map((r) => r.trigger_id)).toEqual(['c']);
    b.engineDb.deleteAllData();
    expect(warnedRows(b)).toEqual([]);
  });
});

describe('the advance warning under a forced race', () => {
  /** Runs `between` after A has read what it would claim and before its claiming transaction. */
  function raced(a: Box, between: () => void): ReturnType<Box['engineDb']['getDb']> {
    return new Proxy(a.db, {
      get(target, key, receiver) {
        if (key !== 'prepare') return Reflect.get(target, key, receiver) as unknown;
        return (sql: string) => {
          if (sql.startsWith('INSERT OR IGNORE INTO plan_advance_warnings')) between();
          return target.prepare(sql);
        };
      },
    });
  }
  function two(): { a: Box; c: Box } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-warn-race-'));
    const a = box(dir);
    const c = box(dir);
    plan(a, 'p', { by: 'h@x.ch' });
    plan(a, 'q', { by: 'h@x.ch' });
    login(a, 'h@x.ch', NOW + H, NOW - 2 * H);
    return { a, c };
  }

  it('a second process that claims in between leaves the first one warning of nothing: one warning in all', () => {
    const { a, c } = two();
    let fromC: ReturnType<typeof claimAdvanceWarnings> = [];
    const fromA = claimAdvanceWarnings(raced(a, () => { fromC = claimAdvanceWarnings(c.db, NOW); }), NOW);
    expect(fromC.map((w) => w.keys.length)).toEqual([2]);
    expect(fromA).toEqual([]);
  });

  it('a plan paused in between, or an end a login moved in between, is not warned of', () => {
    const { a, c } = two();
    const fromA = claimAdvanceWarnings(raced(a, () => {
      c.db.prepare('UPDATE triggers SET paused_at = 1 WHERE id = ?').run('p');
    }), NOW);
    expect(fromA.map((w) => w.keys.map((k) => k.triggerId))).toEqual([['q']]);

    const moved = two();
    const none = claimAdvanceWarnings(raced(moved.a, () => {
      login(moved.c, 'h@x.ch', NOW + 40 * H, NOW);
    }), NOW);
    expect(none).toEqual([]);

    const revoked = two();
    expect(claimAdvanceWarnings(raced(revoked.a, () => { revoked.c.ends.revoke('g-h@x.ch', NOW); }), NOW)).toEqual([]);
    // Disabled, completed or stopped in between: the claim reads the plan again and leaves it out.
    for (const change of ["UPDATE triggers SET enabled = 0 WHERE id = 'p'", "UPDATE triggers SET status = 'completed' WHERE id = 'p'", "UPDATE triggers SET status = 'stopped' WHERE id = 'p'"]) {
      const t = two();
      const w = claimAdvanceWarnings(raced(t.a, () => { t.c.db.prepare(change).run(); }), NOW);
      expect(w.map((x) => x.keys.map((k) => k.triggerId)), change).toEqual([['q']]);
    }
  });
});

describe('the advance warning\'s claiming transaction', () => {
  it('holds the write lock from its first read: a second process cannot write until the claims are in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-warn-lock-'));
    const a = box(dir);
    const c = box(dir);
    plan(a, 'p', { by: 'h@x.ch' });
    plan(a, 'q', { by: 'h@x.ch' });
    login(a, 'h@x.ch', NOW + H, NOW - 2 * H);
    c.db.pragma('busy_timeout = 0');
    let refused: string | undefined = 'not tried';
    const reread = 'SELECT paused_at, status, enabled, source, next_run_at FROM triggers WHERE id = ?';
    const raced = new Proxy(a.db, {
      get(target, key, receiver) {
        if (key !== 'prepare') return Reflect.get(target, key, receiver) as unknown;
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (sql !== reread) return stmt;
          return new Proxy(stmt, {
            get(s, k, r) {
              if (k !== 'get') return Reflect.get(s, k, r) as unknown;
              return (...args: unknown[]) => {
                // Inside the claim's transaction, at its first read: C tries to write.
                if (refused === 'not tried') {
                  try {
                    c.db.prepare("UPDATE triggers SET title = 'x' WHERE id = 'q'").run();
                    refused = undefined;
                  } catch (err: unknown) {
                    refused = (err as { code?: string }).code;
                  }
                }
                return (s.get as (...a: unknown[]) => unknown).apply(s, args);
              };
            },
          });
        };
      },
    });
    const w = claimAdvanceWarnings(raced, NOW);
    expect(refused).toBe('SQLITE_BUSY');
    expect(w.map((x) => x.keys.length)).toEqual([2]);
  });
});

describe('the migration', () => {
  it('v57 adds the four pause columns, NULL on every existing row', () => {
    const b = box();
    expect((b.db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(64);
    const cols = (b.db.prepare('PRAGMA table_info(triggers)').all() as Array<{ name: string; dflt_value: unknown }>)
      .filter((c) => c.name.startsWith('pause'));
    // `paused_db_at` is v60's (the takeover's clock), not v57's.
    expect(cols.map((c) => [c.name, c.dflt_value])).toEqual([
      ['paused_at', null], ['paused_due_at', null], ['paused_for', null], ['pause_noticed_at', null], ['paused_db_at', null],
    ]);
  });
});

describe('the notice under a forced race', () => {
  it('a second process that claims between the first one\'s read and its claim leaves the first one sending nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-pause-race-'));
    const a = box(dir);
    const c = box(dir);
    plan(a, 'p', { by: 'h@x.ch' });
    writePause(a.db, 'p', [{ mandateId: 'g', email: 'h@x.ch', reason: 'expired', endsAt: NOW - H, roles: ['created'], closedPrompt: false }], NOW);
    let fromC: ReturnType<typeof claimPauseNotices> = [];
    // A has read the pending rows; before its claim is prepared, C claims and sends.
    const raced = new Proxy(a.db, {
      get(target, key, receiver) {
        if (key !== 'prepare') return Reflect.get(target, key, receiver) as unknown;
        return (sql: string) => {
          if (sql.startsWith('UPDATE triggers SET pause_noticed_at')) fromC = claimPauseNotices(c.db, NOW);
          return target.prepare(sql);
        };
      },
    });
    const fromA = claimPauseNotices(raced, NOW);
    expect(fromC).toHaveLength(1);
    expect(fromA).toEqual([]);
  });
});

describe('the briefing', () => {
  it('says a paused plan is paused, not when it runs next', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    b.db.prepare('UPDATE triggers SET paused_at = 1 WHERE id = ?').run('p');
    const text = b.manager.getBriefingSummary();
    expect(text).toContain('paused until the owner takes it over');
    expect(text).not.toContain(`next run ${DUE}`);
  });
});
