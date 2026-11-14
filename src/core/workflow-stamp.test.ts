import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { WorkflowStore } from './workflow-store.js';
import { MANDATE_TAG_PREFIX, type RequestPrincipal } from './request-principal.js';
import type { PlannedPipeline } from '../types/pipeline.js';
import { stampFromRow } from './plan-stamp.js';
import {
  nextWorkflowStamp, stampOf, withOwnerStamp, workflowStampDigest, workflowStampHolds, workflowStampState,
} from './workflow-stamp.js';

// The owner's stamp on a workflow is bound to what it runs:
// any change by any writer makes it stop holding, and a stamp over unchanged steps moves nothing.

const AT = '2026-10-29T08:00:00.000Z';
const LATER = '2026-10-30T08:00:00.000Z';
const EVA: RequestPrincipal = { kind: 'mandate', email: 'eva@kanzlei.example', mandateId: 'g-eva' };

function workflow(over: Partial<PlannedPipeline> = {}): PlannedPipeline {
  return {
    id: 'wf-report', name: 'Report', goal: 'post the weekly report', reasoning: 'r', estimatedCost: 0,
    createdAt: AT, executed: false, template: true, mode: 'autonomous', parameters: [],
    steps: [{ id: 's1', task: 'post the weekly report', tools: ['http_request'] }],
    ...over,
  } as PlannedPipeline;
}

