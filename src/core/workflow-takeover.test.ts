import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { MandateEnds } from './mandate-ends.js';
import { AuditLog } from './audit-log.js';
import { TriggerStore } from './trigger-store.js';
import { WorkflowStore } from './workflow-store.js';
import type { ApiProfile } from './api-store.js';
import { setPlanPauseForTests, writePause, type PausedFor } from './plan-pause.js';
import { encodeStamp } from './plan-stamp.js';
import { creatorCovered, editorCovered, planAuthorshipOf, planAuthorshipOfWorkflow, planMandate, planMembers } from './request-principal.js';
import { COVER_FROM_MARKS, marksOf, type TakeoverPrompts } from './takeover-core.js';
import { workflowStampHolds, withOwnerStamp } from './workflow-stamp.js';
import {
  WORKFLOW_TAKEOVER_DIGEST_PREFIX, takeOverWorkflow, workflowTakeoverPreview, type WorkflowTakeoverDeps,
} from './workflow-takeover.js';
import type { PlannedPipeline } from '../types/pipeline.js';

/**
 * The owner's takeover of a workflow from the library (`workflow-takeover.ts`) on a real
 * engine.db: what it decides, what it covers, releases and stamps, what its digest binds, and
 * that a refused or failed commit leaves nothing behind. The routes and a run afterwards are in
 * `server/workflow-takeover-http.test.ts`.
 */

const H = 3600;
const nowS = (): number => Math.floor(Date.now() / 1000);
const PAST = '2026-01-05T09:00:00.000Z';

const dirs: string[] = [];
const closers: Array<() => void> = [];
let restore: () => void = () => undefined;

