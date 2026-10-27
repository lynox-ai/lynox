/**
 * history.db's copies of the two engine.db markers (`history-markers.ts`, cut S3-E): the tables
 * on a fresh and an upgraded history.db, written once; containment read as the union of both
 * records, so a thread stays contained when engine.db comes back empty or older; the exact
 * marker held from either file, a foreign copy held but never written, and an instance without
 * a control plane that neither reads nor writes the copy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { EngineDb } from './engine-db.js';
import { RunHistory } from './run-history.js';
import { BulkLedger, type PlannedTarget } from './bulk-ledger.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { Containment, containThreadFrom, containedThreads, threadIsContained } from './containment.js';
import {
  ContainmentMirror, EXACT_MARKER_DDL, ExactMirror, exactHeldAtBoot, exactHeldInFiles, exactMarkerOf, syncContainmentMirror,
  syncExactMarker, writeExactMarkerInFile,
} from './history-markers.js';
import { errorTextReduced, reduceErrorTextForProcess, _resetErrorEgress } from './error-egress.js';
import { ExactClearance } from './exact-clearance.js';
import { exactMarkerOnDisk, isExactHeld } from './exact-debug-refusal.js';
import { generateBriefing } from './project.js';
import { compose } from './data-boundary.js';

const SHOP = { kind: 'api', connectionId: 'shop-acme' } as const;
const targets = (): PlannedTarget[] => [0, 1].map((i) => ({ key: `k${String(i)}`, before: { absent: false, value: `v${String(i)}` }, after: `w${String(i)}` }));
const CP_ENV = {
  LYNOX_MANAGED_CONTROL_PLANE_URL: 'https://cp.example.invalid',
  LYNOX_MANAGED_INSTANCE_ID: 'inst-1',
  LYNOX_HTTP_SECRET: 's',
};

let dir: string;
let engineDb: EngineDb;
let history: RunHistory;
let mirror: ContainmentMirror;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-history-markers-'));
  engineDb = new EngineDb(join(dir, 'engine.db'), '');
  history = new RunHistory(join(dir, 'history.db'));
  mirror = new ContainmentMirror(history.getDb());
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  try { engineDb.close(); } catch { /* closed by the test */ }
  try { history.close(); } catch { /* closed by the test */ }
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** engine.db as the corruption path leaves it: an empty one in its place. */
function freshEngineDb(): EngineDb {
  engineDb.close();
  rmSync(join(dir, 'engine.db'), { force: true });
  rmSync(join(dir, 'engine.db-wal'), { force: true });
  rmSync(join(dir, 'engine.db-shm'), { force: true });
  engineDb = new EngineDb(join(dir, 'engine.db'), '');
  return engineDb;
}

