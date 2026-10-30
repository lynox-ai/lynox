import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { MandateEnds } from './mandate-ends.js';
import { AuditLog } from './audit-log.js';
import { TriggerStore } from './trigger-store.js';
import { WorkflowStore } from './workflow-store.js';
import {
  ACCESS_ENDED_PAUSED_RESULT, PLAN_ENDED_RESULT, pauseEndedPlans, setPlanPauseForTests, writePause, type PausedFor,
} from './plan-pause.js';
import { TAKEOVER_DIGEST_PREFIX, takeOver, takeoverPreview, type TakeoverDeps, type TakeoverPrompts } from './plan-takeover.js';
import { stampExpect } from './plan-stamp.js';
import { creatorCovered, editorCovered, planAuthorshipOf, planAuthorshipOfWorkflow, planMandate } from './request-principal.js';
import { savedWorkflowSource } from '../orchestrator/run-source.js';
import { planOfTrigger } from './plan-stamp.js';
import { _resetPipelineStore } from '../tools/builtin/pipeline.js';
import { TaskManager } from './task-manager.js';

/**
 * The owner's takeover of a paused plan (`plan-takeover.ts`) on a real engine.db: which marks it
 * covers, what it releases, what it is held to, and what it writes. The worker's side — that the
 * plan then runs for the owner — is in `plan-takeover-worker.test.ts`.
 */

const H = 3600;
const nowS = (): number => Math.floor(Date.now() / 1000);
const PAST = '2026-01-05T09:00:00.000Z';

const dirs: string[] = [];
const closers: Array<() => void> = [];
let restore: () => void = () => undefined;