beforeEach(() => { restore = setPlanPauseForTests(true); });
afterEach(() => {
  restore();
  for (const c of closers.splice(0).reverse()) c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Box {
  history: RunHistory;
  engineDb: EngineDb;
  db: ReturnType<EngineDb['getDb']>;
  triggers: TriggerStore;
  workflows: WorkflowStore;
  ends: MandateEnds;
  audit: AuditLog;
  prompts: TakeoverPrompts & { calls: string[] };
  profiles: ApiProfile[];
}

function box(): Box {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-wf-takeover-'));
  dirs.push(dir);
  const history = new RunHistory(join(dir, 'history.db'));
  const engineDb = new EngineDb(join(dir, 'engine.db'));
  history.setVerbGraph(engineDb);
  closers.push(() => { try { history.close(); } catch { /* twice is fine */ } });
  closers.push(() => { try { engineDb.close(); } catch { /* twice is fine */ } });
  const calls: string[] = [];
  const prompts = {
    calls,
    expirePendingForTrigger: (id: string): number => { calls.push(`expire ${id}`); return 0; },
    getAnsweredForTrigger: (): { id: string } | undefined => undefined,
    releaseTrigger: (): boolean => false,
  };
  return {
    history, engineDb, db: engineDb.getDb(), triggers: new TriggerStore(engineDb), workflows: new WorkflowStore(engineDb),
    ends: new MandateEnds(engineDb.getDb()), audit: new AuditLog(engineDb.getDb()), prompts, profiles: [],
  };
}

const deps = (b: Box, over: Partial<WorkflowTakeoverDeps> = {}): WorkflowTakeoverDeps => ({
  db: b.db, triggers: b.triggers, isLive: (id) => b.ends.isLive(id), audit: b.audit, prompts: b.prompts,
  workflows: b.workflows, hasher: b.engineDb,
  profiles: {
    knownProfiles: () => b.profiles,
    getByHostname: (host) => b.profiles.find((p) => new URL(p.base_url).hostname === host),
  },
  ...over,
});

const tag = (email: string): string => `mandate:${email}`;

function ended(b: Box, email: string, grant = `g-${email}`): void {
  b.ends.record({ kind: 'mandate', email, mandateId: grant, mandateExp: nowS() - H }, nowS() - 2 * H);
}
function renewed(b: Box, email: string, grant = `g-${email}`): void {
  b.ends.record({ kind: 'mandate', email, mandateId: grant, mandateExp: nowS() + H }, nowS() - 10);
}

const STEPS = [
  { id: 's1', task: 'Read the orders' },
  { id: 's2', task: 'Call the shop', tool: 'http_request', input_template: { url: 'https://shop.example.invalid/orders', method: 'GET' } },
  // Another tool with a url: not a request the runtime sends with a profile's connection.
  { id: 's3', task: 'Read the shop page', tool: 'web_research', input_template: { url: 'https://shop.example.invalid/' } },
];

/** A workflow created by `by` (a mandate), with two steps; stamped by the owner when `stamped`. */
function workflow(b: Box, id: string, by?: { email: string; grant?: string | null }, stamped = false, steps: readonly unknown[] = STEPS): string {
  const base = { id, name: 'W', template: true, steps } as unknown as PlannedPipeline;
  const planned = stamped ? withOwnerStamp(b.engineDb, base, '2026-01-02T00:00:00.000Z') : base;
  b.db.prepare("INSERT INTO workflows (id, name, definition_json, created_by, created_mandate_id, created_at) VALUES (?, 'W', ?, ?, ?, '2026-01-01 00:00:00')")
    .run(id, JSON.stringify(planned), by ? tag(by.email) : null, by === undefined ? null : (by.grant === undefined ? `g-${by.email}` : by.grant));
  return id;
}

function editor(b: Box, table: 'triggers' | 'workflows', id: string, email: string, grant: string | null = `g-${email}`, at = '2026-02-01 10:00:00'): void {
  b.db.prepare(`UPDATE ${table} SET mandate_editor = ?, mandate_editor_id = ?, mandate_edited_at = ? WHERE id = ?`).run(tag(email), grant, at, id);
}

/** A weekly plan on workflow `wf`, created by `by` when given. */
function plan(b: Box, id: string, wf: string, by?: string): string {
  b.history.insertTrigger({
    id, title: `Plan ${id}`, source: 'cron', effect: 'run_workflow', scheduleCron: '0 9 * * 1', nextRunAt: PAST,
    confirmedAt: '2026-01-01T00:00:00.000Z', confirmedBy: 'owner', pipelineId: wf,
    ...(by !== undefined ? { createdBy: tag(by), createdMandateId: `g-${by}` } : {}),
  });
  return id;
}

function pause(b: Box, id: string, ...emails: string[]): void {
  const entries: PausedFor[] = emails.map((e) => ({ mandateId: `g-${e}`, email: e, reason: 'expired', endsAt: nowS() - H, roles: ['workflow-created'], closedPrompt: false }));
  writePause(b.db, id, entries);
}

function profile(id: string, host: string, connectedBy: string | null, grant?: string, account?: string): ApiProfile {
  return {
    id, name: id, base_url: `https://${host}`,
    ...(connectedBy === null ? {} : {
      oauth_grant: {
        connected_by: tag(connectedBy), ...(grant !== undefined ? { connected_mandate_id: grant } : {}),
        ...(account !== undefined ? { account: { label: account, source: 'store' } } : {}),
      },
    }),
  } as unknown as ApiProfile;
}

const wfRow = (b: Box, id: string): Record<string, unknown> => b.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as Record<string, unknown>;
const trow = (b: Box, id: string): Record<string, unknown> => b.db.prepare('SELECT * FROM triggers WHERE id = ?').get(id) as Record<string, unknown>;
const auditRows = (b: Box): unknown[] => b.db.prepare("SELECT actor_kind, target FROM audit_log WHERE action = 'workflow.takeover'").all();
const stampHolds = (b: Box, id: string): boolean => workflowStampHolds(b.engineDb, JSON.parse(wfRow(b, id)['definition_json'] as string) as PlannedPipeline);
const wfMember = (b: Box, id: string): string | undefined => planMandate(planAuthorshipOfWorkflow(b.workflows.authorship(id)!))?.principal.email;

function expectOf(b: Box, id: string, d: WorkflowTakeoverDeps = deps(b)): string {
  const p = workflowTakeoverPreview(d, id);
  if (p.kind !== 'preview') throw new Error(`no preview: ${JSON.stringify(p)}`);
  return p.preview.expect;
}

/** Everything a takeover could write: the workflow row, every plan row, the audit rows. */
const snapshot = (b: Box): unknown => [
  b.db.prepare('SELECT * FROM workflows ORDER BY id').all(),
  b.db.prepare('SELECT * FROM triggers ORDER BY id').all(),
  auditRows(b),
];

describe('a workflow whose mandate ended is taken over: covered, stamped and recorded', () => {
  it('covers the mark, stamps the steps, records the grant, and the workflow then runs as the owner', () => {
    const b = box();
    workflow(b, 'w', { email: 'h@x.ch' });
    ended(b, 'h@x.ch');
    expect(stampHolds(b, 'w')).toBe(false);
    const out = takeOverWorkflow(deps(b), 'w', expectOf(b, 'w'));
    expect(out).toEqual({ kind: 'taken_over', id: 'w', runsAs: 'owner' });
    expect(wfMember(b, 'w')).toBeUndefined();
    expect(stampHolds(b, 'w')).toBe(true);
    // The marks stay: they are where the workflow came from.
    expect(wfRow(b, 'w')['created_by']).toBe(tag('h@x.ch'));
    expect(auditRows(b)).toEqual([{ actor_kind: 'owner', target: 'workflow=w mandates=g-h@x.ch' }]);
  });

  it('the preview names each mark with its role and end', () => {
    const b = box();
    workflow(b, 'w', { email: 'c@x.ch' });
    editor(b, 'workflows', 'w', 'e@x.ch', null);
    ended(b, 'c@x.ch');
    const p = workflowTakeoverPreview(deps(b), 'w');
    expect(p.kind === 'preview' && p.preview.marks).toEqual([
      { name: 'c@x.ch', role: 'workflow-created', ended: true },
      { name: 'e@x.ch', role: 'workflow-edited', ended: true, undetermined: true },
    ]);
  });

  it('its digest is the hash of its own prefix and of what the preview shows, in this order', () => {
    const b = box();
    workflow(b, 'w', { email: 'h@x.ch' });
    ended(b, 'h@x.ch');
    renewed(b, 'c@x.ch');
    // A plan of the ended mandate's own, paused: it stays paused.
    plan(b, 'p', 'w', 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    // A plan of C with a list of allowed connections the new stamp ends; its members change.
    plan(b, 'q', 'w', 'c@x.ch');
    const entry = { profile: 'pr', grant: 'g-c@x.ch', binding: 'b' };
    b.db.prepare('UPDATE triggers SET stamp_connections = ? WHERE id = ?').run(encodeStamp('2026-01-01T00:00:00.000Z', null, [entry]), 'q');
    b.profiles.push(profile('mine', 'shop.example.invalid', 'h@x.ch', 'g-h@x.ch', 'Main store'));
    const r = wfRow(b, 'w') as { definition_json: string };
    const sha = (v: string): string => createHash('sha256').update(v).digest('hex');
    const expected = sha(JSON.stringify([
      'lynox:workflow-takeover:v1', 'w', sha(r.definition_json),
      marksOf(wfRow(b, 'w')), [false, false],
      true, 'owner',
      [{ id: 'q', title: 'Plan q', before: tag('c@x.ch'), after: tag('c@x.ch'), runsNoMore: false }], [],
      [['p', 'Plan p']],
      [['q', 'Plan q', [entry]]],
      [['workflow-created', 'h@x.ch', true, false]],
      [['mine', 'g-h@x.ch', 'Main store', 'shop.example.invalid']],
      [['s2', 'mine']],
    ]));
    expect(WORKFLOW_TAKEOVER_DIGEST_PREFIX).toBe('lynox:workflow-takeover:v1');
    expect(expectOf(b, 'w')).toBe(expected);
  });

  it('a mark an earlier takeover covered is neither shown nor recorded again: only the new editor’s is', () => {
    const b = box();
    workflow(b, 'w', { email: 'a@x.ch' });
    renewed(b, 'a@x.ch');
    // An earlier takeover covered the creator's mark, while it was the only one.
    b.db.prepare(`UPDATE workflows SET ${COVER_FROM_MARKS} WHERE id = 'w'`).run(nowS());
    editor(b, 'workflows', 'w', 'f@x.ch');
    ended(b, 'f@x.ch');
    const p = workflowTakeoverPreview(deps(b), 'w');
    expect(p.kind === 'preview' && p.preview.marks).toEqual([{ name: 'f@x.ch', role: 'workflow-edited', ended: true }]);
    expect(takeOverWorkflow(deps(b), 'w', expectOf(b, 'w')).kind).toBe('taken_over');
    expect(auditRows(b)).toEqual([{ actor_kind: 'owner', target: 'workflow=w mandates=g-f@x.ch' }]);
  });

  it('mixed: a live creator and an ended editor — available, and both marks are covered and recorded', () => {
    const b = box();
    workflow(b, 'w', { email: 'a@x.ch' });
    editor(b, 'workflows', 'w', 'e@x.ch');
    renewed(b, 'a@x.ch');
    ended(b, 'e@x.ch');
    const p = workflowTakeoverPreview(deps(b), 'w');
    expect(p.kind === 'preview' && p.preview.marks).toEqual([
      { name: 'a@x.ch', role: 'workflow-created', ended: false },
      { name: 'e@x.ch', role: 'workflow-edited', ended: true },
    ]);
    expect(takeOverWorkflow(deps(b), 'w', expectOf(b, 'w')).kind).toBe('taken_over');
    const a = planAuthorshipOfWorkflow(b.workflows.authorship('w')!);
    expect([creatorCovered(a), editorCovered(a), planMandate(a)]).toEqual([true, true, undefined]);
    expect(auditRows(b)).toEqual([{ actor_kind: 'owner', target: 'workflow=w mandates=g-a@x.ch,g-e@x.ch' }]);
  });

  it('a stamp that already holds is not moved: confirmedAt keeps its time', () => {
    const b = box();
    workflow(b, 'w', { email: 'h@x.ch' }, true);
    ended(b, 'h@x.ch');
    const before = JSON.parse(wfRow(b, 'w')['definition_json'] as string) as { confirmedAt: string };
    expect(takeOverWorkflow(deps(b), 'w', expectOf(b, 'w')).kind).toBe('taken_over');
    const after = JSON.parse(wfRow(b, 'w')['definition_json'] as string) as { confirmedAt: string };
    expect([after.confirmedAt, stampHolds(b, 'w')]).toEqual([before.confirmedAt, true]);
  });
});

describe('what the takeover refuses, before anything is written', () => {
  it('not_found for an id that is no workflow, and unreadable for a definition that does not parse', () => {
    const b = box();
    expect(workflowTakeoverPreview(deps(b), 'nope')).toEqual({ kind: 'not_found' });
    expect(takeOverWorkflow(deps(b), 'nope', 'x')).toEqual({ kind: 'not_found' });
    workflow(b, 'w', { email: 'h@x.ch' });
    ended(b, 'h@x.ch');
    b.db.prepare("UPDATE workflows SET definition_json = '{broken' WHERE id = 'w'").run();
    const before = snapshot(b);
    expect(workflowTakeoverPreview(deps(b), 'w')).toEqual({ kind: 'refused', refusal: 'unreadable' });
    expect(takeOverWorkflow(deps(b), 'w', 'x')).toEqual({ kind: 'refused', refusal: 'unreadable' });
    expect(snapshot(b)).toEqual(before);
  });

  it('nothing_to_take_over for the owner’s own workflow and for one already taken over', () => {
    const b = box();
    workflow(b, 'own');
    expect(workflowTakeoverPreview(deps(b), 'own')).toEqual({ kind: 'refused', refusal: 'nothing_to_take_over' });
    workflow(b, 'w', { email: 'h@x.ch' });
    ended(b, 'h@x.ch');
    expect(takeOverWorkflow(deps(b), 'w', expectOf(b, 'w')).kind).toBe('taken_over');
    expect(workflowTakeoverPreview(deps(b), 'w')).toEqual({ kind: 'refused', refusal: 'nothing_to_take_over' });
  });

  it('a renewed mandate is live: mandate_live, and the takeover writes nothing', () => {
    const b = box();
    workflow(b, 'w', { email: 'h@x.ch' });
    ended(b, 'h@x.ch');
    const shown = expectOf(b, 'w');
    renewed(b, 'h@x.ch');
    const before = snapshot(b);
    expect(workflowTakeoverPreview(deps(b), 'w')).toEqual({ kind: 'refused', refusal: 'mandate_live' });
    expect(takeOverWorkflow(deps(b), 'w', shown)).toEqual({ kind: 'refused', refusal: 'mandate_live' });
    expect(snapshot(b)).toEqual(before);
    expect(wfMember(b, 'w')).toBe('h@x.ch');
  });

  it('running when a paused plan it would release still holds its lease', () => {
    const b = box();
    workflow(b, 'w', { email: 'h@x.ch' });
    plan(b, 'p', 'w');
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    b.db.prepare('UPDATE triggers SET lease_until = ? WHERE id = ?').run(new Date(Date.now() + 60_000).toISOString(), 'p');
    expect(workflowTakeoverPreview(deps(b), 'w')).toEqual({ kind: 'refused', refusal: 'running' });
  });
});

describe('the other plans on the workflow', () => {
  it('a paused plan of C that only the workflow mark held is released, its prompts settled, and then runs as C', () => {
    const b = box();
    workflow(b, 'w', { email: 'h@x.ch' });
    plan(b, 'p', 'w', 'c@x.ch');
    renewed(b, 'c@x.ch');
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    const pv = workflowTakeoverPreview(deps(b), 'w');
    expect(pv.kind === 'preview' && [pv.preview.alsoReleased, pv.preview.stillPaused]).toEqual([[{ id: 'p', title: 'Plan p' }], []]);
    expect(takeOverWorkflow(deps(b), 'w', expectOf(b, 'w')).kind).toBe('taken_over');
    expect(trow(b, 'p')['paused_at']).toBeNull();
    expect(b.prompts.calls).toContain('expire p');
    const t = b.triggers.getById('p')!;
    const wfMark = planMandate(planAuthorshipOfWorkflow(b.workflows.authorship('w')!));
    expect(planMembers(planMandate(planAuthorshipOf(t)), wfMark).of).toMatchObject({ kind: 'mandate', email: 'c@x.ch' });
    expect(auditRows(b)).toEqual([{ actor_kind: 'owner', target: 'workflow=w mandates=g-h@x.ch released=p' }]);
  });

  it('a paused plan with its own mark of the ended mandate stays paused and is listed as such', () => {
    const b = box();
    workflow(b, 'w', { email: 'h@x.ch' });
    plan(b, 'p', 'w', 'h@x.ch');
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    const pv = workflowTakeoverPreview(deps(b), 'w');
    expect(pv.kind === 'preview' && [pv.preview.alsoReleased, pv.preview.stillPaused]).toEqual([[], [{ id: 'p', title: 'Plan p' }]]);
    expect(takeOverWorkflow(deps(b), 'w', expectOf(b, 'w')).kind).toBe('taken_over');
    expect(trow(b, 'p')['paused_at']).not.toBeNull();
  });

  it('a plan on another workflow of the same mandate is not taken over with it and still runs as that mandate', () => {
    const b = box();
    workflow(b, 'w1', { email: 'h@x.ch' });
    workflow(b, 'w2', { email: 'h@x.ch' });
    plan(b, 'p2', 'w2');
    ended(b, 'h@x.ch');
    expect(takeOverWorkflow(deps(b), 'w1', expectOf(b, 'w1')).kind).toBe('taken_over');
    expect(wfMember(b, 'w1')).toBeUndefined();
    const t = b.triggers.getById('p2')!;
    const wfMark = planMandate(planAuthorshipOfWorkflow(b.workflows.authorship('w2')!));
    expect(planMembers(planMandate(planAuthorshipOf(t)), wfMark).of).toMatchObject({ kind: 'mandate', email: 'h@x.ch' });
  });

  it('a plan whose list of allowed connections the new stamp ends is listed; with a stamp that holds, none is', () => {
    const b = box();
    workflow(b, 'w', { email: 'h@x.ch' });
    plan(b, 'p', 'w', 'c@x.ch');
    ended(b, 'h@x.ch');
    renewed(b, 'c@x.ch');
    const list = (wfAt: string | null): string => encodeStamp('2026-01-01T00:00:00.000Z', wfAt, [{ profile: 'pr', grant: 'g-c@x.ch', binding: 'b' }]);
    b.db.prepare('UPDATE triggers SET stamp_connections = ? WHERE id = ?').run(list(null), 'p');
    const pv = workflowTakeoverPreview(deps(b), 'w');
    expect(pv.kind === 'preview' && pv.preview.lapsing).toEqual([{ id: 'p', title: 'Plan p' }]);

    const b2 = box();
    workflow(b2, 'w', { email: 'h@x.ch' }, true);
    plan(b2, 'p', 'w', 'c@x.ch');
    ended(b2, 'h@x.ch');
    b2.db.prepare('UPDATE triggers SET stamp_connections = ? WHERE id = ?').run(list('2026-01-02T00:00:00.000Z'), 'p');
    const pv2 = workflowTakeoverPreview(deps(b2), 'w');
    expect(pv2.kind === 'preview' && pv2.preview.lapsing).toEqual([]);
  });
});

describe('the connections a run as the owner no longer uses', () => {
  it('lists the covered mandate’s connections by grant with account and address, and marks every captured step on any mandate’s connection', () => {
    const b = box();
    workflow(b, 'w', { email: 'h@x.ch' });
    ended(b, 'h@x.ch');
    b.profiles.push(
      profile('shop', 'shop.example.invalid', 'other@x.ch', 'g-other'),
      profile('mine', 'mine.example.invalid', 'h@x.ch', 'g-h@x.ch', 'Main store'),
      profile('owners', 'owner.example.invalid', null),
    );
    const pv = workflowTakeoverPreview(deps(b), 'w');
    expect(pv.kind === 'preview' && pv.preview.connections).toEqual([{ profileId: 'mine', provider: 'mine.example.invalid', account: 'Main store', by: 'h@x.ch' }]);
    // s2 calls the shop, which another mandate connected: marked though its person is not one shown.
    // s3 names the same host through another tool, which sends no connection: not marked.
    expect(pv.kind === 'preview' && pv.preview.foreignConnectionSteps).toEqual([{ step: 's2', profileId: 'shop' }]);
  });

  it('a step on the owner’s own connection is not marked', () => {
    const b = box();
    workflow(b, 'w', { email: 'h@x.ch' });
    ended(b, 'h@x.ch');
    b.profiles.push(profile('shop', 'shop.example.invalid', null));
    const pv = workflowTakeoverPreview(deps(b), 'w');
    expect(pv.kind === 'preview' && pv.preview.foreignConnectionSteps).toEqual([]);
  });
});

describe('steps whose target is set only when they run, and bulk steps', () => {
  const req = (id: string, url: string): unknown => ({ id, task: id, tool: 'http_request', input_template: { url, method: 'POST' } });
  const bulk = (id: string, input: Record<string, unknown>): unknown => ({ id, task: id, tool: 'bulk_plan', input_template: { target_system: 'http', ...input } });
  const marked = (b: Box): unknown => {
    const pv = workflowTakeoverPreview(deps(b), 'w');
    return pv.kind === 'preview' ? pv.preview.foreignConnectionSteps : pv.kind;
  };
  /** A workflow a mandate made, whose own connection is covered, beside the owner's and another mandate's. */
  const withConnections = (steps: readonly unknown[]): Box => {
    const b = box();
    workflow(b, 'w', { email: 'h@x.ch' }, false, steps);
    ended(b, 'h@x.ch');
    b.profiles.push(
      profile('mine', 'mine.example.invalid', 'h@x.ch', 'g-h@x.ch'),
      profile('shop', 'shop.example.invalid', 'other@x.ch', 'g-other'),
      profile('owners', 'owner.example.invalid', null),
    );
    return b;
  };

  it('marks, without a profile, a request whose host a placeholder decides: in the host, as the whole address, in the user info, in the port, in the scheme', () => {
    const b = withConnections([
      req('host', 'https://{{s0.host}}/orders'),
      req('spaced', 'https://{{ s0.host }}/orders'),
      req('whole', '{{s0.url}}'),
      req('userinfo', 'https://{{s0.who}}@owner.example.invalid/orders'),
      req('port', 'https://owner.example.invalid:{{s0.port}}/orders'),
      req('suffix', 'https://owner.example.invalid{{s0.rest}}'),
      req('scheme', '{{s0.scheme}}://owner.example.invalid/orders'),
    ]);
    expect(marked(b)).toEqual(['host', 'spaced', 'whole', 'userinfo', 'port', 'suffix', 'scheme'].map((step) => ({ step, profileId: null })));
  });

  it('a placeholder after the host leaves the host as written: marked by its profile when that is a mandate’s, not at all when it is the owner’s', () => {
    const b = withConnections([
      req('path', 'https://shop.example.invalid/orders/{{s0.id}}'),
      req('query', 'https://shop.example.invalid/orders?after={{s0.id}}'),
      req('own', 'https://owner.example.invalid/orders/{{s0.id}}'),
    ]);
    expect(marked(b)).toEqual([{ step: 'path', profileId: 'shop' }, { step: 'query', profileId: 'shop' }]);
  });

  it('a step whose target is set only when it runs is not marked when no connection of a covered mandate is in play', () => {
    const b = box();
    workflow(b, 'w', { email: 'h@x.ch' }, false, [req('host', 'https://{{s0.host}}/orders'), bulk('b', { target_host: '{{s0.host}}' })]);
    ended(b, 'h@x.ch');
    // Another mandate connected the shop, but not the one whose mark is covered.
    b.profiles.push(profile('shop', 'shop.example.invalid', 'other@x.ch', 'g-other'), profile('owners', 'owner.example.invalid', null));
    expect(marked(b)).toEqual([]);
  });

  it('marks a bulk step by the connection of its target host, as the run reads it; one whose host a placeholder decides without a profile', () => {
    const b = withConnections([
      bulk('fixed', { target_host: 'Shop.Example.Invalid.' }),
      bulk('templated', { target_host: '{{s0.host}}.example.invalid' }),
      bulk('own', { target_host: 'owner.example.invalid' }),
      bulk('none', { source_list: { path: '/orders' } }),
      bulk('not-a-host', { target_host: 'https://shop.example.invalid/' }),
    ]);
    expect(marked(b)).toEqual([{ step: 'fixed', profileId: 'shop' }, { step: 'templated', profileId: null }]);
  });

  it('another tool with a placeholder where a host would be is not marked: it sends no connection', () => {
    const b = withConnections([{ id: 'web', task: 'web', tool: 'web_research', input_template: { url: 'https://{{s0.host}}/' } }]);
    expect(marked(b)).toEqual([]);
  });
});

describe('the digest: anything shown that moved between preview and takeover is changed, and nothing is written', () => {
  const refusedChanged = (b: Box, shown: string): void => {
    const before = snapshot(b);
    expect(takeOverWorkflow(deps(b), 'w', shown)).toEqual({ kind: 'refused', refusal: 'changed' });
    expect(snapshot(b)).toEqual(before);
  };
  const ready = (): Box => {
    const b = box();
    workflow(b, 'w', { email: 'h@x.ch' });
    ended(b, 'h@x.ch');
    return b;
  };

  it('the steps', () => {
    const b = ready();
    const shown = expectOf(b, 'w');
    b.db.prepare("UPDATE workflows SET definition_json = json_set(definition_json, '$.steps[0].task', 'Delete the orders') WHERE id = 'w'").run();
    refusedChanged(b, shown);
  });

  it('the marks', () => {
    const b = ready();
    const shown = expectOf(b, 'w');
    editor(b, 'workflows', 'w', 'h@x.ch');
    refusedChanged(b, shown);
  });

  it('the time of a mark: the same editor under the same grant changed it again', () => {
    const b = ready();
    editor(b, 'workflows', 'w', 'h@x.ch');
    const shown = expectOf(b, 'w');
    editor(b, 'workflows', 'w', 'h@x.ch', 'g-h@x.ch', '2026-03-01 10:00:00');
    refusedChanged(b, shown);
  });

  it('a default of a parameter, which the stamp binds beside the steps', () => {
    const b = ready();
    b.db.prepare(`UPDATE workflows SET definition_json = json_set(definition_json, '$.parameters', json('[{"name":"recipient","type":"string","description":"","defaultValue":"me@x.ch"}]')) WHERE id = 'w'`).run();
    const shown = expectOf(b, 'w');
    b.db.prepare("UPDATE workflows SET definition_json = json_set(definition_json, '$.parameters[0].defaultValue', 'stranger@y.ch') WHERE id = 'w'").run();
    refusedChanged(b, shown);
  });

  it('the plans that stay paused: a plan with its own mark of the mandate is paused in between', () => {
    const b = ready();
    plan(b, 'p', 'w', 'h@x.ch');
    const shown = expectOf(b, 'w');
    pause(b, 'p', 'h@x.ch');
    const p = workflowTakeoverPreview(deps(b), 'w');
    expect(p.kind === 'preview' && [p.preview.stillPaused, p.preview.alsoReleased]).toEqual([[{ id: 'p', title: 'Plan p' }], []]);
    refusedChanged(b, shown);
  });

  it('the title of a plan that stays paused', () => {
    const b = ready();
    plan(b, 'p', 'w', 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    const shown = expectOf(b, 'w');
    b.db.prepare("UPDATE triggers SET title = 'Renamed' WHERE id = 'p'").run();
    refusedChanged(b, shown);
  });

  it('the title of a plan whose list of allowed connections lapses', () => {
    const b = ready();
    // The mandate's own plan: its members do not change, so only the lapsing list names it.
    plan(b, 'q', 'w', 'h@x.ch');
    b.db.prepare('UPDATE triggers SET stamp_connections = ? WHERE id = ?')
      .run(encodeStamp('2026-01-01T00:00:00.000Z', null, [{ profile: 'pr', grant: 'g-h@x.ch', binding: 'b' }]), 'q');
    const p = workflowTakeoverPreview(deps(b), 'w');
    expect(p.kind === 'preview' && [p.preview.lapsing, p.preview.memberChanges, p.preview.stillPaused]).toEqual([[{ id: 'q', title: 'Plan q' }], [], []]);
    const shown = expectOf(b, 'w');
    b.db.prepare("UPDATE triggers SET title = 'Renamed' WHERE id = 'q'").run();
    refusedChanged(b, shown);
  });

  it('the plans whose members change', () => {
    const b = ready();
    const shown = expectOf(b, 'w');
    plan(b, 'p', 'w', 'c@x.ch');
    refusedChanged(b, shown);
  });

  it('the plans it releases: the sweep pauses a plan of C in between', () => {
    const b = ready();
    plan(b, 'p', 'w', 'c@x.ch');
    renewed(b, 'c@x.ch');
    const shown = expectOf(b, 'w');
    pause(b, 'p', 'h@x.ch');
    refusedChanged(b, shown);
  });

  it('the lists of allowed connections that lapse', () => {
    const b = ready();
    plan(b, 'p', 'w', 'c@x.ch');
    renewed(b, 'c@x.ch');
    const shown = expectOf(b, 'w');
    b.db.prepare('UPDATE triggers SET stamp_connections = ? WHERE id = ?')
      .run(encodeStamp('2026-01-01T00:00:00.000Z', null, [{ profile: 'pr', grant: 'g-c@x.ch', binding: 'b' }]), 'p');
    refusedChanged(b, shown);
  });

  it('the end of a mark: a live creator’s access runs out in between', () => {
    const b = box();
    workflow(b, 'w', { email: 'a@x.ch' });
    editor(b, 'workflows', 'w', 'e@x.ch');
    renewed(b, 'a@x.ch');
    ended(b, 'e@x.ch');
    const shown = expectOf(b, 'w');
    // A grant that ran out after its renewal: signed later than the renewal, with its end passed.
    b.ends.record({ kind: 'mandate', email: 'a@x.ch', mandateId: 'g-a@x.ch', mandateExp: nowS() - 1 }, nowS());
    expect(b.ends.isLive('g-a@x.ch')).toBe(false);
    refusedChanged(b, shown);
  });

  it('a connection of the mandate made again in between', () => {
    const b = ready();
    b.profiles.push(profile('mine', 'mine.example.invalid', 'h@x.ch', 'g-h@x.ch', 'Main store'));
    const shown = expectOf(b, 'w');
    b.profiles.splice(0, 1, profile('mine', 'mine.example.invalid', 'h@x.ch', 'g-h@x.ch', 'Other store'));
    refusedChanged(b, shown);
  });

  it('the service of a connection shown, moved in between', () => {
    const b = ready();
    b.profiles.push(profile('mine', 'mine.example.invalid', 'h@x.ch', 'g-h@x.ch', 'Main store'));
    const shown = expectOf(b, 'w');
    b.profiles.splice(0, 1, profile('mine', 'elsewhere.example.invalid', 'h@x.ch', 'g-h@x.ch', 'Main store'));
    refusedChanged(b, shown);
  });

  it('a connection shown, deleted in between', () => {
    const b = ready();
    b.profiles.push(profile('mine', 'mine.example.invalid', 'h@x.ch', 'g-h@x.ch', 'Main store'));
    const shown = expectOf(b, 'w');
    b.profiles.splice(0, 1);
    refusedChanged(b, shown);
  });

  it('a step newly on a mandate’s connection', () => {
    const b = ready();
    const shown = expectOf(b, 'w');
    b.profiles.push(profile('shop', 'shop.example.invalid', 'other@x.ch', 'g-other'));
    refusedChanged(b, shown);
  });

  it('CONTROL: with nothing moved, the same digest takes it over', () => {
    const b = ready();
    const shown = expectOf(b, 'w');
    expect(takeOverWorkflow(deps(b), 'w', shown).kind).toBe('taken_over');
  });

  it('the decision read again inside the transaction: steps moved after the first read are changed, and nothing is written', () => {
    const b = ready();
    plan(b, 'p', 'w');
    pause(b, 'p', 'h@x.ch');
    const shown = expectOf(b, 'w');
    // The released plan's prompts are settled after the first read and before the transaction:
    // the steps move exactly there, so only the read inside the transaction can see it.
    const prompts = {
      ...b.prompts,
      expirePendingForTrigger: (id: string): number => {
        b.db.prepare("UPDATE workflows SET definition_json = json_set(definition_json, '$.steps[0].task', 'X') WHERE id = 'w'").run();
        return b.prompts.expirePendingForTrigger(id);
      },
    };
    const before = b.db.prepare("SELECT covered_created_by, covered_at FROM workflows WHERE id = 'w'").get();
    expect(takeOverWorkflow(deps(b, { prompts }), 'w', shown)).toEqual({ kind: 'refused', refusal: 'changed' });
    expect(b.prompts.calls).toEqual(['expire p']);
    expect(b.db.prepare("SELECT covered_created_by, covered_at FROM workflows WHERE id = 'w'").get()).toEqual(before);
    expect(trow(b, 'p')['paused_at']).not.toBeNull();
    expect(auditRows(b)).toEqual([]);
  });
});

describe('a commit that cannot complete leaves nothing behind', () => {
  const ready = (): Box => {
    const b = box();
    workflow(b, 'w', { email: 'h@x.ch' });
    plan(b, 'p', 'w');
    ended(b, 'h@x.ch');
    pause(b, 'p', 'h@x.ch');
    return b;
  };

  it('an audit row that cannot be written: unrecorded, no cover, no stamp, no release', () => {
    const b = ready();
    const shown = expectOf(b, 'w');
    const before = snapshot(b);
    const audit = { record: (): void => { throw new Error('audit is full'); } } as unknown as AuditLog;
    expect(takeOverWorkflow(deps(b, { audit }), 'w', shown)).toEqual({ kind: 'refused', refusal: 'unrecorded' });
    expect(snapshot(b)).toEqual(before);
  });

  it('a stamp the store refuses: stamp_refused, and the cover and release written before it are rolled back', () => {
    const b = ready();
    const shown = expectOf(b, 'w');
    const before = snapshot(b);
    expect(takeOverWorkflow(deps(b, { workflows: { stampCurrent: () => false } }), 'w', shown)).toEqual({ kind: 'refused', refusal: 'stamp_refused' });
    expect(snapshot(b)).toEqual(before);
  });

  it('without the prompt store: refused with prompts when a plan is released, taken over when none is', () => {
    const b = ready();
    const before = snapshot(b);
    expect(takeOverWorkflow(deps(b, { prompts: null }), 'w', expectOf(b, 'w'))).toEqual({ kind: 'refused', refusal: 'prompts' });
    expect(snapshot(b)).toEqual(before);
    const b2 = box();
    workflow(b2, 'w', { email: 'h@x.ch' });
    ended(b2, 'h@x.ch');
    expect(takeOverWorkflow(deps(b2, { prompts: null }), 'w', expectOf(b2, 'w')).kind).toBe('taken_over');
  });
});

