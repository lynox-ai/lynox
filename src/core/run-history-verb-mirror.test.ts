import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { WorkflowStore } from './workflow-store.js';

/**
 * S3a — the RunHistory → engine.db workflow-definition dual-write mirror. Proves:
 * flag OFF is inert, flag ON dual-writes with a real is_template column, and a
 * mirror failure never breaks the authoritative legacy history.db write.
 */
describe('RunHistory verb-graph mirror (Foundation Rework v2 — S3a)', () => {
  const tmpDirs: string[] = [];
  const engines: EngineDb[] = [];
  const histories: RunHistory[] = [];

  function make(enabled: boolean, key = ''): { history: RunHistory; engine: EngineDb; reader: WorkflowStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-vm-'));
    tmpDirs.push(dir);
    const history = new RunHistory(join(dir, 'history.db'), key);
    const engine = new EngineDb(join(dir, 'engine.db'), key);
    histories.push(history);
    engines.push(engine);
    history.setVerbGraph(engine, enabled);
    return { history, engine, reader: new WorkflowStore(engine) };
  }

  afterEach(() => {
    // Close in afterEach so a mid-test throw still releases both handles.
    for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
    for (const h of histories) { try { h.close(); } catch { /* already closed */ } }
    engines.length = 0;
    histories.length = 0;
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
    tmpDirs.length = 0;
  });

  const planned = (over: Partial<{ id: string; name: string; goal: string; template: boolean }> = {}) => ({
    id: over.id ?? 'wf-1',
    name: over.name ?? 'Weekly report',
    goal: over.goal ?? 'compile + send the weekly report',
    steps: [],
    reasoning: 'saved from session run-x',
    estimatedCost: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    template: over.template ?? true,
  });

  it('flag OFF → legacy write only, NO engine.db row', () => {
    const { history, engine, reader } = make(false);
    history.insertPlannedPipeline(planned());
    expect(history.getPlannedPipeline('wf-1')).toBeDefined(); // legacy authoritative
    expect(reader.get('wf-1')).toBeUndefined();               // mirror inert
    engine.close();
    history.close();
  });

  it('flag ON → dual-write; engine.db carries is_template + the same definition blob', () => {
    const { history, engine, reader } = make(true, 'vault-key');
    history.insertPlannedPipeline(planned({ template: true }));
    const legacy = history.getPlannedPipeline('wf-1');
    const mirror = reader.get('wf-1');
    expect(mirror).toBeDefined();
    expect(mirror!.isTemplate).toBe(true);
    // The mirrored definition blob equals the legacy manifest_json byte-for-byte
    // (same object → same JSON.stringify), and survives the enc()/dec() round-trip.
    expect(mirror!.definitionJson).toBe(legacy!.manifest_json);
    engine.close();
    history.close();
  });

  it('flag ON → is_template=false for a one-shot plan', () => {
    const { history, engine, reader } = make(true);
    history.insertPlannedPipeline(planned({ template: false }));
    expect(reader.get('wf-1')!.isTemplate).toBe(false);
    engine.close();
    history.close();
  });

  it('flag ON → rename propagates to the mirror', () => {
    const { history, engine, reader } = make(true, 'k');
    history.insertPlannedPipeline(planned({ name: 'Old' }));
    history.renamePlannedPipeline('wf-1', 'New');
    expect(reader.get('wf-1')!.name).toBe('New');
    expect((JSON.parse(reader.get('wf-1')!.definitionJson) as { name: string }).name).toBe('New');
    engine.close();
    history.close();
  });

  it('flag ON → delete removes the mirror row', () => {
    const { history, engine, reader } = make(true);
    history.insertPlannedPipeline(planned());
    history.deletePlannedPipeline('wf-1');
    expect(reader.get('wf-1')).toBeUndefined();
    engine.close();
    history.close();
  });

  it('flag ON → markPipelineExecuted drops the one-shot def from the mirror', () => {
    const { history, engine, reader } = make(true);
    history.insertPlannedPipeline(planned({ template: false }));
    history.markPipelineExecuted('wf-1');
    expect(reader.get('wf-1')).toBeUndefined();
    engine.close();
    history.close();
  });

  it('flag ON → setWorkflowConfirmedAt stamps the mirror blob', () => {
    const { history, engine, reader } = make(true, 'k');
    history.insertPlannedPipeline(planned());
    history.setWorkflowConfirmedAt('wf-1', '2026-07-01T12:00:00Z');
    expect((JSON.parse(reader.get('wf-1')!.definitionJson) as { confirmedAt: string }).confirmedAt)
      .toBe('2026-07-01T12:00:00Z');
    engine.close();
    history.close();
  });

  it('mirror failure is isolated — a closed engine.db never breaks the legacy write', () => {
    const { history, engine } = make(true);
    engine.close(); // every subsequent WorkflowStore op now throws
    // legacy write must still succeed, no throw propagates
    expect(() => history.insertPlannedPipeline(planned())).not.toThrow();
    expect(history.getPlannedPipeline('wf-1')).toBeDefined();
    history.close();
  });

  it('setVerbGraph(false) after ON reverts to legacy-only', () => {
    const { history, engine, reader } = make(true);
    history.setVerbGraph(engine, false);
    history.insertPlannedPipeline(planned());
    expect(history.getPlannedPipeline('wf-1')).toBeDefined();
    expect(reader.get('wf-1')).toBeUndefined();
    engine.close();
    history.close();
  });
});