describe('workflow stamp', () => {
  const dirs: string[] = [];
  const engines: EngineDb[] = [];
  function engine(key = 'k'.repeat(32)): EngineDb {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-wf-stamp-'));
    dirs.push(dir);
    const e = new EngineDb(join(dir, 'engine.db'), key);
    engines.push(e);
    return e;
  }
  afterEach(() => {
    for (const e of engines.splice(0)) { try { e.close(); } catch { /* closed */ } }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  describe('the digest', () => {
    it('changes with each thing a run does, and with nothing else', () => {
      const e = engine();
      const base = workflowStampDigest(e, workflow()).digest;
      const changed: Array<[string, Partial<PlannedPipeline>]> = [
        ['task text', { steps: [{ id: 's1', task: 'post it elsewhere', tools: ['http_request'] }] }],
        ['a captured call', { steps: [{ id: 's1', task: 'post the weekly report', tools: ['http_request'], tool: 'http_request', input_template: { url: 'https://other.example/' } }] }],
        ['tools', { steps: [{ id: 's1', task: 'post the weekly report', tools: ['http_request', 'bash'] }] }],
        ['model', { steps: [{ id: 's1', task: 'post the weekly report', tools: ['http_request'], model: 'opus' } as PlannedPipeline['steps'][number]] }],
        ['input_from', { steps: [{ id: 's1', task: 'post the weekly report', tools: ['http_request'], input_from: ['s0'] }] }],
        ['mode', { mode: 'interactive' }],
        ['parameters', { parameters: [{ name: 'week', description: 'w', type: 'number', source: 'user_input' }] }],
        ['failure strategy', { on_failure: 'continue' }],
        ['limits', { limits: { maxSpendUsd: 5 } }],
        ['contract', { capabilityContract: { hostPatterns: ['api.example.com'], pathPatterns: ['/x'], httpMethods: ['POST'] } as unknown as PlannedPipeline['capabilityContract'] }],
        ['id', { id: 'wf-other' }],
      ];
      for (const [what, over] of changed) {
        expect(workflowStampDigest(e, workflow(over)).digest, what).not.toBe(base);
      }
      for (const [what, over] of [
        ['name', { name: 'Renamed' }], ['goal', { goal: 'other words' }], ['executed', { executed: true }],
        ['the stamp itself', withOwnerStamp(e, workflow(), AT)],
      ] as Array<[string, Partial<PlannedPipeline>]>) {
        expect(workflowStampDigest(e, workflow(over)).digest, what).toBe(base);
      }
    });

    it('takes a legacy blob over the defaults every reader fills, so no reader disagrees with the stamp', () => {
      const e = engine();
      const legacy = { id: 'wf-report', name: 'Report', steps: [{ id: 's1', task: 'post the weekly report', tools: ['http_request'] }] } as unknown as PlannedPipeline;
      expect(workflowStampDigest(e, legacy).digest).toBe(workflowStampDigest(e, workflow({ template: false, on_failure: 'stop' })).digest);
    });

    it('is keyed with the vault key, and says so', () => {
      expect(workflowStampDigest(engine(), workflow()).binding).toBe('keyed');
      expect(workflowStampDigest(engine(''), workflow()).binding).toBe('unkeyed');
      expect(workflowStampDigest(engine('a'.repeat(32)), workflow()).digest).not.toBe(workflowStampDigest(engine('b'.repeat(32)), workflow()).digest);
    });
  });

  describe('whether it holds', () => {
    it('holds over the steps it was taken over, and over no others', () => {
      const e = engine();
      const stamped = withOwnerStamp(e, workflow(), AT);
      expect(workflowStampHolds(e, stamped)).toBe(true);
      expect(workflowStampHolds(e, { ...stamped, steps: [{ id: 's1', task: 'post elsewhere' }] })).toBe(false);
    });

    it('does not hold without a digest, with another time, another key, or no hash at all', () => {
      const e = engine();
      const stamped = withOwnerStamp(e, workflow(), AT);
      expect(workflowStampHolds(e, { ...workflow(), confirmedAt: AT })).toBe(false);
      expect(workflowStampHolds(e, { ...stamped, confirmedAt: LATER })).toBe(false);
      expect(workflowStampHolds(engine('c'.repeat(32)), stamped)).toBe(false);
      expect(workflowStampHolds(engine(''), stamped)).toBe(false);
      expect(workflowStampHolds(null, stamped)).toBe(false);
      // The same digest, recorded as taken without the vault key: a key that came later does not bless it.
      expect(workflowStampHolds(e, { ...stamped, stamp: { ...stampOf(stamped)!, binding: 'unkeyed' } } as PlannedPipeline)).toBe(false);
    });

    it('a mandate\'s workflow waits for the owner until the owner\'s stamp holds; the owner\'s own unstamped one is unconfirmed', () => {
      const e = engine();
      const byMandate = { created_by: `${MANDATE_TAG_PREFIX}eva@kanzlei.example`, created_mandate_id: 'g-eva', created_at: AT } as unknown as Parameters<typeof workflowStampState>[2];
      expect(workflowStampState(e, workflow(), byMandate)).toBe('awaits_owner_stamp');
      expect(workflowStampState(e, withOwnerStamp(e, workflow(), AT), byMandate)).toBe('holds');
      expect(workflowStampState(e, workflow(), undefined)).toBe('unconfirmed');
      // The owner's own, stamped and then changed: waits for the owner, not switched off.
      expect(workflowStampState(e, { ...withOwnerStamp(e, workflow(), AT), steps: [] }, undefined)).toBe('awaits_owner_stamp');
      // Taken over by the owner: the plan runs as the owner's, but the steps still wait for the owner's own stamp.
      const takenOver = { ...byMandate, covered_created_by: byMandate.created_by, covered_created_id: 'g-eva', covered_created_at: AT } as typeof byMandate;
      expect(workflowStampState(e, workflow(), takenOver)).toBe('awaits_owner_stamp');
      expect(workflowStampState(e, withOwnerStamp(e, workflow(), AT), takenOver)).toBe('holds');
      // The owner set it up, a mandate changed it last: the same.
      const editedByMandate = { created_by: null, mandate_editor: `${MANDATE_TAG_PREFIX}eva@kanzlei.example`, mandate_editor_id: 'g-eva', mandate_edited_at: AT } as unknown as typeof byMandate;
      expect(workflowStampState(e, workflow(), editedByMandate)).toBe('awaits_owner_stamp');
    });

    it('a stamp over unchanged steps is not written again', () => {
      const e = engine();
      const stamped = withOwnerStamp(e, workflow(), AT);
      expect(nextWorkflowStamp(e, stamped, LATER)).toBeNull();
      expect(nextWorkflowStamp(e, { ...stamped, steps: [] }, LATER)?.at).toBe(LATER);
    });
  });

  describe('the store', () => {
    function save(store: WorkflowStore, planned: PlannedPipeline, author: RequestPrincipal | null = null): void {
      store.upsert({ id: planned.id, name: planned.name, definitionJson: JSON.stringify(planned), isTemplate: true }, author);
    }
    const blob = (store: WorkflowStore, id = 'wf-report'): PlannedPipeline => JSON.parse(store.get(id)!.definitionJson) as PlannedPipeline;

    it('stamps the definition as it stands, keeps the time over unchanged steps, and stamps anew over changed ones', () => {
      const e = engine();
      const store = new WorkflowStore(e);
      save(store, workflow());
      expect(store.stampCurrent('wf-report', AT)).toBe(true);
      expect(stampOf(blob(store))?.at).toBe(AT);
      expect(store.stampState(blob(store))).toBe('holds');
      // Same steps: the time stays, so the lists bound to it stay valid.
      expect(store.stampCurrent('wf-report', LATER)).toBe(true);
      expect(blob(store).confirmedAt).toBe(AT);
      // Changed steps (a raw write keeps the old stamp): it does not hold, and a new stamp moves it.
      e.getDb().prepare("UPDATE workflows SET definition_json = json_set(definition_json, '$.steps[0].task', 'post elsewhere') WHERE id = 'wf-report'").run();
      expect(store.stampState(blob(store))).toBe('awaits_owner_stamp');
      expect(store.stampCurrent('wf-report', LATER)).toBe(true);
      expect(blob(store).confirmedAt).toBe(LATER);
      expect(store.stampState(blob(store))).toBe('holds');
    });

    it('with the digest the owner saw, stamps only that digest', () => {
      const e = engine();
      const store = new WorkflowStore(e);
      save(store, workflow());
      const seen = store.stampDigest(blob(store));
      e.getDb().prepare("UPDATE workflows SET definition_json = json_set(definition_json, '$.steps[0].task', 'post elsewhere') WHERE id = 'wf-report'").run();
      expect(store.stampCurrent('wf-report', AT, seen)).toBe(false);
      expect(blob(store).confirmedAt).toBeUndefined();
      expect(store.stampCurrent('wf-report', AT, store.stampDigest(blob(store)))).toBe(true);
      expect(store.stampState(blob(store))).toBe('holds');
    });

    it('a mandate\'s workflow waits for the owner\'s stamp, and the owner\'s stamp lets it run', () => {
      const e = engine();
      const store = new WorkflowStore(e);
      save(store, workflow(), EVA);
      expect(store.mandateShaped('wf-report')).toBe(true);
      expect(store.stampState(blob(store))).toBe('awaits_owner_stamp');
      store.stampCurrent('wf-report', AT);
      expect(store.stampState(blob(store))).toBe('holds');
      expect(store.mandateShaped('wf-report')).toBe(true);
    });

    it('the grant\'s stamp is taken over the definition the acceptance checked, not what the row holds by then', () => {
      const e = engine();
      const store = new WorkflowStore(e);
      save(store, workflow());
      const seen = blob(store);
      e.getDb().prepare("UPDATE workflows SET definition_json = json_set(definition_json, '$.steps[0].task', 'post elsewhere') WHERE id = 'wf-report'").run();
      expect(store.setReviewedGrant('wf-report', '{"hostPatterns":["a.example"],"pathPatterns":["/x"],"httpMethods":["POST"]}', '{}', AT, seen)).toBe(true);
      expect(store.stampState(blob(store))).toBe('awaits_owner_stamp');
      // CONTROL: unchanged in between, the grant's stamp holds over the definition with its contract.
      save(store, workflow({ id: 'wf-ok' }));
      expect(store.setReviewedGrant('wf-ok', '{"hostPatterns":["a.example"],"pathPatterns":["/x"],"httpMethods":["POST"]}', '{}', AT, blob(store, 'wf-ok'))).toBe(true);
      expect(store.stampState(blob(store, 'wf-ok'))).toBe('holds');
    });

    it('reads a definition without steps or mode, judged as one with no steps', () => {
      const e = engine();
      const store = new WorkflowStore(e);
      store.upsert({ id: 'wf-bare', name: 'Bare', definitionJson: JSON.stringify({ id: 'wf-bare', name: 'Bare' }), isTemplate: true }, null);
      expect(store.definitionExact('wf-bare')?.mode).toBeDefined();
    });

    it('a prefix is not an id', () => {
      const e = engine();
      const store = new WorkflowStore(e);
      save(store, workflow({ id: 'wf-report-2' }));
      expect(store.stampCurrent('wf-report', AT)).toBe(false);
      expect(store.definitionExact('wf-report')).toBeUndefined();
      expect(blob(store, 'wf-report-2').confirmedAt).toBeUndefined();
    });
  });

  describe('the boot pass over the stamps from before the digest', () => {
    function insertList(e: EngineDb, id: string, workflowId: string, wf: string | null): void {
      e.getDb().prepare('INSERT INTO triggers (id, title, target_workflow_id, stamp_connections) VALUES (?, ?, ?, ?)')
        .run(id, id, workflowId, JSON.stringify({ at: AT, wf, entries: [{ profile: 'p', grant: 'g', binding: 'b' }] }));
    }
    const list = (e: EngineDb, id: string): { wf: unknown } => JSON.parse((e.getDb().prepare('SELECT stamp_connections FROM triggers WHERE id = ?').get(id) as { stamp_connections: string }).stamp_connections) as { wf: unknown };

    it('gives each old stamp its digest once, leaves the lists readable, and writes the inferred mode', () => {
      const e = engine();
      const store = new WorkflowStore(e);
      const legacy = { id: 'wf-old', name: 'Old', steps: [{ id: 's1', task: 'post the weekly report' }], confirmedAt: AT };
      store.upsert({ id: 'wf-old', name: 'Old', definitionJson: JSON.stringify(legacy), isTemplate: true }, null);
      store.upsert({ id: 'wf-none', name: 'None', definitionJson: JSON.stringify({ id: 'wf-none', name: 'None', steps: [] }), isTemplate: true }, null);
      insertList(e, 't-bound', 'wf-old', AT);
      insertList(e, 't-other', 'wf-old', LATER);
      expect(store.stampExistingWorkflows()).toBe(1);
      const after = JSON.parse(store.get('wf-old')!.definitionJson) as PlannedPipeline;
      expect(after.mode).toBe('autonomous');
      expect(store.stampState(after)).toBe('holds');
      // The lists stay bound to the stamp's time, which the stamp keeps: a run still reads them back.
      expect(list(e, 't-bound').wf).toBe(AT);
      expect(stampFromRow(JSON.stringify(list(e, 't-bound')), AT, after.confirmedAt ?? null)).toHaveLength(1);
      expect(list(e, 't-other').wf).toBe(LATER);
      expect((JSON.parse(store.get('wf-none')!.definitionJson) as PlannedPipeline).confirmedAt).toBeUndefined();
      // Once: a stamp without a digest that comes back later (a backfill, a restored file) does not hold.
      expect(store.stampExistingWorkflows()).toBeNull();
      store.upsert({ id: 'wf-back', name: 'Back', definitionJson: JSON.stringify({ ...legacy, id: 'wf-back' }), isTemplate: true }, null);
      expect(store.stampExistingWorkflows()).toBeNull();
      expect(store.stampState(JSON.parse(store.get('wf-back')!.definitionJson) as PlannedPipeline)).toBe('awaits_owner_stamp');
    });

    it('gives no stamp to a workflow a mandate set up: its old confirm never showed the owner the steps', () => {
      const e = engine();
      const store = new WorkflowStore(e);
      store.upsert({ id: 'wf-eva', name: 'Eva', definitionJson: JSON.stringify({ id: 'wf-eva', name: 'Eva', steps: [{ id: 's1', task: 'post' }], confirmedAt: AT }), isTemplate: true }, EVA);
      store.upsert({ id: 'wf-own', name: 'Own', definitionJson: JSON.stringify({ id: 'wf-own', name: 'Own', steps: [{ id: 's1', task: 'post' }], confirmedAt: AT }), isTemplate: true }, null);
      expect(store.stampExistingWorkflows()).toBe(1);
      const eva = JSON.parse(store.get('wf-eva')!.definitionJson) as PlannedPipeline;
      expect(stampOf(eva)).toBeNull();
      expect(store.stampState(eva)).toBe('awaits_owner_stamp');
      expect(store.stampState(JSON.parse(store.get('wf-own')!.definitionJson) as PlannedPipeline)).toBe('holds');
    });
  });
});
