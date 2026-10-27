import { existsSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import type { ContainedConnection } from './containment.js';
import type { ExactMarker } from './exact-clearance.js';

/**
 * The copies in history.db of the two engine.db markers that must survive engine.db
 * (PRD-SHOPIFY-CONTAINMENT-ERASURE, cut S3-E): which threads are contained (`contained`, v40)
 * and whether this instance holds an exact connection (`exact_marker`, v38).
 *
 * engine.db can be set aside and started empty on corruption (`EngineDb` with
 * `onCorruption: 'recreate'`), or come back from a state older than history.db. Both marker
 * reads would then answer "no row", and an empty answer is the open one: the threads would
 * leave containment and the debug paths would open again. The threads themselves live in
 * history.db (`ThreadStore`), so a copy there goes wherever they go. Both tables are written
 * once and never changed (a BEFORE UPDATE trigger), and neither is kept by the owner's erasure.
 *
 * ⚠ If threads ever move into engine.db (S2), these copies lose their reason: they would sit in
 * the file they are meant to outlive. `history-markers.test.ts` fails when the mirror's handle
 * is not the thread store's, or is engine.db's.
 */

/** history.db v70: the two tables. Shared with the migration import, which writes them in a file the boot has not migrated yet. */
export const HISTORY_MARKERS_DDL = `
   CREATE TABLE IF NOT EXISTS contained_threads (
     thread_id     TEXT NOT NULL,
     kind          TEXT NOT NULL,
     connection_id TEXT NOT NULL,
     first_at      TEXT NOT NULL,
     PRIMARY KEY (thread_id, kind, connection_id)
   );
   CREATE TRIGGER IF NOT EXISTS contained_threads_written_once BEFORE UPDATE ON contained_threads
   BEGIN SELECT RAISE(ABORT, 'contained rows are written once'); END;
   CREATE TABLE IF NOT EXISTS exact_marker_mirror (
     id          INTEGER PRIMARY KEY CHECK (id = 1),
     instance_id TEXT NOT NULL,
     first_ok_at TEXT NOT NULL
   );
   CREATE TRIGGER IF NOT EXISTS exact_marker_mirror_written_once BEFORE UPDATE ON exact_marker_mirror
   BEGIN SELECT RAISE(ABORT, 'the exact marker is written once'); END;`;

/** history.db's copy of the thread rows of `contained`. Every method throws when it cannot read or write. */
export class ContainmentMirror {
  constructor(private readonly db: Database.Database) {}

  /** The handle it reads, for the S2 tripwire. */
  get handle(): Database.Database {
    return this.db;
  }

  has(threadId: string): boolean {
    return this.db.prepare('SELECT 1 FROM contained_threads WHERE thread_id = ? LIMIT 1').get(threadId) !== undefined;
  }

  threadIds(threadIds: readonly string[]): Set<string> {
    if (threadIds.length === 0) return new Set();
    const rows = this.db
      .prepare(`SELECT DISTINCT thread_id AS id FROM contained_threads WHERE thread_id IN (${threadIds.map(() => '?').join(',')})`)
      .all(...threadIds) as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  }

  connections(threadId: string): ContainedConnection[] {
    const rows = this.db.prepare('SELECT kind, connection_id FROM contained_threads WHERE thread_id = ?')
      .all(threadId) as { kind: string; connection_id: string }[];
    return rows.map((r) => ({ kind: r.kind, connectionId: r.connection_id }));
  }

  /** Keeps a row already there, and its `first_at`. */
  write(threadId: string, c: ContainedConnection): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO contained_threads (thread_id, kind, connection_id, first_at) VALUES (?, ?, ?, datetime('now'))`,
    ).run(threadId, c.kind, c.connectionId);
  }

  /**
   * Copy every thread row of engine.db's `contained` that is not here yet: the threads contained
   * before this table existed, and those whose mirror write was lost. Idempotent. Answers how
   * many rows it read.
   */
  syncFrom(engineDb: Database.Database): number {
    const rows = engineDb.prepare(
      "SELECT container_id, kind, connection_id FROM contained WHERE container_kind = 'thread'",
    ).all() as { container_id: string; kind: string; connection_id: string }[];
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO contained_threads (thread_id, kind, connection_id, first_at) VALUES (?, ?, ?, datetime('now'))`,
    );
    this.db.transaction(() => {
      for (const r of rows) insert.run(r.container_id, r.kind, r.connection_id);
    })();
    return rows.length;
  }
}

/**
 * What history.db's copy of the exact marker says for this instance: `none`, `own` (written for
 * this instance id) or `foreign` (written for another one, as a history.db from another
 * instance's backup or export carries it).
 */
export type ExactMirrorState = 'none' | 'own' | 'foreign';

/**
 * history.db's copy of the exact marker. Only built on an instance with a control plane: without
 * one the marker is never set (no clearance without a control plane, `exact-clearance.ts`), so a
 * copy found on such an instance came from elsewhere and is neither read nor written.
 */
export class ExactMirror {
  constructor(private readonly db: Database.Database, private readonly instanceId: string) {}

  /** Throws when it cannot read. */
  state(): ExactMirrorState {
    const row = this.db.prepare('SELECT instance_id FROM exact_marker_mirror WHERE id = 1').get() as { instance_id: string } | undefined;
    if (row === undefined) return 'none';
    return row.instance_id === this.instanceId ? 'own' : 'foreign';
  }