beforeEach(() => { restore = setPlanPauseForTests(true); _resetPipelineStore(); });
afterEach(() => {
  restore();
  vi.restoreAllMocks();
  for (const c of closers.splice(0).reverse()) c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Box {
  history: RunHistory;
  db: ReturnType<EngineDb['getDb']>;
  triggers: TriggerStore;
  workflows: WorkflowStore;
  ends: MandateEnds;
  audit: AuditLog;
  prompts: TakeoverPrompts & { calls: string[]; answered: Map<string, string[]> };
}

function box(): Box {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-takeover-'));
  dirs.push(dir);
  const history = new RunHistory(join(dir, 'history.db'));
  const engineDb = new EngineDb(join(dir, 'engine.db'));
  history.setVerbGraph(engineDb);
  closers.push(() => { try { history.close(); } catch { /* twice is fine */ } });
  closers.push(() => { try { engineDb.close(); } catch { /* twice is fine */ } });
  const answered = new Map<string, string[]>();
  const calls: string[] = [];
  const prompts = {
    calls, answered,
    expirePendingForTrigger: (id: string): number => { calls.push(`expire ${id}`); return 0; },
    getAnsweredForTrigger: (id: string): { id: string } | undefined => {
      const list = answered.get(id) ?? [];
      return list.length > 0 ? { id: list[0]! } : undefined;
    },
    releaseTrigger: (promptId: string): boolean => {
      calls.push(`release ${promptId}`);
      for (const [k, list] of answered) answered.set(k, list.filter((p) => p !== promptId));
      return true;
    },
  };
  return {
    history, db: engineDb.getDb(), triggers: new TriggerStore(engineDb), workflows: new WorkflowStore(engineDb),
    ends: new MandateEnds(engineDb.getDb()), audit: new AuditLog(engineDb.getDb()), prompts,
  };
}

const deps = (b: Box, over: Partial<TakeoverDeps> = {}): TakeoverDeps => ({
  db: b.db, triggers: b.triggers, isLive: (id) => b.ends.isLive(id), audit: b.audit, prompts: b.prompts, ...over,
});

const tag = (email: string): string => `mandate:${email}`;

/** Ends a mandate's access (an end an hour ago), or extends it (an end an hour ahead, signed later). */
function ended(b: Box, email: string, grant = `g-${email}`): void {
  b.ends.record({ kind: 'mandate', email, mandateId: grant, mandateExp: nowS() - H }, nowS() - 2 * H);
}
function renewed(b: Box, email: string, grant = `g-${email}`): void {
  b.ends.record({ kind: 'mandate', email, mandateId: grant, mandateExp: nowS() + H }, nowS() - 10);
}

/** A stamped weekly plan, by a mandate when `by` is given, else the owner's. */
function plan(b: Box, id: string, over: {
  by?: string; grant?: string | null; effect?: 'run_agent' | 'run_workflow' | 'notify' | 'bulk_apply';
  workflow?: string; once?: boolean; nextRunAt?: string; source?: 'cron' | 'watch';
} = {}): string {
  b.history.insertTrigger({
    id, title: `Plan ${id}`, source: over.source ?? 'cron', effect: over.effect ?? 'run_agent',
    ...(over.once === true || over.source === 'watch' ? {} : { scheduleCron: '0 9 * * 1' }), nextRunAt: over.nextRunAt ?? PAST,
    ...(over.source === 'watch' ? { watchConfig: JSON.stringify({ url: 'https://example.invalid' }) } : {}),
    confirmedAt: '2026-01-01T00:00:00.000Z', confirmedBy: 'owner',
    ...(over.by !== undefined ? { createdBy: tag(over.by), ...(over.grant !== null ? { createdMandateId: over.grant ?? `g-${over.by}` } : {}) } : {}),
    ...(over.workflow !== undefined ? { pipelineId: over.workflow } : {}),
  });
  return id;
}

function editor(b: Box, table: 'triggers' | 'workflows', id: string, email: string, grant: string | null = `g-${email}`, at: string | null = '2026-02-01 10:00:00'): void {
  b.db.prepare(`UPDATE ${table} SET mandate_editor = ?, mandate_editor_id = ?, mandate_edited_at = ? WHERE id = ?`).run(tag(email), grant, at, id);
}

function workflow(b: Box, id: string, by?: { email: string; grant?: string | null }): string {
  // Created well before any pause in these cases: a mark in the pause's second counts as after it.
  b.db.prepare("INSERT INTO workflows (id, name, definition_json, created_by, created_mandate_id, created_at) VALUES (?, 'W', ?, ?, ?, '2026-01-01 00:00:00')")
    .run(id, JSON.stringify({ id, name: 'W', steps: [] }), by ? tag(by.email) : null, by === undefined ? null : (by.grant === undefined ? `g-${by.email}` : by.grant));
  return id;
}

/** Pauses a plan for these mandates, as the sweep writes it. */
function pause(b: Box, id: string, ...emails: string[]): void {
  const entries: PausedFor[] = emails.map((e) => ({ mandateId: `g-${e}`, email: e, reason: 'expired', endsAt: nowS() - H, roles: ['created'], closedPrompt: false }));
  writePause(b.db, id, entries);
}

function row(b: Box, id: string): Record<string, unknown> {
  return b.db.prepare('SELECT * FROM triggers WHERE id = ?').get(id) as Record<string, unknown>;
}

/** Takes the plan over from a fresh preview. */
function take(b: Box, id: string, d: TakeoverDeps = deps(b)): ReturnType<typeof takeOver> {
  const p = takeoverPreview(d, id);
  if (p.kind !== 'preview') throw new Error(`no preview: ${JSON.stringify(p)}`);
  return takeOver(d, id, p.preview.expect);
}

const memberOf = (b: Box, id: string): string | undefined => {
  const t = b.triggers.getById(id)!;
  return planMandate(planAuthorshipOf(t))?.principal.email;
};

describe('the preview says whose a stamped connection is', () => {
  it('by the address of the grant the plan was paused for; a grant it does not know, as nobody', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    const { confirmed_at: at, paused_for: pf } = row(b, 'p') as { confirmed_at: string; paused_for: string };
    const grant = (JSON.parse(pf) as Array<{ mandateId: string }>)[0]!.mandateId;
    b.db.prepare('UPDATE triggers SET stamp_connections = ? WHERE id = ?').run(JSON.stringify({
      at, wf: null, entries: [{ profile: 'pr-1', grant, binding: 'b' }, { profile: 'pr-2', grant: 'g-unknown', binding: 'b' }],
    }), 'p');
    const p = takeoverPreview(deps(b), 'p');
    expect(p.kind === 'preview' && [p.preview.connections.map((c) => c.profile), p.preview.connectionBy]).toEqual([['pr-1', 'pr-2'], ['h@x.ch', null]]);
  });
});

describe('a paused plan taken over has no mandate member and is the owner’s', () => {
  it('covers the trigger’s marks, clears the pause, stamps it for the owner and records it', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    editor(b, 'triggers', 'p', 'h@x.ch');
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    b.db.prepare("UPDATE triggers SET stamp_connections = 'mandate-list' WHERE id = 'p'").run();
    const out = take(b, 'p');
    expect(out.kind).toBe('taken_over');
    expect(memberOf(b, 'p')).toBeUndefined();
    const r = row(b, 'p');
    expect([r['paused_at'], r['paused_for'], r['confirmed_by'], r['edited_by'], r['stamp_connections']]).toEqual([null, null, 'owner', 'owner', null]);
    // The marks stay: they are where the plan came from.
    expect([r['created_by'], r['mandate_editor']]).toEqual([tag('h@x.ch'), tag('h@x.ch')]);
    expect(b.db.prepare("SELECT actor_kind, target FROM audit_log WHERE action = 'plan.takeover'").all())
      .toEqual([{ actor_kind: 'owner', target: 'trigger=p mandates=g-h@x.ch' }]);
  });

  it('a mark with no time (from before the column) is covered whole, the null compared as a value', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    editor(b, 'triggers', 'p', 'h@x.ch', 'g-h@x.ch', null);
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    take(b, 'p');
    const a = planAuthorshipOf(b.triggers.getById('p')!);
    expect([editorCovered(a), creatorCovered(a), planMandate(a)]).toEqual([true, true, undefined]);
  });

  it('covers both marks of a side: an editor that ended and a creator that is live are both taken over', () => {
    const b = box();
    plan(b, 'p', { by: 'a@x.ch' });
    editor(b, 'triggers', 'p', 'e@x.ch');
    renewed(b, 'a@x.ch');
    ended(b, 'e@x.ch');
    pause(b, 'p', 'e@x.ch');
    take(b, 'p');
    // Covering only the editor would hand the plan to its creator, who was no member before.
    expect(memberOf(b, 'p')).toBeUndefined();
  });

  it('a later change by a mandate is a new mark, not covered, even in the same second, and the plan depends on it again', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    b.db.prepare("UPDATE triggers SET mandate_editor = ?, mandate_editor_id = 'g-h@x.ch', mandate_edited_at = datetime('now') WHERE id = 'p'").run(tag('h@x.ch'));
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    take(b, 'p');
    b.triggers.markEditedBy('p', { kind: 'mandate', email: 'h@x.ch', mandateId: 'g-h@x.ch' }, true);
    const r = row(b, 'p');
    expect([r['covered_edited_by'], r['covered_edited_id'], r['covered_edited_at']]).toEqual([null, null, null]);
    expect(memberOf(b, 'p')).toBe('h@x.ch');
  });

  it('the pause sweep reads the cover as the gate does: a plan taken over is not paused again', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    take(b, 'p');
    expect(pauseEndedPlans({ db: b.db, endOf: (id) => b.ends.endRow(id) }).paused).toEqual([]);
    expect(row(b, 'p')['paused_at']).toBeNull();
  });
});

