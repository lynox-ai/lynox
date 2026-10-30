/**
 * Whom the library's Run runs a saved workflow as (1055, decision A), read from the authorship the
 * real stores write: the mandate that made or last changed it, else the owner. And which way out of
 * an ended mandate's workflow holds: a workflow the owner has written anew is the owner's, a copy of
 * the mandate's is not, because the copy keeps the mark of the steps it holds (`upsertCopy`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory } from '../core/run-history.js';
import { EngineDb } from '../core/engine-db.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from '../core/request-principal.js';
import { LIBRARY_RUN_AUTHOR_CHANGED, LIBRARY_RUN_UNCONFIRMED, libraryRunCheck, workflowRunsAs } from './run-source.js';

const EVA: RequestPrincipal = { kind: 'mandate', email: 'eva@kanzlei.example', mandateId: 'grant-eva' };

describe('whom a library run of a saved workflow is for', () => {
  let dir: string;
  let history: RunHistory;
  let engineDb: EngineDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-runs-as-'));
    history = new RunHistory(join(dir, 'history.db'));
    engineDb = new EngineDb(join(dir, 'engine.db'));
    history.setVerbGraph(engineDb);
  });
  afterEach(() => {
    try { engineDb.close(); } catch { /* closed */ }
    history.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function save(id: string, author: RequestPrincipal, copiedFrom?: string, task = 'post the weekly report'): void {
    history.insertPlannedPipeline({
      id, name: id, goal: 'weekly report', reasoning: 'r', estimatedCost: 0,
      createdAt: '2026-10-01T00:00:00.000Z', template: true, steps: [{ id: 's1', task }],
    }, author, copiedFrom);
  }
  const runsAs = (id: string): RequestPrincipal => workflowRunsAs(history.getWorkflowAuthorship(id));

  it('a workflow a mandate made runs as that mandate', () => {
    save('wf-eva', EVA);
    expect(runsAs('wf-eva')).toEqual(EVA);
  });

  it('CONTROL: the owner\'s own workflow runs as the owner', () => {
    save('wf-own', OWNER_PRINCIPAL);
    expect(runsAs('wf-own')).toEqual(OWNER_PRINCIPAL);
  });

  it('the owner\'s workflow a mandate later changed runs as that mandate', () => {
    save('wf-own', OWNER_PRINCIPAL);
    save('wf-own', EVA, undefined, 'post it elsewhere');
    expect(runsAs('wf-own')).toEqual(EVA);
  });

  it('the way out: a workflow the owner writes anew is the owner\'s, though a mandate\'s says the same', () => {
    save('wf-eva', EVA);
    save('wf-new', OWNER_PRINCIPAL);
    expect(runsAs('wf-new')).toEqual(OWNER_PRINCIPAL);
  });

  it('not a way out: the owner\'s COPY of a mandate\'s workflow still runs as that mandate', () => {
    save('wf-eva', EVA);
    save('wf-copy', OWNER_PRINCIPAL, 'wf-eva');
    expect(runsAs('wf-copy')).toMatchObject({ kind: 'mandate', email: EVA.kind === 'mandate' ? EVA.email : '' });
  });

  describe('the check the Run button hands the runner, on the workflow as the runner reads it', () => {
    const CONFIRMED = '2026-10-01T00:00:00.000Z';
    it('passes the workflow the route decided on', () => {
      save('wf-eva', EVA);
      expect(libraryRunCheck(EVA, (id) => history.getWorkflowAuthorship(id))({ id: 'wf-eva', confirmedAt: CONFIRMED })).toBeNull();
    });
    it('refuses it once a mandate changed the owner\'s workflow in between, which would otherwise run as the owner', () => {
      save('wf-own', OWNER_PRINCIPAL);
      const check = libraryRunCheck(OWNER_PRINCIPAL, (id) => history.getWorkflowAuthorship(id));
      save('wf-own', EVA, undefined, 'post it elsewhere');
      expect(check({ id: 'wf-own', confirmedAt: CONFIRMED })).toBe(LIBRARY_RUN_AUTHOR_CHANGED);
    });
    it('refuses the same person under a later access', () => {
      save('wf-eva', EVA);
      const earlier: RequestPrincipal = { kind: 'mandate', email: 'eva@kanzlei.example', mandateId: 'grant-eva-old' };
      expect(libraryRunCheck(earlier, (id) => history.getWorkflowAuthorship(id))({ id: 'wf-eva', confirmedAt: CONFIRMED })).toBe(LIBRARY_RUN_AUTHOR_CHANGED);
    });
    it('refuses a read that is no longer confirmed', () => {
      save('wf-eva', EVA);
      expect(libraryRunCheck(EVA, (id) => history.getWorkflowAuthorship(id))({ id: 'wf-eva' })).toBe(LIBRARY_RUN_UNCONFIRMED);
    });
  });

  it('no authorship row reads as the owner here; the runner refuses that run as unreadable', () => {
    expect(workflowRunsAs(undefined)).toEqual(OWNER_PRINCIPAL);
  });
});
