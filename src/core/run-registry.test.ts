import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { RunRegistry } from './run-registry.js';

/** Fresh SQLite with just the active_runs schema the registry depends on.
 * Mirrors migration v34. */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.prepare(`CREATE TABLE active_runs (
    run_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running'
      CHECK(status IN ('running','awaiting_input','done','error','interrupted')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_activity TEXT NOT NULL DEFAULT (datetime('now')),
    last_event_seq INTEGER NOT NULL DEFAULT 0,
    last_persisted_seq INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  db.prepare(`CREATE INDEX idx_active_runs_thread ON active_runs(thread_id)`).run();
  return db;
}

describe('RunRegistry', () => {
  let db: Database.Database;
  let reg: RunRegistry;

  beforeEach(() => { db = makeDb(); reg = new RunRegistry(db); });
  afterEach(() => { db.close(); });

  it('start registers a running run that getActive returns', () => {
    reg.start('thread-1', 'run-1');
    const active = reg.getActive();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ run_id: 'run-1', thread_id: 'thread-1', status: 'running' });
  });

  it('start replaces a prior row for the same thread (retry of an interrupted run)', () => {
    reg.start('thread-1', 'run-1');
    reg.sweepInterrupted(); // run-1 now interrupted
    expect(reg.getByRunId('run-1')?.status).toBe('interrupted');
    // The user retries → a fresh run for the same thread must replace the old row.
    reg.start('thread-1', 'run-2');
    const active = reg.getActive();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ run_id: 'run-2', status: 'running' });
    expect(reg.getByRunId('run-1')).toBeUndefined();
  });

  it('two different threads each keep their own live run', () => {
    reg.start('thread-1', 'run-1');
    reg.start('thread-2', 'run-2');
    expect(reg.getActive()).toHaveLength(2);
  });

  it('touch updates seqs, COALESCE keeps existing when null', () => {
    reg.start('thread-1', 'run-1');
    reg.touch('run-1', { lastEventSeq: 5, lastPersistedSeq: 3 });
    expect(reg.getByRunId('run-1')).toMatchObject({ last_event_seq: 5, last_persisted_seq: 3 });
    // A bare activity bump (no seqs) must not clobber the stored seqs.
    reg.touch('run-1');
    expect(reg.getByRunId('run-1')).toMatchObject({ last_event_seq: 5, last_persisted_seq: 3 });
    // A partial update advances only the provided seq.
    reg.touch('run-1', { lastEventSeq: 9 });
    expect(reg.getByRunId('run-1')).toMatchObject({ last_event_seq: 9, last_persisted_seq: 3 });
  });

  it('remove drops the run from the registry', () => {
    reg.start('thread-1', 'run-1');
    reg.remove('run-1');
    expect(reg.getActive()).toHaveLength(0);
    expect(reg.getByRunId('run-1')).toBeUndefined();
  });

  it('sweepInterrupted flips live runs to interrupted and returns the count', () => {
    reg.start('thread-1', 'run-1');
    reg.start('thread-2', 'run-2');
    const swept = reg.sweepInterrupted();
    expect(swept).toBe(2);
    expect(reg.getActive().every((r) => r.status === 'interrupted')).toBe(true);
    // Idempotent: a second sweep finds nothing still live.
    expect(reg.sweepInterrupted()).toBe(0);
  });

  it('getActive returns interrupted runs (client surfaces them as banner+retry)', () => {
    reg.start('thread-1', 'run-1');
    reg.sweepInterrupted();
    const active = reg.getActive();
    expect(active).toHaveLength(1);
    expect(active[0]?.status).toBe('interrupted');
  });
});