describe('the workflow’s side', () => {
  const setup = (b: Box): void => {
    workflow(b, 'w', { email: 'h@x.ch' });
    plan(b, 'p', { by: 'h@x.ch', effect: 'run_workflow', workflow: 'w' });
  };

  it('a member whose end is proven is covered: the plan then runs for the owner', () => {
    const b = box();
    setup(b);
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    const p = takeoverPreview(deps(b), 'p');
    expect(p.kind === 'preview' && [p.preview.runsAs, p.preview.workflow]).toEqual(['owner', { id: 'w', name: 'W', takenOver: true }]);
    take(b, 'p');
    expect(planMandate(planAuthorshipOfWorkflow(b.workflows.authorship('w')!))).toBeUndefined();
  });

  it('a renewal: the member the plan was paused for is live again and is still covered', () => {
    const b = box();
    setup(b);
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    renewed(b, 'h@x.ch');
    expect(b.ends.isLive('g-h@x.ch')).toBe(true);
    const out = take(b, 'p');
    expect(out.kind === 'taken_over' && out.runsAs).toBe('owner');
    expect(planMandate(planAuthorshipOfWorkflow(b.workflows.authorship('w')!))).toBeUndefined();
  });

  it('a live member that changed the workflow after the pause stays, and the plan runs as that member', () => {
    const b = box();
    setup(b);
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    editor(b, 'workflows', 'w', 'm2@x.ch');
    renewed(b, 'm2@x.ch');
    const out = take(b, 'p');
    expect(out.kind === 'taken_over' && out.runsAs).toBe(tag('m2@x.ch'));
    // The workflow's creator is the one the plan was paused for; only the current member decides.
    expect(planMandate(planAuthorshipOfWorkflow(b.workflows.authorship('w')!))?.principal.email).toBe('m2@x.ch');
  });

  it('a renewed member that changed the workflow after the pause is not covered: the plan runs as that member', () => {
    const b = box();
    setup(b);
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    renewed(b, 'h@x.ch');
    b.db.prepare("UPDATE workflows SET mandate_editor = ?, mandate_editor_id = 'g-h@x.ch', mandate_edited_at = datetime('now', '+1 minute') WHERE id = 'w'").run(tag('h@x.ch'));
    const p = takeoverPreview(deps(b), 'p');
    if (p.kind !== 'preview') throw new Error('no preview');
    expect([p.preview.runsAs, p.preview.workflow?.takenOver]).toEqual([tag('h@x.ch'), false]);
    // Its grant is live again: the preview says so.
    expect(p.preview.members).toEqual([{ name: 'h@x.ch', roles: ['created'], ended: false, reason: null }]);
    takeOver(deps(b), 'p', p.preview.expect);
    expect(planMandate(planAuthorshipOfWorkflow(b.workflows.authorship('w')!))?.principal.email).toBe('h@x.ch');
  });

  it('the pause is compared in the database’s clock: a process clock far off does not change the decision', () => {
    for (const shift of [-10 * 365 * 86_400, 10 * 365 * 86_400]) {
      const b = box();
      setup(b);
      ended(b, 'h@x.ch');
      writePause(b.db, 'p', [{ mandateId: 'g-h@x.ch', email: 'h@x.ch', reason: 'expired', endsAt: nowS() - H, roles: ['created'], closedPrompt: false }], nowS() + shift);
      renewed(b, 'h@x.ch');
      const before = takeoverPreview(deps(b), 'p');
      b.db.prepare("UPDATE workflows SET mandate_editor = ?, mandate_editor_id = 'g-h@x.ch', mandate_edited_at = datetime('now', '+1 minute') WHERE id = 'w'").run(tag('h@x.ch'));
      const after = takeoverPreview(deps(b), 'p');
      expect([shift, before.kind === 'preview' && before.preview.runsAs, after.kind === 'preview' && after.preview.runsAs])
        .toEqual([shift, 'owner', tag('h@x.ch')]);
    }
  });

  it('a member whose end is proven is covered whatever its mark’s age: a change in the pause’s second, and a renewal that changed and ended again', () => {
    for (const shape of ['same second', 'ended again'] as const) {
      const b = box();
      setup(b);
      ended(b, 'h@x.ch');
      pause(b, 'p', 'h@x.ch');
      if (shape === 'ended again') renewed(b, 'h@x.ch');
      const at = (b.db.prepare('SELECT paused_db_at AS s FROM triggers WHERE id = ?').get('p') as { s: number }).s;
      b.db.prepare("UPDATE workflows SET mandate_editor = ?, mandate_editor_id = 'g-h@x.ch', mandate_edited_at = datetime(?, 'unixepoch', ?) WHERE id = 'w'")
        .run(tag('h@x.ch'), at, shape === 'same second' ? '+0 seconds' : '+1 minute');
      if (shape === 'ended again') b.ends.record({ kind: 'mandate', email: 'h@x.ch', mandateId: 'g-h@x.ch', mandateExp: nowS() - 1 }, nowS());
      expect(b.ends.isLive('g-h@x.ch')).toBe(false);
      const out = take(b, 'p');
      expect([shape, out.kind === 'taken_over' && out.runsAs]).toEqual([shape, 'owner']);
    }
  });

  it('every mandate whose mark it covers is named, also one that cannot be told live', () => {
    const b = box();
    workflow(b, 'w', { email: 'z@x.ch', grant: null });
    plan(b, 'p', { by: 'h@x.ch', effect: 'run_workflow', workflow: 'w' });
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    const p = takeoverPreview(deps(b), 'p');
    expect(p.kind === 'preview' && p.preview.members).toEqual([
      { name: 'h@x.ch', roles: ['created'], ended: true, reason: 'expired' },
      { name: 'z@x.ch', roles: ['workflow-created'], ended: true, reason: null },
    ]);
  });

  it('a renewed member’s change in the pause’s own second counts as after it: not covered', () => {
    const b = box();
    setup(b);
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    renewed(b, 'h@x.ch');
    const at = (b.db.prepare('SELECT paused_db_at AS s FROM triggers WHERE id = ?').get('p') as { s: number }).s;
    b.db.prepare("UPDATE workflows SET mandate_editor = ?, mandate_editor_id = 'g-h@x.ch', mandate_edited_at = datetime(?, 'unixepoch') WHERE id = 'w'").run(tag('h@x.ch'), at);
    const out = take(b, 'p');
    expect(out.kind === 'taken_over' && out.runsAs).toBe(tag('h@x.ch'));
  });

  it('a pause without the database’s time covers no live member: the plan runs as the renewed one', () => {
    const b = box();
    setup(b);
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    renewed(b, 'h@x.ch');
    b.db.prepare("UPDATE triggers SET paused_db_at = NULL WHERE id = 'p'").run();
    const out = take(b, 'p');
    expect(out.kind === 'taken_over' && out.runsAs).toBe(tag('h@x.ch'));
  });

  it('the member that stays is named, as live', () => {
    const b = box();
    workflow(b, 'w', { email: 'z@x.ch' });
    renewed(b, 'z@x.ch');
    plan(b, 'p', { by: 'h@x.ch', effect: 'run_workflow', workflow: 'w' });
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    const p = takeoverPreview(deps(b), 'p');
    if (p.kind !== 'preview') throw new Error('no preview');
    expect(p.preview.runsAs).toBe(tag('z@x.ch'));
    expect(p.preview.members).toEqual([
      { name: 'h@x.ch', roles: ['created'], ended: true, reason: 'expired' },
      { name: 'z@x.ch', roles: ['workflow-created'], ended: false, reason: null },
    ]);
  });

  it('the stamp list’s reader sees the cover too (`planOfTrigger`)', async () => {
    const b = box();
    setup(b);
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    take(b, 'p');
    const plan0 = await planOfTrigger(b.triggers.getById('p')!, b.history);
    expect([plan0.members, plan0.unreadable]).toEqual([[], false]);
  });

  it('a member that cannot be told live — no grant id, or no recorded end — is covered', () => {
    for (const shape of ['no grant', 'no end'] as const) {
      const b = box();
      workflow(b, 'w', { email: 'z@x.ch', grant: shape === 'no grant' ? null : 'g-z@x.ch' });
      plan(b, 'p', { by: 'h@x.ch', effect: 'run_workflow', workflow: 'w' });
      ended(b, 'h@x.ch');
      pause(b, 'p', 'h@x.ch');
      const out = take(b, 'p');
      expect([shape, out.kind === 'taken_over' && out.runsAs]).toEqual([shape, 'owner']);
    }
  });

  it('the chat’s run of the saved workflow reads the cover too (`run-source.ts`)', () => {
    const b = box();
    setup(b);
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    take(b, 'p');
    const src = savedWorkflowSource('w', (id) => b.workflows.authorship(id), b.ends);
    expect(src.kind === 'saved' && src.authors).toEqual([]);
  });

  it('a copy of a workflow taken over carries the cover with the mark it copies, from the editor or else the creator', () => {
    for (const from of ['editor', 'creator'] as const) {
      const b = box();
      setup(b);
      if (from === 'editor') editor(b, 'workflows', 'w', 'h@x.ch');
      ended(b, 'h@x.ch');
      pause(b, 'p', 'h@x.ch');
      take(b, 'p');
      b.workflows.upsertCopy({ id: 'w-copy', name: 'W copy', definitionJson: '{"steps":[]}' }, { kind: 'mandate', email: 'm2@x.ch', mandateId: 'g-m2@x.ch' }, 'w');
      expect([from, planMandate(planAuthorshipOfWorkflow(b.workflows.authorship('w-copy')!))?.principal.email]).toEqual([from, 'm2@x.ch']);
    }
  });
});

