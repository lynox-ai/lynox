import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { MandateEnds } from './mandate-ends.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from './request-principal.js';

describe('MandateEnds', () => {
  let dir: string;
  let edb: EngineDb;
  let ends: MandateEnds;
  const M = (over: Partial<Extract<RequestPrincipal, { kind: 'mandate' }>> = {}): RequestPrincipal =>
    ({ kind: 'mandate', email: 'helper@example.invalid', mandateId: 'M-1', mandateExp: 2_000, ...over });
  const rows = (): unknown[] => edb.getDb().prepare('SELECT mandate_id, ends_at, issued_at FROM mandate_ends ORDER BY mandate_id').all();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-mandate-ends-'));
    edb = new EngineDb(join(dir, 'engine.db'));
    ends = new MandateEnds(edb.getDb());
  });
  afterEach(() => {
    edb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the end a mandate request carried, and reads the mandate as live until then', () => {
    ends.record(M(), 100);
    expect(ends.endOf('M-1')).toBe(2_000);
    expect(ends.isLive('M-1', 1_999)).toBe(true);
    expect(ends.isLive('M-1', 2_000)).toBe(false);
  });

  it('takes the end from the latest login, whichever way it moved', () => {
    ends.record(M(), 100);
    ends.record(M({ mandateExp: 5_000 }), 200);
    expect(ends.endOf('M-1')).toBe(5_000);
    // A later login carrying an earlier end: the control plane said so later.
    ends.record(M({ mandateExp: 3_000 }), 300);
    expect(ends.endOf('M-1')).toBe(3_000);
  });

  it('does not let a request of an older session move the end back', () => {
    ends.record(M({ mandateExp: 5_000 }), 200);
    ends.record(M({ mandateExp: 9_000 }), 100);
    expect(ends.endOf('M-1')).toBe(5_000);
    // A fresh process has no memory of the newer login; the row itself refuses.
    const fresh = new MandateEnds(edb.getDb());
    fresh.record(M({ mandateExp: 9_000 }), 100);
    expect(fresh.endOf('M-1')).toBe(5_000);
    // Nor with an earlier end: an older login does not count, whichever way it would move it.
    fresh.record(M({ mandateExp: 1_000 }), 100);
    expect(fresh.endOf('M-1')).toBe(5_000);
  });

  it('keeps the earlier end of two logins signed in the same second', () => {
    ends.record(M({ mandateExp: 5_000 }), 200);
    ends.record(M({ mandateExp: 3_000 }), 200);
    expect(ends.endOf('M-1')).toBe(3_000);
    ends.record(M({ mandateExp: 9_000 }), 200);
    expect(ends.endOf('M-1')).toBe(3_000);
    // The row decides as well when this process has not seen the other login.
    const fresh = new MandateEnds(edb.getDb());
    fresh.record(M({ mandateExp: 9_000 }), 200);
    expect(fresh.endOf('M-1')).toBe(3_000);
    fresh.record(M({ mandateExp: 1_000 }), 200);
    expect(fresh.endOf('M-1')).toBe(1_000);
  });

  it('writes a login once: later requests of the same session leave the row alone', () => {
    ends.record(M(), 100);
    edb.getDb().prepare('DELETE FROM mandate_ends').run();
    ends.record(M(), 100);
    // Nor does a request of an older session, whatever end it carries.
    ends.record(M({ mandateExp: 1_000 }), 90);
    expect(rows()).toEqual([]);
    ends.record(M(), 101);
    expect(rows()).toEqual([{ mandate_id: 'M-1', ends_at: 2_000, issued_at: 101 }]);
  });

  it('writes a login again when its first write failed', () => {
    edb.getDb().exec('ALTER TABLE mandate_ends RENAME TO mandate_ends_away');
    expect(() => ends.record(M(), 100)).toThrow();
    edb.getDb().exec('ALTER TABLE mandate_ends_away RENAME TO mandate_ends');
    ends.record(M(), 100);
    expect(ends.endOf('M-1')).toBe(2_000);
  });

  it('keeps a revoked mandate ended, whatever a later login carries', () => {
    ends.record(M({ mandateExp: 5_000 }), 100);
    ends.revoke('M-1', 150);
    expect(ends.isLive('M-1', 120)).toBe(false);
    ends.record(M({ mandateExp: 9_000 }), 200);
    expect(ends.isLive('M-1', 300)).toBe(false);
    expect(ends.endOf('M-1')).toBe(5_000);
    // In a fresh process too, and a second revocation does not move the first.
    const fresh = new MandateEnds(edb.getDb());
    fresh.record(M({ mandateExp: 9_000 }), 300);
    fresh.revoke('M-1', 400);
    expect(fresh.isLive('M-1', 300)).toBe(false);
    // A login signed in the same second as the last one recorded moves nothing either.
    const third = new MandateEnds(edb.getDb());
    third.record(M({ mandateExp: 1_000 }), 100);
    expect(third.endOf('M-1')).toBe(5_000);
    expect(edb.getDb().prepare('SELECT revoked_at FROM mandate_ends').get()).toEqual({ revoked_at: 150 });
  });

  it('keeps a mandate revoked before its first login ended', () => {
    ends.revoke('M-1', 50);
    ends.record(M({ mandateExp: 9_000 }), 100);
    expect(ends.isLive('M-1', 200)).toBe(false);
  });

  it('keeps each mandate apart: a later mandate for the same address does not extend the earlier', () => {
    ends.record(M(), 100);
    ends.record(M({ mandateId: 'M-2', mandateExp: 9_000 }), 100);
    expect(ends.isLive('M-1', 3_000)).toBe(false);
    expect(ends.isLive('M-2', 3_000)).toBe(true);
    expect(rows()).toEqual([
      { mandate_id: 'M-1', ends_at: 2_000, issued_at: 100 },
      { mandate_id: 'M-2', ends_at: 9_000, issued_at: 100 },
    ]);
  });

  it('reads a mandate it has no end for as ended', () => {
    expect(ends.endOf('M-9')).toBeUndefined();
    expect(ends.isLive('M-9', 0)).toBe(false);
  });

  it('records nothing for the owner, nor for a mandate without an end or an id', () => {
    ends.record(OWNER_PRINCIPAL, 100);
    ends.record(M({ mandateExp: undefined }), 100);
    ends.record(M({ mandateId: undefined }), 100);
    expect(rows()).toEqual([]);
  });
});
