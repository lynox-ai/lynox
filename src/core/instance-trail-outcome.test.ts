import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineDb } from './engine-db.js';
import { AuditLog, TARGET_MAX } from './audit-log.js';
import { runInCallSlot, type CallSlot } from './call-connection.js';
import {
  ifCounts, ifCreated, ifEmptiedAny, ifNonNull, ifNotDeduped, ifOk, ifPositive, ifReturned, ifTrue,
  instanceTrailFor, instanceWrote, withInstanceWrite, type InstanceDecoder, type InstanceWriter, type InstanceWriteSpec,
} from './instance-trail.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';

/**
 * What the outcome row adds to `returned`/`failed` (660a-1b): `wrote=all|part` and `created=`,
 * only where a step's typed result proves a change. Never a claim that nothing changed.
 */

const MANDATE: RequestPrincipal = { kind: 'mandate', email: 'setup@example.org', mandateId: 'TEST-MANDATE-1' };
const UUID = 'abcd1234-0000-4000-8000-000000000001';

describe('instanceWrote', () => {
  const c = (step: string) => ({ step, note: 'changed' as const });
  const u = (step: string) => ({ step, note: 'unknown' as const });
  const t = (step: string) => ({ step, note: 'threw' as const });
  it.each([
    ['no step', [], ['a'], false, null],
    ['only unknown', [u('a')], ['a'], false, null],
    ['a thrown step and nothing proven', [t('a')], ['a'], false, null],
    ['the block threw, nothing proven', [u('a')], ['a'], true, null],
    ['every main step changed', [c('a'), c('b')], ['a', 'b'], false, 'all'],
    ['a main step repeated: any change counts', [u('a'), c('a')], ['a'], false, 'all'],
    ['a side step changed, the main one not', [c('mark'), u('apply')], ['apply'], false, 'part'],
    ['one of two main steps', [c('a'), u('b')], ['a', 'b'], false, 'part'],
    ['a step threw after a change', [c('a'), t('b')], ['a'], false, 'part'],
    ['the block threw after a change', [c('a')], ['a'], true, 'part'],
    ['no main named', [c('a')], [], false, 'part'],
  ] as const)('%s', (_label, notes, main, threw, expected) => {
    expect(instanceWrote(notes, main, threw)).toBe(expected);
  });
});

describe('the decoders', () => {
  const cases: Array<[string, InstanceDecoder<unknown>, unknown, 'changed' | 'unknown']> = [
    ['ifReturned', ifReturned, undefined, 'changed'],
    ['ifTrue true', ifTrue, true, 'changed'], ['ifTrue false', ifTrue, false, 'unknown'], ['ifTrue undefined', ifTrue, undefined, 'unknown'],
    ['ifPositive 2', ifPositive, 2, 'changed'], ['ifPositive 0', ifPositive, 0, 'unknown'], ['ifPositive undefined', ifPositive, undefined, 'unknown'], ['ifPositive "3"', ifPositive, '3', 'unknown'],
    ['ifNonNull object', ifNonNull, {}, 'changed'], ['ifNonNull null', ifNonNull, null, 'unknown'], ['ifNonNull undefined', ifNonNull, undefined, 'unknown'],
    ['ifOk ok', ifOk, { ok: true }, 'changed'], ['ifOk refused', ifOk, { ok: false, reason: 'x' }, 'unknown'], ['ifOk undefined', ifOk, undefined, 'unknown'],
    ['ifCounts inserted', ifCounts, { inserted: 1, updated: 0, errors: [] }, 'changed'], ['ifCounts updated', ifCounts, { inserted: 0, updated: 1, errors: [] }, 'changed'],
    ['ifCounts none, with warnings', ifCounts, { inserted: 0, updated: 0, errors: ['Record 0: unknown field'] }, 'unknown'], ['ifCounts undefined', ifCounts, undefined, 'unknown'],
    ['ifNotDeduped inserted', ifNotDeduped, { id: UUID, status: 'active' }, 'changed'], ['ifNotDeduped deduped', ifNotDeduped, { id: UUID, deduped: true }, 'unknown'], ['ifNotDeduped undefined', ifNotDeduped, undefined, 'unknown'],
    ['ifCreated created', ifCreated, { id: 'x', created: true }, 'changed'], ['ifCreated found', ifCreated, { id: 'x', created: false }, 'unknown'], ['ifCreated ambiguous', ifCreated, { ambiguous: true, candidateIds: [] }, 'unknown'],
    ['ifEmptiedAny some', ifEmptiedAny, { left: [], emptied: ['A'] }, 'changed'], ['ifEmptiedAny none', ifEmptiedAny, { left: ['A'], emptied: [] }, 'unknown'],
  ];
  it.each(cases)('%s', (_label, decode, v, expected) => { expect(decode(v)).toBe(expected); });
});