describe('the other plans on the workflow', () => {
  it('lists every plan whose members change, releases a paused one no member holds, and leaves the mandate’s own paused', () => {
    const b = box();
    workflow(b, 'w', { email: 'h@x.ch' });
    plan(b, 'p', { by: 'h@x.ch', effect: 'run_workflow', workflow: 'w' });
    plan(b, 'owners-paused', { effect: 'run_workflow', workflow: 'w' });
    plan(b, 'owners-live', { effect: 'run_workflow', workflow: 'w' });
    plan(b, 'mandates-own', { by: 'h@x.ch', effect: 'run_workflow', workflow: 'w' });
    plan(b, 'owners-stopped', { effect: 'run_workflow', workflow: 'w', once: true });
    ended(b, 'h@x.ch');
    for (const id of ['p', 'owners-paused', 'mandates-own']) pause(b, id, 'h@x.ch');
    b.db.prepare("UPDATE triggers SET status = 'stopped', last_run_status = 'stopped', last_run_result = ? WHERE id = 'owners-paused'").run(PLAN_ENDED_RESULT);
    b.db.prepare("UPDATE triggers SET status = 'stopped', next_run_at = NULL WHERE id = 'owners-stopped'").run();
    const p = takeoverPreview(deps(b), 'p');
    if (p.kind !== 'preview') throw new Error('no preview');
    expect(p.preview.memberChanges.map((c) => [c.id, c.before, c.after, c.runsNoMore])).toEqual([
      ['owners-live', tag('h@x.ch'), null, false],
      ['owners-paused', tag('h@x.ch'), null, false],
      ['owners-stopped', tag('h@x.ch'), null, true],
    ]);
    expect(p.preview.alsoReleased).toEqual([{ id: 'owners-paused', title: 'Plan owners-paused' }]);
    takeOver(deps(b), 'p', p.preview.expect);
    const released = row(b, 'owners-paused');
    // Released with the same steps as the plan taken over: a stopped plan would never run again.
    expect([released['paused_at'], released['status'], (released['next_run_at'] as string) > new Date().toISOString()]).toEqual([null, 'open', true]);
    // Released, not taken over: no stamp of its own is written.
    expect(released['confirmed_by']).toBe('owner');
    expect(released['covered_created_by']).toBeNull();
    expect(row(b, 'mandates-own')['paused_at']).not.toBeNull();
  });

  it('after a renewal, a plan the renewed member still holds stays paused', () => {
    const b = box();
    workflow(b, 'w', { email: 'h@x.ch' });
    plan(b, 'p1', { effect: 'run_workflow', workflow: 'w' });
    // p2's own schedule is m3's, set up before the pause; m3 ended with h, and both were renewed.
    plan(b, 'p2', { by: 'm3@x.ch', effect: 'run_workflow', workflow: 'w' });
    b.db.prepare("UPDATE triggers SET created_at = '2026-01-01 00:00:00' WHERE id = 'p2'").run();
    ended(b, 'h@x.ch');
    ended(b, 'm3@x.ch');
    pause(b, 'p1', 'h@x.ch');
    pause(b, 'p2', 'h@x.ch', 'm3@x.ch');
    renewed(b, 'h@x.ch');
    renewed(b, 'm3@x.ch');
    const p = takeoverPreview(deps(b), 'p1');
    expect(p.kind === 'preview' && p.preview.alsoReleased).toEqual([]);
    take(b, 'p1');
    // The member is live, but it is one p2 was paused for: p2 waits for its own takeover.
    expect(row(b, 'p2')['paused_at']).not.toBeNull();
  });

  it('a plan it would release whose run still holds its lease refuses the takeover as running', () => {
    const b = box();
    workflow(b, 'w', { email: 'h@x.ch' });
    plan(b, 'p', { by: 'h@x.ch', effect: 'run_workflow', workflow: 'w' });
    plan(b, 'o', { effect: 'run_workflow', workflow: 'w', once: true });
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    pause(b, 'o', 'h@x.ch');
    b.db.prepare("UPDATE triggers SET lease_holder = 'other', lease_until = ? WHERE id = 'o'").run(new Date(Date.now() + 60_000).toISOString());
    expect(takeoverPreview(deps(b), 'p')).toEqual({ kind: 'refused', refusal: 'running' });
    expect(row(b, 'o')['paused_at']).not.toBeNull();
  });

  it('a plan whose workflow member stays changes nothing for the others', () => {
    const b = box();
    workflow(b, 'w', { email: 'm2@x.ch' });
    renewed(b, 'm2@x.ch');
    plan(b, 'p', { by: 'h@x.ch', effect: 'run_workflow', workflow: 'w' });
    plan(b, 'other', { effect: 'run_workflow', workflow: 'w' });
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    const p = takeoverPreview(deps(b), 'p');
    expect(p.kind === 'preview' && [p.preview.memberChanges, p.preview.alsoReleased, p.preview.runsAs]).toEqual([[], [], tag('m2@x.ch')]);
  });
});

