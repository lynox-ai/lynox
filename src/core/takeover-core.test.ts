import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { AuditLog } from './audit-log.js';
import { commitTakeover, type TakeoverCoreDeps, type TakeoverPrompts } from './takeover-core.js';

/**
 * The commit every takeover shares (`commitTakeover`), on its own: what it answers, and that a
 * write it refuses or that fails leaves nothing behind. The plan takeover's own tests
 * (`plan-takeover.test.ts`) hold the same commit through its real decision.
 */

interface State { readonly expect: string }

function setup(opts: { audit?: 'ok' | 'throws' | null } = {}) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE written (v TEXT)');
  const recorded: unknown[] = [];
  const audit = opts.audit === null ? null : ({
    record: (entry: unknown) => {
      if (opts.audit === 'throws') throw new Error('audit is full');
      recorded.push(entry);
    },
  } as unknown as AuditLog);
  const cleared: string[] = [];
  const prompts: TakeoverPrompts = {
    expirePendingForTrigger: (id) => { cleared.push(id); return 0; },
    getAnsweredForTrigger: () => undefined,
    releaseTrigger: () => false,
  };
  const deps: TakeoverCoreDeps = { db, triggers: { getById: () => undefined, endWait: () => undefined } as never, isLive: () => false, audit, prompts };
  const rows = (): number => (db.prepare('SELECT COUNT(*) AS n FROM written').get() as { n: number }).n;
  return { db, deps, recorded, cleared, rows };
}

describe('commitTakeover', () => {
  it('writes and records once the state still has the digest shown, after settling the prompts it names', () => {
    const s = setup();
    const r = commitTakeover(s.deps, 'd1', () => ({ ok: { expect: 'd1' } as State }), () => ['p1', 'p2'], (_st, _now, record) => {
      // The prompts are settled before the write starts.
      expect(s.cleared).toEqual(['p1', 'p2']);
      s.db.prepare("INSERT INTO written VALUES ('x')").run();
      record({ action: 'x.takeover' } as never);
      return 'done' as const;
    });
    expect(r).toBe('done');
    expect(s.rows()).toBe(1);
    expect(s.recorded).toHaveLength(1);
    expect(s.cleared).toEqual(['p1', 'p2']);
  });

  it('a state that moved between the two reads is changed, and nothing is written', () => {
    const s = setup();
    let reads = 0;
    const r = commitTakeover(s.deps, 'd1', () => ({ ok: { expect: reads++ === 0 ? 'd1' : 'd2' } as State }), () => [], () => {
      s.db.prepare("INSERT INTO written VALUES ('x')").run();
      return 'done' as const;
    });
    expect(r).toEqual({ kind: 'refused', refusal: 'changed' });
    expect(s.rows()).toBe(0);
  });

  it('an audit row that cannot be written is unrecorded, and the write is rolled back', () => {
    const s = setup({ audit: 'throws' });
    const r = commitTakeover(s.deps, 'd1', () => ({ ok: { expect: 'd1' } as State }), () => [], (_st, _now, record) => {
      s.db.prepare("INSERT INTO written VALUES ('x')").run();
      record({ action: 'x.takeover' } as never);
      return 'done' as const;
    });
    expect(r).toEqual({ kind: 'refused', refusal: 'unrecorded' });
    expect(s.rows()).toBe(0);
  });

  it('any other failure of the write is thrown, not answered as unrecorded, and the write is rolled back', () => {
    const s = setup();
    expect(() => commitTakeover(s.deps, 'd1', () => ({ ok: { expect: 'd1' } as State }), () => [], () => {
      s.db.prepare("INSERT INTO written VALUES ('x')").run();
      throw new Error('disk I/O error');
    })).toThrow('disk I/O error');
    expect(s.rows()).toBe(0);
  });

  it('a stop from the decision is answered as it is, before anything else', () => {
    const s = setup({ audit: null });
    const r = commitTakeover(s.deps, 'd1', () => ({ stop: 'not_found' as const }), () => ['p1'], () => 'done' as const);
    expect(r).toBe('not_found');
    expect(s.cleared).toEqual([]);
  });
});