  /** Keeps a row already there, a foreign one included. Throws when it cannot write. */
  set(): void {
    this.db.prepare("INSERT OR IGNORE INTO exact_marker_mirror (id, instance_id, first_ok_at) VALUES (1, ?, datetime('now'))").run(this.instanceId);
  }
}

/** engine.db's own marker (`EngineDb.exactMarkerSet` / `setExactMarker`); both throw when they cannot. */
export interface EngineExactMarker {
  exactMarkerSet(): boolean;
  setExactMarker(): void;
}

/**
 * The marker K2 sets and re-asserts (`ExactClearance`): set in engine.db or, for this instance,
 * in history.db's copy. A foreign copy does not count here: it must not make this instance ask
 * the control plane to record an exact connection it never made ({@link exactHeldAtBoot} holds
 * it instead). Setting writes engine.db first, which alone decides the clearance; the copy after
 * it is logged when it fails, and the next boot's {@link syncExactMarker} writes it.
 */
export function exactMarkerOf(engine: EngineExactMarker, mirror: ExactMirror | null): ExactMarker {
  return {
    isSet: () => engine.exactMarkerSet() || (mirror !== null && mirror.state() === 'own'),
    set: () => {
      engine.setExactMarker();
      try {
        mirror?.set();
      } catch (err) {
        process.stderr.write(`[lynox] exact marker: the copy in history.db could not be written (${err instanceof Error ? err.message : String(err)}); the next boot writes it\n`);
      }
    },
  };
}

/**
 * Whether the debug paths stay off this boot: the marker is held ({@link exactMarkerOf}, read
 * fail-closed), or history.db carries another instance's copy. Fail-closed for the copy as well:
 * one that cannot be read counts as held.
 */
export function exactHeldAtBoot(held: boolean, mirror: ExactMirror | null): boolean {
  if (held || mirror === null) return held;
  try {
    return mirror.state() === 'foreign';
  } catch {
    return true;
  }
}

/**
 * The boot's copy in both directions: engine.db's marker into history.db (an instance that set it
 * before the copy existed), and this instance's copy back into an engine.db that lost it. A
 * foreign copy is written nowhere: it holds the debug paths for the boot and is logged. Never
 * throws: a copy that fails is logged and the reads stay fail-closed.
 */
export function syncExactMarker(engine: EngineExactMarker, mirror: ExactMirror | null): void {
  if (mirror === null) return;
  try {
    const state = mirror.state();
    if (state === 'foreign') {
      process.stderr.write('[lynox] exact marker: history.db carries the marker of another instance; debug paths stay off, nothing is written\n');
      return;
    }
    const inEngine = engine.exactMarkerSet();
    if (inEngine && state === 'none') mirror.set();
    if (!inEngine && state === 'own') engine.setExactMarker();
  } catch (err) {
    process.stderr.write(`[lynox] exact marker: the boot copy failed (${err instanceof Error ? err.message : String(err)})\n`);
  }
}

/** The boot's copy of engine.db's thread rows into history.db. Never throws: a copy that fails is logged, and the reads still take engine.db's rows. */
export function syncContainmentMirror(mirror: ContainmentMirror | null, engineDb: Database.Database | null): void {
  if (mirror === null || engineDb === null) return;
  try {
    mirror.syncFrom(engineDb);
  } catch (err) {
    process.stderr.write(`[lynox] containment: the boot copy into history.db failed (${err instanceof Error ? err.message : String(err)})\n`);
  }
}

/**
 * Whether the data dir's files hold the exact marker for this instance: engine.db's, or
 * history.db's copy written for `instanceId`. A file that exists but cannot be read counts as
 * held. Read by the migration import before it replaces the files.
 */
export function exactHeldInFiles(engineDbPath: string, historyDbPath: string, instanceId: string | null): boolean {
  if (rowInFile(engineDbPath, 'SELECT 1 FROM exact_marker WHERE id = 1', [], 'exact_marker')) return true;
  if (instanceId === null) return false;
  return rowInFile(historyDbPath, 'SELECT 1 FROM exact_marker_mirror WHERE id = 1 AND instance_id = ?', [instanceId], 'exact_marker_mirror');
}

function rowInFile(path: string, query: string, params: readonly string[], table: string): boolean {
  if (!existsSync(path)) return false;
  let db: Database.Database | null = null;
  try {
    db = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
    return db.prepare(query).get(...params) !== undefined;
  } catch (err) {
    return !(err instanceof Error && err.message === `no such table: ${table}`);
  } finally {
    try { db?.close(); } catch { /* read-only handle */ }
  }
}

/**
 * Write the exact marker into a database file the boot has not opened yet: engine.db's
 * (`exact_marker`, the v38 table) or history.db's copy for `instanceId`. Each table is created
 * if the file predates it, with the schema its migration creates. Throws when it cannot.
 */
export function writeExactMarkerInFile(path: string, store: 'engine.db' | 'history.db', instanceId: string | null): void {
  if (store === 'history.db' && instanceId === null) return;
  const db = new BetterSqlite3(path, { fileMustExist: true });
  try {
    if (store === 'engine.db') {
      db.exec('CREATE TABLE IF NOT EXISTS exact_marker (id INTEGER PRIMARY KEY CHECK (id = 1), first_ok_at TEXT NOT NULL);');
      db.prepare("INSERT OR IGNORE INTO exact_marker (id, first_ok_at) VALUES (1, datetime('now'))").run();
    } else {
      db.exec(HISTORY_MARKERS_DDL);
      new ExactMirror(db, instanceId!).set();
    }
  } finally {
    db.close();
  }
}