describe('what the takeover is held to', () => {
  const ready = (b: Box): string => {
    workflow(b, 'w', { email: 'h@x.ch' });
    plan(b, 'p', { by: 'h@x.ch', effect: 'run_workflow', workflow: 'w' });
    plan(b, 'other', { effect: 'run_workflow', workflow: 'w' });
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    const p = takeoverPreview(deps(b), 'p');
    if (p.kind !== 'preview') throw new Error('no preview');
    return p.preview.expect;
  };

  it('a change to the workflow’s steps after the preview refuses it, and nothing is written', () => {
    const b = box();
    const expect0 = ready(b);
    b.db.prepare("UPDATE workflows SET definition_json = '{\"steps\":[1]}' WHERE id = 'w'").run();
    expect(takeOver(deps(b), 'p', expect0)).toEqual({ kind: 'refused', refusal: 'changed' });
    expect(row(b, 'p')['paused_at']).not.toBeNull();
    expect(b.prompts.calls).toEqual([]);
  });

  it('a change that lands while the questions are closed is caught inside the transaction', () => {
    const b = box();
    const expect0 = ready(b);
    const racing = { ...b.prompts, expirePendingForTrigger: (id: string): number => {
      b.db.prepare("UPDATE workflows SET definition_json = '{\"steps\":[9]}' WHERE id = 'w'").run();
      return b.prompts.expirePendingForTrigger(id);
    } };
    expect(takeOver(deps(b, { prompts: racing }), 'p', expect0)).toEqual({ kind: 'refused', refusal: 'changed' });
    expect(row(b, 'p')['paused_at']).not.toBeNull();
  });

  it('a change to another plan it lists refuses it', () => {
    const b = box();
    const expect0 = ready(b);
    b.db.prepare("UPDATE triggers SET title = 'Renamed' WHERE id = 'other'").run();
    expect(takeOver(deps(b), 'p', expect0)).toEqual({ kind: 'refused', refusal: 'changed' });
  });

  it('its digest is its own: the stamp digest of the same plan does not pass', () => {
    const b = box();
    const expect0 = ready(b);
    const stamp = stampExpect(b.triggers.getById('p')!, null, []);
    expect(stamp).not.toBe(expect0);
    expect(takeOver(deps(b), 'p', stamp)).toEqual({ kind: 'refused', refusal: 'changed' });
    expect(TAKEOVER_DIGEST_PREFIX).toBe('lynox:plan-takeover:v1');
  });
});

