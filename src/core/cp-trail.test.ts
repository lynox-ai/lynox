import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineDb } from './engine-db.js';
import { AuditLog, TARGET_MAX, type AuditEntry } from './audit-log.js';
import { CP_ADMIN_PRINCIPAL } from './request-principal.js';
import {
  CP_REFUSAL_ROWS_PER_DAY, CP_TRAIL_PENDING_MAX, CpRefusalTally, CpTrail,
  cpExportOnAuditFailure, cpExportTarget, cpRequestTarget,
} from './cp-trail.js';

const row = (n: number): AuditEntry => ({
  principal: CP_ADMIN_PRINCIPAL, action: 'GET /api/export', phase: 'attempt', correlationId: `c-${String(n)}`, requestId: `r-${String(n)}`,
});

describe('the control plane\'s trail (cp-trail.ts)', () => {
  let dir = '';
  let db: EngineDb;
  let log: AuditLog;
  let lines: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-cp-trail-'));
    db = new EngineDb(join(dir, 'engine.db'));
    log = new AuditLog(db.getDb());
    lines = [];
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const rows = (): Array<Record<string, unknown>> => db.getDb().prepare('SELECT * FROM audit_log ORDER BY id').all() as Array<Record<string, unknown>>;
  const warn = (line: string): void => { lines.push(line); };

  it('writes a row at once while the log can be written, with recorded_at equal to ts', () => {
    const trail = new CpTrail(() => log, warn);
    expect(trail.write(row(1))).toBe(true);
    expect(rows()).toEqual([expect.objectContaining({ actor_kind: 'cp-admin', correlation_id: 'c-1', request_id: 'r-1' })]);
    expect(rows()[0]!['recorded_at']).toBe(rows()[0]!['ts']);
    expect(lines).toEqual([]);
  });

  it('keeps a row it cannot write, names it on stderr, and writes it with the next one, late', async () => {
    let available = false;
    const trail = new CpTrail(() => (available ? log : null), warn);
    expect(trail.write(row(1))).toBe(false);
    expect(trail.pendingCount()).toBe(1);
    expect(lines).toEqual([expect.stringContaining('row not written, kept in memory until a later row can be (request r-1): no audit log')]);
    // A later moment, so the late row's two times differ.
    await new Promise((r) => setTimeout(r, 5));
    available = true;
    expect(trail.write(row(2))).toBe(true);
    expect(trail.pendingCount()).toBe(0);
    const [late, now] = rows();
    expect([late!['correlation_id'], now!['correlation_id']]).toEqual(['c-1', 'c-2']);
    // The kept row keeps when it happened, and says when it was written.
    expect(Date.parse(late!['recorded_at'] as string)).toBeGreaterThan(Date.parse(late!['ts'] as string));
    expect(now!['recorded_at']).toBe(now!['ts']);
  });

  it('keeps a row when the log throws, too, and never throws itself', () => {
    const broken = { record: () => { throw new Error('SQLITE_FULL'); } } as unknown as AuditLog;
    const trail = new CpTrail(() => broken, warn);
    expect(() => trail.write(row(1))).not.toThrow();
    expect(trail.pendingCount()).toBe(1);
    expect(lines[0]).toContain('SQLITE_FULL');
  });

  it('keeps at most CP_TRAIL_PENDING_MAX rows, and names how many it dropped', () => {
    const trail = new CpTrail(() => null, warn);
    for (let i = 0; i < CP_TRAIL_PENDING_MAX + 3; i++) trail.write(row(i));
    expect(trail.pendingCount()).toBe(CP_TRAIL_PENDING_MAX);
    expect(lines.at(-1)).toBe(`[lynox] control-plane trail: row not written and not kept, the buffer is full (request r-${String(CP_TRAIL_PENDING_MAX + 2)}): 3 row(s) dropped since start\n`);
  });

  it('loses what it kept when the process ends: a new trail starts empty', () => {
    const before = new CpTrail(() => null, warn);
    before.write(row(1));
    expect(before.pendingCount()).toBe(1);
    // What a restart is: a new trail over the same log.
    const after = new CpTrail(() => log, warn);
    expect(after.pendingCount()).toBe(0);
    after.write(row(2));
    expect(rows().map((r) => r['correlation_id'])).toEqual(['c-2']);
  });

  it('writes kept rows in order, and keeps the rest when the log fails half way', () => {
    let calls = 0;
    const flaky = { record: (e: AuditEntry) => { calls++; if (calls === 2) throw new Error('busy'); log.record(e); } } as unknown as AuditLog;
    let target: AuditLog | null = null;
    const trail = new CpTrail(() => target, warn);
    trail.write(row(1));
    trail.write(row(2));
    target = flaky;
    // c-1 written, c-2 fails: c-2 stays first in line, c-3 waits behind it.
    expect(trail.write(row(3))).toBe(false);
    expect(trail.pendingCount()).toBe(2);
    target = log;
    trail.write(row(4));
    expect(rows().map((r) => r['correlation_id'])).toEqual(['c-1', 'c-2', 'c-3', 'c-4']);
  });

  it('does not keep a row it was told not to keep, and names it on stderr', () => {
    const trail = new CpTrail(() => null, warn);
    expect(trail.write(row(1), false)).toBe(false);
    expect(trail.pendingCount()).toBe(0);
    expect(lines).toEqual(['[lynox] control-plane trail: row not written and not kept (request r-1): no audit log\n']);
    // Control: the same row, kept by default.
    trail.write(row(2));
    expect(trail.pendingCount()).toBe(1);
  });

  it('delivers the export when its row cannot be written, until G6 says otherwise', () => {
    expect(cpExportOnAuditFailure()).toBe('deliver');
  });
});