describe('the tables (history.db v70)', () => {
  it('exist on a fresh history.db and refuse every UPDATE', () => {
    const db = history.getDb();
    mirror.write('t1', SHOP);
    new ExactMirror(db, 'inst-1').set();
    expect(() => db.prepare("UPDATE contained_threads SET first_at = 'x'").run()).toThrow(/written once/);
    expect(() => db.prepare("UPDATE exact_marker_mirror SET instance_id = 'other'").run()).toThrow(/written once/);
    expect(new ExactMirror(db, 'inst-1').state()).toBe('own');
  });

  it('are created on a history.db upgraded from v69', () => {
    const path = join(dir, 'old-history.db');
    new RunHistory(path).close();
    const raw = new Database(path);
    raw.exec('DELETE FROM schema_version WHERE version >= 70; DROP TABLE contained_threads; DROP TABLE exact_marker_mirror;');
    raw.close();
    const upgraded = new RunHistory(path);
    try {
      expect((upgraded.getDb().prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v).toBe(70);
      new ContainmentMirror(upgraded.getDb()).write('t1', SHOP);
      expect(new ContainmentMirror(upgraded.getDb()).has('t1')).toBe(true);
    } finally {
      upgraded.close();
    }
  });
});

describe('containment survives an engine.db that comes back empty', () => {
  it('a thread contained before stays contained, in every read', () => {
    new Containment(engineDb.getDb(), mirror).contain({ kind: 'thread', id: 't1' }, SHOP);
    const after = new Containment(freshEngineDb().getDb(), mirror);
    expect(after.isContained({ threadId: 't1' })).toBe(true);
    expect(after.containedThreadIds(['t1', 't2'])).toEqual(new Set(['t1']));
    expect(threadIsContained(after, 't1')).toBe(true);
    expect(containedThreads(after, ['t1', 't2'])).toEqual(new Set(['t1']));
    // The control: a thread never contained is not.
    expect(after.isContained({ threadId: 't2' })).toBe(false);
  });

  it('without the copy the same thread reads as not contained (the gap this closes)', () => {
    new Containment(engineDb.getDb(), null).contain({ kind: 'thread', id: 't1' }, SHOP);
    expect(new Containment(freshEngineDb().getDb(), null).isContained({ threadId: 't1' })).toBe(false);
  });

  it('a reader of a thread contained only in the copy is contained for its connections', () => {
    new Containment(engineDb.getDb(), mirror).contain({ kind: 'thread', id: 'src' }, SHOP);
    const after = new Containment(freshEngineDb().getDb(), mirror);
    const threads = { getThread: () => ({ skip_extraction: 1 }), updateThread: () => undefined } as never;
    containThreadFrom({ containment: after, threadStore: threads }, 'src', 'reader');
    expect(after.isContained({ threadId: 'reader' })).toBe(true);
    expect(mirror.connections('reader')).toEqual([SHOP]);
    expect(engineDb.getDb().prepare("SELECT kind, connection_id FROM contained WHERE container_id = 'reader'").all())
      .toEqual([{ kind: 'api', connection_id: 'shop-acme' }]);
  });

  it('a bulk run planned from a thread contained only in the copy is contained', () => {
    new Containment(engineDb.getDb(), mirror).contain({ kind: 'thread', id: 'planner' }, SHOP);
    const fresh = freshEngineDb();
    const plan = { createdBy: 'planner', planningThread: 'planner', principal: OWNER_PRINCIPAL, targetSystem: 'workspace', scope: 'mem', targets: targets() } as const;
    const run = new BulkLedger(fresh, mirror).recordDryRun({ ...plan, targets: targets() });
    expect(new Containment(fresh.getDb(), null).isContained({ bulkRunId: run.id })).toBe(true);
    // The control: the same plan without the copy leaves the run uncontained.
    const other = new BulkLedger(fresh, null).recordDryRun({ ...plan, targets: targets() });
    expect(new Containment(fresh.getDb(), null).isContained({ bulkRunId: other.id })).toBe(false);
  });

  it('a copy that cannot be read counts as contained', () => {
    const broken = { has: () => { throw new Error('disk I/O error'); }, threadIds: () => { throw new Error('disk I/O error'); } } as unknown as ContainmentMirror;
    const c = new Containment(engineDb.getDb(), broken);
    expect(c.isContained({ threadId: 't9' })).toBe(true);
    expect(c.containedThreadIds(['t9'])).toEqual(new Set(['t9']));
  });

  it('writes both records, and `holds` answers false when the copy is missing', () => {
    const c = new Containment(engineDb.getDb(), mirror);
    c.contain({ kind: 'thread', id: 't1' }, SHOP);
    expect(c.holds({ kind: 'thread', id: 't1' }, SHOP)).toBe(true);
    // A row in engine.db alone, as a lost mirror write leaves it.
    engineDb.getDb().prepare("INSERT INTO contained VALUES ('thread', 't2', 'api', 'shop-acme', datetime('now'))").run();
    expect(c.holds({ kind: 'thread', id: 't2' }, SHOP)).toBe(false);
  });

  it('the boot copies engine.db rows into history.db, idempotently, without thread rows', () => {
    engineDb.getDb().prepare("INSERT INTO contained VALUES ('thread', 'old', 'api', 'shop-acme', datetime('now'))").run();
    engineDb.getDb().prepare("INSERT INTO contained VALUES ('bulk_run', 'run-1', 'api', 'shop-acme', datetime('now'))").run();
    syncContainmentMirror(mirror, engineDb.getDb());
    syncContainmentMirror(mirror, engineDb.getDb());
    expect(history.getDb().prepare('SELECT thread_id, kind, connection_id FROM contained_threads').all())
      .toEqual([{ thread_id: 'old', kind: 'api', connection_id: 'shop-acme' }]);
    expect(history.getDb().prepare('SELECT COUNT(*) n FROM threads').get()).toEqual({ n: 0 });
  });
});

describe('without engine.db', () => {
  it('self-host: reads answer from the copy, nothing else is contained, and nothing can be contained', () => {
    mirror.write('t1', SHOP);
    const c = new Containment(null, mirror);
    expect(c.isContained({ threadId: 't1' })).toBe(true);
    expect(c.isContained({ threadId: 't2' })).toBe(false);
    expect(c.containedThreadIds(['t1', 't2'])).toEqual(new Set(['t1']));
    expect(() => c.contain({ kind: 'thread', id: 't3' }, SHOP)).toThrow(/no containment store/);
    expect(() => c.containFromThread('t1', 't3')).toThrow(/no containment store/);
  });

  it('provisioned: every thread counts as contained, as before', () => {
    for (const [k, v] of Object.entries(CP_ENV)) vi.stubEnv(k, v);
    const c = new Containment(null, mirror);
    expect(c.isContained({ threadId: 't2' })).toBe(true);
    expect(c.containedThreadIds(['t2'])).toEqual(new Set(['t2']));
  });
});

describe('the exact marker', () => {
  const own = (): ExactMirror => new ExactMirror(history.getDb(), 'inst-1');

  it('held from history.db\'s copy when engine.db comes back empty, and written back at boot', () => {
    exactMarkerOf(engineDb, own()).set();
    const fresh = freshEngineDb();
    expect(isExactHeld(exactMarkerOf(fresh, own()))).toBe(true);
    expect(isExactHeld(exactMarkerOf(fresh, null))).toBe(false);
    syncExactMarker(fresh, own());
    expect(fresh.exactMarkerSet()).toBe(true);
  });

  it('a marker set before the copy existed is copied at boot', () => {
    engineDb.setExactMarker();
    expect(own().state()).toBe('none');
    syncExactMarker(engineDb, own());
    expect(own().state()).toBe('own');
  });

  it('a foreign copy holds the debug paths but is written nowhere and does not count for the clearance', () => {
    new ExactMirror(history.getDb(), 'other-instance').set();
    const marker = exactMarkerOf(engineDb, own());
    expect(isExactHeld(marker)).toBe(false);
    expect(exactHeldAtBoot(isExactHeld(marker), own())).toBe(true);
    syncExactMarker(engineDb, own());
    expect(engineDb.exactMarkerSet()).toBe(false);
  });

  it('a copy that cannot be read holds', () => {
    const broken = { state: () => { throw new Error('disk I/O error'); } } as unknown as ExactMirror;
    expect(isExactHeld(exactMarkerOf(engineDb, broken))).toBe(true);
    expect(exactHeldAtBoot(false, broken)).toBe(true);
  });

  it('a copy that cannot be written does not refuse the clearance (engine.db decides)', async () => {
    const unwritable = { state: () => 'none', set: () => { throw new Error('disk I/O error'); } } as unknown as ExactMirror;
    const fetchOk = (async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const clearance = new ExactClearance({ url: 'https://cp.example.invalid', instanceId: 'inst-1', secret: 's' }, exactMarkerOf(engineDb, unwritable), { fetch: fetchOk });
    expect(await clearance.ensure()).toEqual({ ok: true });
    expect(engineDb.exactMarkerSet()).toBe(true);
  });
});

describe('the marker read before the stores open (error reporting)', () => {
  const paths = (): { engine: string; history: string } => ({ engine: join(dir, 'engine.db'), history: join(dir, 'history.db') });

  it('managed: held from history.db\'s copy alone', () => {
    expect(exactMarkerOnDisk(paths().engine, { path: paths().history, managed: true })).toBe(false);
    new ExactMirror(history.getDb(), 'inst-1').set();
    expect(exactMarkerOnDisk(paths().engine, { path: paths().history, managed: true })).toBe(true);
  });

  it('self-host: history.db is not read — a copy there, a corrupt file or a missing table keep error reporting on', () => {
    new ExactMirror(history.getDb(), 'someone-else').set();
    expect(exactMarkerOnDisk(paths().engine, { path: paths().history, managed: false })).toBe(false);
    const corrupt = join(dir, 'corrupt-history.db');
    writeFileSync(corrupt, 'not a database at all, but long enough to be read as one '.repeat(100));
    expect(exactMarkerOnDisk(paths().engine, { path: corrupt, managed: false })).toBe(false);
    // The control on the same file: managed reads it, and an unreadable file holds.
    expect(exactMarkerOnDisk(paths().engine, { path: corrupt, managed: true })).toBe(true);
  });

  it('managed: a history.db from before v70 (no table) is not held', () => {
    // A readable history.db without the table, as one from before v70 is.
    const old = join(dir, 'v69-history.db');
    const raw = new Database(old);
    raw.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES (69);');
    raw.close();
    expect(exactMarkerOnDisk(paths().engine, { path: old, managed: true })).toBe(false);
  });
});

describe('the migration import\'s marker helpers', () => {
  it('reads the marker from either file, and only this instance\'s copy', () => {
    const e = join(dir, 'engine.db');
    const h = join(dir, 'history.db');
    expect(exactHeldInFiles(e, h, 'inst-1', true)).toBe(false);
    new ExactMirror(history.getDb(), 'other').set();
    expect(exactHeldInFiles(e, h, 'inst-1', true)).toBe(false);
    engineDb.setExactMarker();
    expect(exactHeldInFiles(e, h, 'inst-1', true)).toBe(true);
  });

  it('writes the marker into files that predate its tables', () => {
    const e = join(dir, 'bundle-engine.db');
    const h = join(dir, 'bundle-history.db');
    new Database(e).close();
    new Database(h).close();
    writeExactMarkerInFile(e, 'engine.db', 'inst-1');
    writeExactMarkerInFile(h, 'history.db', 'inst-1');
    const opened = new EngineDb(e, '');
    try { expect(opened.exactMarkerSet()).toBe(true); } finally { opened.close(); }
    const raw = new Database(h, { readonly: true });
    try { expect(raw.prepare('SELECT instance_id FROM exact_marker_mirror').get()).toEqual({ instance_id: 'inst-1' }); } finally { raw.close(); }
  });
});

describe('review round 1 (17693caa)', () => {
  it('the table the import writes into a staged engine.db is the one v38 creates', () => {
    const viaHelper = join(dir, 'helper-engine.db');
    new Database(viaHelper).close();
    writeExactMarkerInFile(viaHelper, 'engine.db', 'inst-1');
    const sqlOf = (path: string): string => {
      const raw = new Database(path, { readonly: true });
      try { return (raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'exact_marker'").get() as { sql: string }).sql.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')'); } finally { raw.close(); }
    };
    expect(sqlOf(viaHelper)).toBe(sqlOf(join(dir, 'engine.db')));
    expect(EXACT_MARKER_DDL).toContain('CREATE TABLE IF NOT EXISTS exact_marker');
  });

  it('provisioned with the control-plane env incomplete: any copy holds, none is written', () => {
    const noId = new ExactMirror(history.getDb(), null);
    expect(noId.state()).toBe('none');
    expect(() => noId.set()).toThrow(/no instance id/);
    new ExactMirror(history.getDb(), 'inst-1').set();
    expect(noId.state()).toBe('foreign');
    expect(exactHeldAtBoot(isExactHeld(exactMarkerOf(engineDb, noId)), noId)).toBe(true);
    syncExactMarker(engineDb, noId);
    expect(engineDb.exactMarkerSet()).toBe(false);
  });

  it('error text: without engine.db a keyed sink still reduces when the process holds', () => {
    const c = new Containment(null, mirror);
    expect(errorTextReduced(c, { threadId: 'never-contained' })).toBe(false);
    reduceErrorTextForProcess();
    try {
      expect(errorTextReduced(c, { threadId: 'never-contained' })).toBe(true);
      // The control: with engine.db the container decides, as before.
      expect(errorTextReduced(new Containment(engineDb.getDb(), mirror), { threadId: 'never-contained' })).toBe(false);
    } finally {
      _resetErrorEgress();
    }
  });

  it('`canContain` is false exactly without engine.db', () => {
    expect(new Containment(engineDb.getDb(), mirror).canContain).toBe(true);
    expect(new Containment(null, mirror).canContain).toBe(false);
  });
});

describe('review round 2 (627ed667)', () => {
  it('the briefing skips a run without a chat on a provisioned instance without engine.db, as with no store', () => {
    vi.stubEnv('LYNOX_MANAGED_INSTANCE_ID', 'inst-1');
    history.insertRun({ taskText: 'Task without a chat', modelTier: 'balanced', modelId: 'm', contextId: '/my/project' });
    const briefed = (c: Containment): string => { const b = generateBriefing('/my/project', history, c); return b ? compose([b]) : ''; };
    expect(briefed(new Containment(null, mirror))).not.toContain('Task without a chat');
    // The control: with engine.db the run is briefed, as before.
    expect(briefed(new Containment(engineDb.getDb(), mirror))).toContain('Task without a chat');
  });

  it('a staged copy whose checkpoint cannot finish is refused, not left with the row in its -wal', () => {
    const path = join(dir, 'staged-engine.db');
    const prep = new Database(path);
    prep.pragma('journal_mode = WAL');
    prep.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);');
    prep.close();
    // A reader inside a transaction holds the WAL: TRUNCATE cannot finish.
    const reader = new Database(path);
    reader.exec('BEGIN');
    reader.prepare('SELECT * FROM t').all();
    try {
      expect(() => writeExactMarkerInFile(path, 'engine.db', 'inst-1')).toThrow(/checkpoint/);
    } finally {
      reader.exec('COMMIT');
      reader.close();
    }
  });

  it('the import reads the copy of a provisioned instance whose control-plane env is incomplete', () => {
    new ExactMirror(history.getDb(), 'inst-1').set();
    const e = join(dir, 'engine.db');
    const h = join(dir, 'history.db');
    expect(exactHeldInFiles(e, h, null, true)).toBe(true);
    // Self-host: not read.
    expect(exactHeldInFiles(e, h, null, false)).toBe(false);
  });
});