describe('what it refuses', () => {
  it('with the pause off, everything is not_available', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    pause(b, 'p', 'h@x.ch');
    restore();
    restore = setPlanPauseForTests(false);
    expect([takeoverPreview(deps(b), 'p'), takeOver(deps(b), 'p', 'x')]).toEqual([
      { kind: 'refused', refusal: 'not_available' }, { kind: 'refused', refusal: 'not_available' },
    ]);
  });

  it('a plan that is not paused — stamped or not — has nothing to take over, and gets no stamp', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    b.db.prepare("UPDATE triggers SET confirmed_at = NULL, confirmed_by = NULL WHERE id = 'p'").run();
    expect(takeoverPreview(deps(b), 'p')).toEqual({ kind: 'refused', refusal: 'nothing_to_take_over' });
    expect(row(b, 'p')['confirmed_at']).toBeNull();
    expect(b.prompts.calls).toEqual([]);
  });

  it('a paused plan that was completed has nothing to take over', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    pause(b, 'p', 'h@x.ch');
    b.db.prepare("UPDATE triggers SET status = 'completed' WHERE id = 'p'").run();
    expect(takeoverPreview(deps(b), 'p')).toEqual({ kind: 'refused', refusal: 'nothing_to_take_over' });
  });

  it('a bulk run is refused as bulk, before its pause is read', () => {
    const b = box();
    plan(b, 'p', { effect: 'bulk_apply' });
    expect(takeoverPreview(deps(b), 'p')).toEqual({ kind: 'refused', refusal: 'bulk' });
  });

  it('a workflow whose authorship cannot be read is unreadable, and the plan stays paused', () => {
    const b = box();
    workflow(b, 'w', { email: 'h@x.ch' });
    plan(b, 'p', { by: 'h@x.ch', effect: 'run_workflow', workflow: 'w' });
    pause(b, 'p', 'h@x.ch');
    b.db.exec('ALTER TABLE workflows RENAME COLUMN mandate_edited_at TO gone');
    expect(takeoverPreview(deps(b), 'p')).toEqual({ kind: 'refused', refusal: 'unreadable' });
    expect(takeOver(deps(b), 'p', 'x')).toEqual({ kind: 'refused', refusal: 'unreadable' });
    b.db.exec('ALTER TABLE workflows RENAME COLUMN gone TO mandate_edited_at');
    expect(row(b, 'p')['paused_at']).not.toBeNull();
  });

  it('a run that holds its lease is running; a lapsed lease is cleared, so the next claim is not an interruption', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    const later = new Date(Date.now() + 60_000).toISOString();
    b.db.prepare("UPDATE triggers SET lease_holder = 'other', lease_until = ?, lease_since = ? WHERE id = 'p'").run(later, PAST);
    expect(takeoverPreview(deps(b), 'p')).toEqual({ kind: 'refused', refusal: 'running' });
    b.db.prepare("UPDATE triggers SET lease_until = ? WHERE id = 'p'").run(PAST);
    expect(take(b, 'p').kind).toBe('taken_over');
    expect([row(b, 'p')['lease_holder'], row(b, 'p')['lease_until']]).toEqual([null, null]);
    expect(b.triggers.claimLease('p', 'me', later, new Date().toISOString())).toBe('claimed');
  });

  it('an audit row that cannot be written rolls everything back', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    vi.spyOn(b.audit, 'record').mockImplementation(() => { throw new Error('disk I/O error'); });
    const before = row(b, 'p');
    expect(take(b, 'p')).toEqual({ kind: 'refused', refusal: 'unrecorded' });
    expect(row(b, 'p')).toEqual(before);
  });

  it('a question that cannot be closed refuses it before engine.db is written', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    const before = row(b, 'p');
    const broken = { ...b.prompts, expirePendingForTrigger: (): number => { throw new Error('SQLITE_BUSY'); } };
    expect(take(b, 'p', deps(b, { prompts: broken }))).toEqual({ kind: 'refused', refusal: 'prompts' });
    expect(row(b, 'p')).toEqual(before);
  });
});

