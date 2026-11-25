import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import { EngineDb } from './engine-db.js';
import { RETENTION_ACTION } from './audit-retention.js';
import { _resetErrorEgress, reduceErrorTextForProcess } from './error-egress.js';
import type { LynoxConfig } from '../types/index.js';

/**
 * The actor trail is wired at engine boot: the tool context every agent and the HTTP routes
 * read carries a log over the engine's own engine.db. A unit test that hands the log in
 * itself cannot see this, so it is measured on a booted engine (shape of
 * mandate-tool-lock.test.ts).
 */
describe('Engine boot — the actor trail is wired', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const saved = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string | undefined): void => {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  };

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    saved.clear();
    _resetErrorEgress();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    reloadConfig();
  });

  it('gives the tool context a log that writes into the engine\'s engine.db', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-audit-boot-'));
    dirs.push(dir);
    for (const k of ['LYNOX_VAULT_KEY', 'LYNOX_MANAGED_INSTANCE_ID']) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    const log = engine.getAuditLog();
    expect(log).not.toBeNull();
    log!.record({ principal: { kind: 'mandate', email: 'recipient@example.invalid' }, action: 'boot check', phase: 'attempt', correlationId: 'c-boot' });
    const rows = engine.getEngineDb()!.getDb().prepare('SELECT correlation_id FROM audit_log').all() as Array<{ correlation_id: string }>;
    expect(rows.map(r => r.correlation_id)).toEqual(['c-boot']);
  });

  it('deletes the rows past their time when it starts, without waiting for the hourly sweep', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-audit-boot-'));
    dirs.push(dir);
    for (const k of ['LYNOX_VAULT_KEY', 'LYNOX_MANAGED_INSTANCE_ID']) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    reloadConfig();
    const before = new EngineDb(); // the same file the engine opens (LYNOX_DATA_DIR)
    const insert = before.getDb().prepare("INSERT INTO audit_log (ts, actor_kind, actor_email, action, phase, correlation_id) VALUES (?, 'mandate', 'helper@example.invalid', 'GET /api/inbox/items', 'read', ?)");
    insert.run(new Date(Date.now() - 400 * 24 * 60 * 60_000).toISOString(), 'c-old');
    insert.run(new Date(Date.now() - 60_000).toISOString(), 'c-young');
    before.close();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    const rows = engine.getEngineDb()!.getDb().prepare('SELECT correlation_id, action FROM audit_log ORDER BY id').all() as Array<{ correlation_id: string; action: string }>;
    expect(rows.map((r) => r.correlation_id === 'c-young' ? 'c-young' : r.action)).toEqual(['c-young', RETENTION_ACTION]);
  });

  describe('the health word follows the sweep the engine ran', () => {
    const DAY = 24 * 60 * 60_000;
    /** Boots on an engine.db prepared by `seed`, and collects what the boot wrote to stderr. */
    const bootOn = async (seed: (db: ReturnType<EngineDb['getDb']>) => void): Promise<{ engine: Engine; stderr: string }> => {
      const dir = mkdtempSync(join(tmpdir(), 'lynox-audit-boot-'));
      dirs.push(dir);
      for (const k of ['LYNOX_VAULT_KEY', 'LYNOX_MANAGED_INSTANCE_ID']) setEnv(k, undefined);
      setEnv('LYNOX_DATA_DIR', dir);
      reloadConfig();
      const before = new EngineDb();
      seed(before.getDb());
      before.close();
      const lines: string[] = [];
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; });
      const engine = new Engine({} as LynoxConfig);
      engines.push(engine);
      try { await engine.init(); } finally { spy.mockRestore(); }
      return { engine, stderr: lines.join('') };
    };
    const oldPoll = (db: ReturnType<EngineDb['getDb']>, ts: string): void => {
      db.prepare("INSERT INTO audit_log (ts, actor_kind, actor_email, action, phase, correlation_id) VALUES (?, 'mandate', 'helper@example.invalid', 'GET /api/runs/active', 'read', 'c-poll')").run(ts);
    };

    it('says ok while the boot sweep folds a backlog it has not finished', async () => {
      // Ten past days, seven folded per sweep: three stay single and past the stall bound.
      const { engine } = await bootOn((db) => { for (let d = 40; d < 50; d++) oldPoll(db, new Date(Date.now() - d * DAY).toISOString()); });
      const db = engine.getEngineDb()!.getDb();
      expect(db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE poll_count IS NOT NULL').get()).toEqual({ n: 7 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE poll_count IS NULL').get()).toEqual({ n: 3 });
      expect(engine.getAuditRetentionState()).toBe('ok');
    });

    it('says stalled when the boot sweep was refused a day; with the error text reduced, the line keeps the SQLite code and drops the text', async () => {
      reduceErrorTextForProcess();
      const { engine, stderr } = await bootOn((db) => {
        // Foldable, but younger than the stall bound: only the refusal can say stalled.
        oldPoll(db, new Date(Date.now() - 31 * DAY).toISOString());
        db.exec("CREATE TRIGGER refuse_day_rows BEFORE INSERT ON audit_log WHEN NEW.poll_count IS NOT NULL BEGIN SELECT RAISE(ABORT, 'refused by test'); END;");
      });
      expect(engine.getAuditRetentionState()).toBe('stalled');
      expect(stderr).toMatch(/AUDIT_FOLD_REFUSED day=\S+ \(.*code=SQLITE_CONSTRAINT_TRIGGER\)/);
      expect(stderr).not.toContain('refused by test');
    });

    it('says ok right after boot even when the wall clock jumps hours ahead', async () => {
      const { engine } = await bootOn(() => undefined);
      const jump = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60 * 60_000);
      try {
        expect(engine.getAuditRetentionState()).toBe('ok');
      } finally {
        jump.mockRestore();
      }
    });

    it('says nothing once the engine is shut down, rather than stalled', async () => {
      const { engine } = await bootOn(() => undefined);
      expect(engine.getAuditRetentionState()).toBe('ok');
      await engine.shutdown();
      expect(engine.getAuditRetentionState()).toBeUndefined();
    });

    it('says stalled when a later sweep throws after a good one', async () => {
      const { engine } = await bootOn(() => undefined);
      expect(engine.getAuditRetentionState()).toBe('ok');
      const db = engine.getEngineDb()!.getDb();
      db.prepare("INSERT INTO audit_log (ts, actor_kind, actor_email, action, phase, correlation_id) VALUES (?, 'mandate', 'helper@example.invalid', 'GET /api/inbox/items', 'read', 'c-old')")
        .run(new Date(Date.now() - 400 * DAY).toISOString());
      db.exec("CREATE TRIGGER refuse_marks BEFORE INSERT ON audit_log WHEN NEW.actor_kind = 'retention' BEGIN SELECT RAISE(ABORT, 'refused by test'); END;");
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        (engine as unknown as { _sweepAuditLog(): void })._sweepAuditLog();
      } finally {
        spy.mockRestore();
      }
      expect(engine.getAuditRetentionState()).toBe('stalled');
    });

    it('says stalled when the boot sweep could not delete, and logs the SQLite code', async () => {
      const { engine, stderr } = await bootOn((db) => {
        db.prepare("INSERT INTO audit_log (ts, actor_kind, actor_email, action, phase, correlation_id) VALUES (?, 'mandate', 'helper@example.invalid', 'GET /api/inbox/items', 'read', 'c-old')")
          .run(new Date(Date.now() - 400 * DAY).toISOString());
        db.exec("CREATE TRIGGER refuse_marks BEFORE INSERT ON audit_log WHEN NEW.actor_kind = 'retention' BEGIN SELECT RAISE(ABORT, 'refused by test'); END;");
      });
      expect(engine.getAuditRetentionState()).toBe('stalled');
      expect(stderr).toMatch(/audit log retention sweep failed \(.*code=SQLITE_CONSTRAINT_TRIGGER\)/);
    });
  });

  it('finds every tool of the booted registry that writes outside classified', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-audit-boot-'));
    dirs.push(dir);
    for (const k of ['LYNOX_VAULT_KEY', 'LYNOX_MANAGED_INSTANCE_ID']) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    reloadConfig();
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    const entries = engine.getRegistry().getEntries();
    expect(entries.length).toBeGreaterThan(20);
    const unclassified = entries
      .filter(e => e.destructive?.mode === 'external' && typeof e.outwardWrite !== 'function')
      .map(e => e.definition.name);
    expect(unclassified, 'declare outwardWrite on each tool that changes data outside').toEqual([]);
    // The filter is not empty by accident: the http writer is in the registry and declares it.
    expect(entries.find(e => e.definition.name === 'http_request')?.outwardWrite).toBeTypeOf('function');
  });
});