describe('the targets of the control plane\'s acts', () => {
  it('names the export\'s job id when it has the right shape, and the class otherwise', () => {
    const id = 'a'.repeat(32);
    expect(cpExportTarget(id)).toEqual({ kind: 'request-id', value: `request ${id}` });
    expect(cpExportTarget(undefined)).toEqual({ kind: 'no-request-id', value: 'no-request-id' });
    for (const bad of ['A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), `${'a'.repeat(31)}g`, '', [id, id]]) {
      expect(cpExportTarget(bad)).toEqual({ kind: 'invalid-request-id', value: 'invalid-request-id' });
    }
  });

  it('names the mandates a revoke lists, and the class of the Google revoke\'s flag', () => {
    expect(cpRequestTarget('POST /api/admin/mandates/revoke', { revoked_mandate_ids: ['TEST-M-1', 'TEST-M-2'] })).toBe('2 mandate(s): TEST-M-1,TEST-M-2');
    expect(cpRequestTarget('POST /api/admin/mandates/revoke', { revoked_mandate_ids: [] })).toBe('0 mandate(s)');
    // A long list of long ids: whole ids that fit the row's bound, and how many more. The sixth id
    // fits only if no room is held back for the count, which then would not fit.
    const id = (i: number, len: number): string => `TEST-M-${String(i).padStart(2, '0')}-`.padEnd(len, 'x');
    const many = Array.from({ length: 20 }, (_, i) => id(i, i === 5 ? 56 : 64));
    const target = cpRequestTarget('POST /api/admin/mandates/revoke', { revoked_mandate_ids: many })!;
    expect(target.length).toBeLessThanOrEqual(TARGET_MAX);
    const m = /^20 mandate\(s\): (.*) \+(\d+) more$/.exec(target);
    expect(m).not.toBeNull();
    const shown = m![1]!.split(',');
    expect(shown).toEqual(many.slice(0, shown.length));
    expect(shown.length + Number(m![2])).toBe(20);
    // As many as fit: one more would not.
    expect(`20 mandate(s): ${many.slice(0, shown.length + 1).join(',')} +${String(19 - shown.length)} more`.length).toBeGreaterThan(TARGET_MAX);
    expect(cpRequestTarget('POST /api/admin/mandates/revoke', 'nope')).toBe('invalid body');
    // Ids that fill the room exactly are all shown: the bound is reached, not passed.
    // Room for 6 ids: 400 - '6 mandate(s): '.length - ' +6 more'.length = 378 = 373 for the ids + 5 commas.
    const exact = [62, 62, 62, 62, 62, 63].map((len, i) => id(i, len));
    expect(cpRequestTarget('POST /api/admin/mandates/revoke', { revoked_mandate_ids: exact })).toBe(`6 mandate(s): ${exact.join(',')}`);
    expect(cpRequestTarget('POST /api/admin/google/revoke', null)).toBe('delete_drive_backups absent');
    expect(cpRequestTarget('POST /api/admin/google/revoke', { delete_drive_backups: false })).toBe('delete_drive_backups=false');
    // Never the value the caller chose.
    expect(cpRequestTarget('POST /api/admin/google/revoke', { delete_drive_backups: 'TEST-CHOSEN' })).toBe('delete_drive_backups=other');
    expect(cpRequestTarget('GET /api/admin/google/status', null)).toBeUndefined();
  });
});

describe('the control plane\'s refusals (bounded)', () => {
  const at = (iso: string): Date => new Date(iso);
  const R = 'GET /api/secrets';

  it('gives the first refusal of a route in a minute a row, and counts the rest into one row after it', () => {
    const tally = new CpRefusalTally();
    const first = tally.refuse(R, at('2026-10-14T10:00:01Z'));
    expect(first).toEqual([expect.objectContaining({ principal: CP_ADMIN_PRINCIPAL, action: `${R} 403`, phase: 'refused', target: 'not registered for the control plane' })]);
    expect(tally.refuse(R, at('2026-10-14T10:00:30Z'))).toEqual([]);
    expect(tally.refuse(R, at('2026-10-14T10:00:59Z'))).toEqual([]);
    // Another route in the same minute has its own row.
    expect(tally.refuse('GET /api/other', at('2026-10-14T10:00:59Z'))).toHaveLength(1);
    const next = tally.refuse(R, at('2026-10-14T10:01:00Z'));
    expect(next.map((r) => [r.action, r.target])).toEqual([
      [`${R} 403`, '2 more in 2026-10-14T10:00Z'],
      [`${R} 403`, 'not registered for the control plane'],
    ]);
  });

  it('stops giving rows past the daily cap, and names the count the next day', () => {
    const tally = new CpRefusalTally();
    let written = 0;
    for (let i = 0; i < CP_REFUSAL_ROWS_PER_DAY + 5; i++) written += tally.refuse(`GET /api/r${String(i)}`, at('2026-10-14T10:00:00Z')).length;
    expect(written).toBe(CP_REFUSAL_ROWS_PER_DAY);
    const tomorrow = tally.refuse(R, at('2026-10-15T00:00:00Z'));
    expect(tomorrow.map((r) => r.target)).toEqual([
      `5 without a row on 2026-10-14: daily cap ${String(CP_REFUSAL_ROWS_PER_DAY)}`,
      'not registered for the control plane',
    ]);
  });
});