describe('its questions, its status and its next run', () => {
  it('settles the open question and detaches every answer, of the plan and of a plan it releases', () => {
    const b = box();
    workflow(b, 'w', { email: 'h@x.ch' });
    plan(b, 'p', { by: 'h@x.ch', effect: 'run_workflow', workflow: 'w' });
    plan(b, 'o', { effect: 'run_workflow', workflow: 'w' });
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    pause(b, 'o', 'h@x.ch');
    b.prompts.answered.set('p', ['q1', 'q2']);
    b.prompts.answered.set('o', ['q3']);
    take(b, 'p');
    expect(b.prompts.calls).toEqual(['expire p', 'release q1', 'release q2', 'expire o', 'release q3']);
  });

  it('a plan still waiting ends its wait once, through the store’s own end of a wait', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    b.db.prepare("UPDATE triggers SET status = 'waiting', waiting_until = ? WHERE id = 'p'").run(PAST);
    const spy = vi.spyOn(b.triggers, 'endWait');
    take(b, 'p');
    expect(spy.mock.calls).toEqual([['p', 'open']]);
    expect([row(b, 'p')['status'], row(b, 'p')['waiting_until']]).toEqual(['open', null]);
  });

  it('a cron plan runs at its next occurrence from now; the missed runs are not made up', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    const p = takeoverPreview(deps(b), 'p');
    expect(p.kind === 'preview' && p.preview.schedule).toBe('next_cron');
    take(b, 'p');
    expect((row(b, 'p')['next_run_at'] as string) > new Date().toISOString()).toBe(true);
  });

  it('a one-shot whose time passed, or that stopped part-way, runs only on Run now; one due later keeps its time', () => {
    const cases = [
      { name: 'missed', next: PAST, stop: false, schedule: 'run_now_only_missed', after: null },
      { name: 'partial', next: PAST, stop: true, schedule: 'run_now_only_partial', after: null },
      { name: 'later', next: '2099-01-01T00:00:00.000Z', stop: false, schedule: 'kept', after: '2099-01-01T00:00:00.000Z' },
    ];
    for (const c of cases) {
      const b = box();
      plan(b, 'p', { by: 'h@x.ch', once: true, nextRunAt: c.next });
      ended(b, 'h@x.ch');
      pause(b, 'p', 'h@x.ch');
      if (c.stop) b.db.prepare("UPDATE triggers SET status = 'stopped', last_run_status = 'stopped', last_run_result = ? WHERE id = 'p'").run(ACCESS_ENDED_PAUSED_RESULT);
      const p = takeoverPreview(deps(b), 'p');
      expect([c.name, p.kind === 'preview' && p.preview.schedule]).toEqual([c.name, c.schedule]);
      // The date the run was due, for T-6 in the view; none where the plan keeps its time.
      expect([c.name, p.kind === 'preview' && p.preview.dueAt]).toEqual([c.name, c.after === null ? c.next : null]);
      take(b, 'p');
      expect([c.name, row(b, 'p')['next_run_at'], row(b, 'p')['status']]).toEqual([c.name, c.after, 'open']);
    }
  });

  it('a watch keeps its next check', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch', source: 'watch' });
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    take(b, 'p');
    expect(row(b, 'p')['next_run_at']).toBe(PAST);
  });
});