describe('w.run and the outcome row', () => {
  let dir = '';
  let db: EngineDb;
  let log: AuditLog;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lynox-instance-outcome-')); db = new EngineDb(join(dir, 'engine.db')); log = new AuditLog(db.getDb()); });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const rows = (): Array<{ phase: string; target: string }> => db.getDb().prepare('SELECT phase, target FROM audit_log ORDER BY id').all() as Array<{ phase: string; target: string }>;
  const writer = (principal: RequestPrincipal = MANDATE): InstanceWriter => ({ principal, currentRunId: 'run-1', toolContext: { auditLog: log } });
  const slot = (by: InstanceWriter): CallSlot => ({ instanceTrail: instanceTrailFor(by, 'test') });
  const spec = (over: Partial<InstanceWriteSpec> = {}): InstanceWriteSpec => ({ site: 'data_store_drop#delete', kind: 'delete', store: 'data_store', target: () => [['n', 1]], main: ['drop'], ...over });
  const inSlot = <T>(by: InstanceWriter, fn: () => T): T => runInCallSlot(slot(by), fn);

  it('without a proven change, the outcome row is the 1a row: same target, byte for byte', () => {
    const by = writer();
    inSlot(by, () => withInstanceWrite(by, spec(), (w) => w.run('drop', () => false, ifTrue)));
    expect(rows()).toEqual([{ phase: 'attempt', target: 'data_store n=1' }, { phase: 'returned', target: 'data_store n=1' }]);
  });

  it('a block that does not use w at all writes the 1a rows', () => {
    const by = writer();
    inSlot(by, () => withInstanceWrite(by, spec(), () => 'ok'));
    expect(rows().map(r => r.target)).toEqual(['data_store n=1', 'data_store n=1']);
  });

  it('a proven change leads the outcome target with wrote=, the attempt keeps its own', () => {
    const by = writer();
    inSlot(by, () => withInstanceWrite(by, spec(), (w) => w.run('drop', () => true, ifTrue)));
    expect(rows()).toEqual([{ phase: 'attempt', target: 'data_store n=1' }, { phase: 'returned', target: 'data_store wrote=all n=1' }]);
  });

  it('gives a sync value back sync and the same value', () => {
    const by = writer();
    const obj = { id: 'x' };
    let inner: unknown;
    const r = inSlot(by, () => withInstanceWrite(by, spec(), (w) => { inner = w.run('drop', () => obj, ifNonNull); return inner; }));
    expect(inner).toBe(obj);
    expect(r).toBe(obj);
  });

  it('gives a promise back as that same promise, and notes its settled value before the block goes on', async () => {
    const by = writer();
    const p = Promise.resolve(3);
    let same = false;
    await inSlot(by, () => withInstanceWrite(by, spec(), async (w) => { const got = w.run('drop', () => p, ifPositive); same = got === p; return await got; }));
    expect(same).toBe(true);
    expect(rows()[1]).toEqual({ phase: 'returned', target: 'data_store wrote=all n=1' });
  });

  it('passes a throw on unchanged and notes it: after a change, wrote=part on a failed row', () => {
    const by = writer();
    const err = new Error('disk');
    let caught: unknown;
    try {
      inSlot(by, () => withInstanceWrite(by, spec({ main: ['a', 'b'] }), (w) => { w.run('a', () => true, ifTrue); w.run('b', () => { throw err; }, ifTrue); }));
    } catch (e) { caught = e; }
    expect(caught).toBe(err);
    expect(rows()[1]).toEqual({ phase: 'failed', target: 'data_store wrote=part n=1' });
  });

  it('a step that throws inside the block and is caught there still caps the row at part', () => {
    const by = writer();
    inSlot(by, () => withInstanceWrite(by, spec({ main: ['flat'] }), (w) => {
      w.run('flat', () => 2, ifPositive);
      try { w.run('kg', () => { throw new Error('mirror'); }, ifPositive); } catch { /* the handler answers */ }
      return 'removed, mirror not updated';
    }));
    expect(rows()[1]).toEqual({ phase: 'returned', target: 'data_store wrote=part n=1' });
  });

  it('passes a rejection on as the same rejection, and leaves no unhandled rejection behind', async () => {
    const by = writer();
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown): void => { unhandled.push(r); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const err = new Error('later');
      const p = Promise.reject(err);
      let got: unknown;
      await inSlot(by, () => withInstanceWrite(by, spec(), async (w) => {
        try { await w.run('drop', () => p, ifPositive); } catch (e) { got = e; }
        return 'answered';
      }));
      expect(got).toBe(err);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a decoder that throws reads as unknown and changes nothing for the block', () => {
    const by = writer();
    const r = inSlot(by, () => withInstanceWrite(by, spec(), (w) => w.run('drop', () => 'v', () => { throw new Error('bad decoder'); })));
    expect(r).toBe('v');
    expect(rows()[1]).toEqual({ phase: 'returned', target: 'data_store n=1' });
  });

  it('for the owner, runs every step and writes no row', () => {
    const by = writer(OWNER_PRINCIPAL);
    const calls: string[] = [];
    const r = inSlot(by, () => withInstanceWrite(by, spec(), (w) => { w.run('drop', () => { calls.push('drop'); return true; }, ifTrue); w.created('drop', UUID); return 'done'; }));
    expect(r).toBe('done');
    expect(calls).toEqual(['drop']);
    expect(rows()).toEqual([]);
  });

  it('a step that settles after the outcome row still runs, and adds nothing to the row', async () => {
    const by = writer();
    let release: (v: boolean) => void = () => {};
    const late = new Promise<boolean>((r) => { release = r; });
    let ran = false;
    inSlot(by, () => withInstanceWrite(by, spec(), (w) => { void w.run('drop', () => { ran = true; return late; }, ifTrue); return 'left early'; }));
    release(true);
    await late;
    await new Promise((r) => setTimeout(r, 5));
    expect(ran).toBe(true);
    expect(rows()).toEqual([{ phase: 'attempt', target: 'data_store n=1' }, { phase: 'returned', target: 'data_store n=1' }]);
  });

  it.each([
    [UUID, true], ['abcd1234', true], ['media_1761500000000_0a1b2c3d.mp4', true], ['media_1761500000000_0a1b2c3d', true],
    ['e-1', false], ['Mueller GmbH', false], [`x${UUID}`, false], [`${UUID} `, false], ['ABCD1234', false], ['media_1_0a.tar.gz', false],
  ])('created(%j) is kept: %s', (id, kept) => {
    const by = writer();
    inSlot(by, () => withInstanceWrite(by, spec(), (w) => { w.run('drop', () => true, ifTrue); w.created('drop', id); }));
    expect(rows()[1]!.target).toBe(kept ? `data_store wrote=all created=${id} n=1` : 'data_store wrote=all n=1');
  });

  it('created= belongs to its step: another step\'s change does not write it', () => {
    const by = writer();
    inSlot(by, () => withInstanceWrite(by, spec({ main: ['make', 'mark'] }), (w) => {
      w.run('make', () => false, ifTrue);
      w.created('make', UUID);
      w.run('mark', () => true, ifTrue);
    }));
    expect(rows()[1]!.target).toBe('data_store wrote=part n=1');
  });

  it('a thenable that is not a promise is noted unknown and not read: it runs once', async () => {
    const by = writer();
    let thens = 0;
    const lazy = { then(ok: (v: boolean) => void) { thens += 1; ok(true); } };
    await inSlot(by, () => withInstanceWrite(by, spec(), async (w) => { await w.run('drop', () => lazy, ifTrue); }));
    expect(thens).toBe(1);
    expect(rows()[1]).toEqual({ phase: 'returned', target: 'data_store n=1' });
  });

  it('created= without a proven change is not written: the row stays the 1a row', () => {
    const by = writer();
    inSlot(by, () => withInstanceWrite(by, spec(), (w) => { w.created('drop', UUID); }));
    expect(rows()[1]!.target).toBe('data_store n=1');
  });

  it('a target over the bound keeps wrote= and created= and counts the pairs held back', () => {
    const by = writer();
    const many: Array<readonly [string, string]> = Array.from({ length: 60 }, (_, i) => [`k${String(i)}`, 'v'.repeat(10)] as const);
    inSlot(by, () => withInstanceWrite(by, spec({ target: () => many }), (w) => { w.run('drop', () => true, ifTrue); w.created('drop', UUID); }));
    const [attempt, outcome] = rows();
    expect(outcome!.target.length).toBeLessThanOrEqual(TARGET_MAX);
    expect(outcome!.target.startsWith(`data_store wrote=all created=${UUID} k0=`)).toBe(true);
    const shown = (outcome!.target.match(/ k\d+=/g) ?? []).length;
    expect(outcome!.target.endsWith(` +${String(60 - shown)} more`)).toBe(true);
    expect(attempt!.target.endsWith(' more')).toBe(true);
  });

  it('a double that returns undefined where the contract says boolean never reads as a change', async () => {
    const by = writer();
    await inSlot(by, () => withInstanceWrite(by, spec({ main: ['append'] }), async (w) => { await w.run('append', async () => undefined, ifTrue); }));
    expect(rows()[1]).toEqual({ phase: 'returned', target: 'data_store n=1' });
  });
});