describe('a mandate’s change to a workflow taken over', () => {
  it('a save or a rename by a mandate is a new mark, not covered: the workflow has that member again', () => {
    for (const how of ['save', 'rename'] as const) {
      const b = box();
      workflow(b, 'w', { email: 'h@x.ch' });
      plan(b, 'p', { by: 'h@x.ch', effect: 'run_workflow', workflow: 'w' });
      b.db.prepare("UPDATE workflows SET mandate_editor = ?, mandate_editor_id = 'g-h@x.ch', mandate_edited_at = datetime('now') WHERE id = 'w'").run(tag('h@x.ch'));
      ended(b, 'h@x.ch');
      pause(b, 'p', 'h@x.ch');
      take(b, 'p');
      const m = { kind: 'mandate' as const, email: 'h@x.ch', mandateId: 'g-h@x.ch' };
      if (how === 'save') b.workflows.upsert({ id: 'w', name: 'W', definitionJson: '{"steps":[2]}' }, m);
      else b.workflows.rename('w', 'W renamed', m);
      const r = b.db.prepare('SELECT covered_edited_by, covered_edited_id, covered_edited_at FROM workflows WHERE id = ?').get('w');
      expect([how, r]).toEqual([how, { covered_edited_by: null, covered_edited_id: null, covered_edited_at: null }]);
      expect([how, planMandate(planAuthorshipOfWorkflow(b.workflows.authorship('w')!))?.principal.email]).toEqual([how, 'h@x.ch']);
    }
  });
});

describe('no other write touches the cover', () => {
  it('the owner’s and the engine’s own writes leave every covered column as the takeover wrote it', () => {
    const b = box();
    workflow(b, 'w', { email: 'h@x.ch' });
    plan(b, 'p', { by: 'h@x.ch', effect: 'run_workflow', workflow: 'w' });
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    take(b, 'p');
    const cover = (): unknown => [
      b.db.prepare('SELECT covered_created_by, covered_created_id, covered_created_at, covered_edited_by, covered_edited_id, covered_edited_at, covered_at FROM triggers WHERE id = ?').get('p'),
      b.db.prepare('SELECT covered_created_by, covered_created_id, covered_created_at, covered_edited_by, covered_edited_id, covered_edited_at, covered_at FROM workflows WHERE id = ?').get('w'),
    ];
    const before = cover();
    b.triggers.updateFields('p', { title: 'Renamed' });
    b.triggers.updateRunResult('p', { lastRunAt: PAST, lastRunResult: 'ok', lastRunStatus: 'success', nextRunAt: PAST, retryCount: 0 });
    b.triggers.setEnabled('p', false);
    b.triggers.setConfirmedAt('p', '2026-03-01T00:00:00.000Z', 'owner');
    b.triggers.markEditedBy('p', { kind: 'owner' }, false);
    b.workflows.upsert({ id: 'w', name: 'W2', definitionJson: '{"steps":[]}' }, { kind: 'owner' });
    b.workflows.rename('w', 'W3', { kind: 'owner' });
    const tasks = new TaskManager(b.history);
    tasks.complete('p');
    tasks.reopen('p');
    b.workflows.upsertCopy({ id: 'w-copy', name: 'W copy', definitionJson: '{"steps":[]}' }, { kind: 'owner' }, 'w');
    expect(cover()).toEqual(before);
    expect(memberOf(b, 'p')).toBeUndefined();
  });

  it('the same writes leave a paused plan paused, with who it was paused for', () => {
    const b = box();
    plan(b, 'p', { by: 'h@x.ch' });
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    const pauseOf = (): unknown => b.db.prepare('SELECT paused_at, paused_db_at, paused_due_at, paused_for FROM triggers WHERE id = ?').get('p');
    const before = pauseOf();
    b.triggers.updateFields('p', { title: 'Renamed' });
    b.triggers.updateRunResult('p', { lastRunAt: PAST, lastRunResult: 'ok', lastRunStatus: 'success', nextRunAt: PAST, retryCount: 0 });
    b.triggers.setEnabled('p', false);
    b.triggers.setConfirmedAt('p', '2026-03-01T00:00:00.000Z', 'owner');
    b.triggers.markEditedBy('p', { kind: 'owner' }, false);
    expect(pauseOf()).toEqual(before);
  });
});
