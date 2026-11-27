import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { OwnerSessions } from './owner-sessions.js';

describe('OwnerSessions', () => {
  let dir: string;
  let edb: EngineDb;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-owner-sessions-'));
    edb = new EngineDb(join(dir, 'engine.db'));
  });
  afterEach(() => {
    edb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts at generation 0, the one a cookie without a generation counts as, and lets only it in', () => {
    const sessions = new OwnerSessions(edb.getDb());
    expect(sessions.generation()).toBe(0);
    expect(sessions.ended(0)).toBe(false);
    expect(sessions.ended(1)).toBe(true);
  });

  it('moves the generation one on with each end, and refuses an older and a higher one alike', () => {
    const sessions = new OwnerSessions(edb.getDb());
    expect(sessions.endAll()).toBe(1);
    expect(sessions.ended(0)).toBe(true);
    expect(sessions.ended(1)).toBe(false);
    expect(sessions.ended(2)).toBe(true);
    expect(sessions.endAll()).toBe(2);
    expect(sessions.ended(1)).toBe(true);
  });

  it('counts ends through two connections to the same file as two steps, with nothing kept in memory', () => {
    const one = new OwnerSessions(edb.getDb());
    const other = new Database(join(dir, 'engine.db'));
    try {
      const two = new OwnerSessions(other);
      one.endAll();
      expect(two.endAll()).toBe(2);
      expect(one.generation()).toBe(2);
      expect(one.ended(1)).toBe(true);
    } finally {
      other.close();
    }
  });

  it('raises the generation to one handed in, and never lowers it', () => {
    const sessions = new OwnerSessions(edb.getDb());
    sessions.endAll();
    sessions.endAll();
    expect(sessions.raiseTo(1)).toBe(2);
    expect(sessions.raiseTo(7)).toBe(7);
    expect(sessions.ended(2)).toBe(true);
    expect(sessions.endAll()).toBe(8);
  });

  it('reads the generation again from a fresh store and after the database is opened again', () => {
    new OwnerSessions(edb.getDb()).endAll();
    expect(new OwnerSessions(edb.getDb()).generation()).toBe(1);
    edb.close();
    edb = new EngineDb(join(dir, 'engine.db'));
    const reopened = new OwnerSessions(edb.getDb());
    expect(reopened.generation()).toBe(1);
    expect(reopened.ended(0)).toBe(true);
  });

  it('keeps the generation when its migration is played again over a store that already holds one', () => {
    new OwnerSessions(edb.getDb()).raiseTo(7);
    edb.getDb().exec('ALTER TABLE triggers DROP COLUMN last_run_member_notes; DROP INDEX IF EXISTS idx_bulk_runs_superseded; ALTER TABLE bulk_runs DROP COLUMN superseded_by; DELETE FROM schema_version WHERE version >= 74; ALTER TABLE triggers DROP COLUMN last_escalation_chat_kind; ALTER TABLE triggers DROP COLUMN last_escalation_thread_id; ALTER TABLE triggers DROP COLUMN last_escalation_case; ALTER TABLE bulk_targets DROP COLUMN refusal_detail; ALTER TABLE bulk_targets DROP COLUMN target_title;');
    edb.close();
    edb = new EngineDb(join(dir, 'engine.db'));
    // The migration did run again: the database is back at the latest version.
    expect((edb.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(79);
    const sessions = new OwnerSessions(edb.getDb());
    expect(sessions.generation()).toBe(7);
    expect(sessions.ended(0)).toBe(true);
  });

  it("keeps the generation through the owner's erasure", () => {
    new OwnerSessions(edb.getDb()).endAll();
    edb.deleteAllData();
    expect(new OwnerSessions(edb.getDb()).generation()).toBe(1);
  });
});

describe('OwnerSessions and the copy of the generation beside engine.db', () => {
  let dir: string;
  let mirrorPath: string;
  const open = (file = 'engine.db'): EngineDb => new EngineDb(join(dir, file));
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-owner-sessions-mirror-'));
    mirrorPath = join(dir, 'owner-sessions-generation');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes the copy at open and with every end and raise', () => {
    const edb = open();
    try {
      const sessions = new OwnerSessions(edb.getDb(), { mirrorPath });
      expect(readFileSync(mirrorPath, 'utf8')).toBe('0');
      sessions.endAll();
      expect(readFileSync(mirrorPath, 'utf8')).toBe('1');
      sessions.raiseTo(9);
      expect(readFileSync(mirrorPath, 'utf8')).toBe('9');
    } finally { edb.close(); }
  });

  it('takes the copy when engine.db went back, as a restored or a missing engine.db does', () => {
    const first = open();
    new OwnerSessions(first.getDb(), { mirrorPath }).endAll();
    new OwnerSessions(first.getDb(), { mirrorPath }).endAll();
    first.close();
    // Another engine.db, at generation 0: what a restored backup from before the ends brings.
    const restored = open('restored.db');
    try {
      const sessions = new OwnerSessions(restored.getDb(), { mirrorPath });
      expect(sessions.generation()).toBe(2);
      expect(sessions.ended(0)).toBe(true);
    } finally { restored.close(); }
  });

  it('keeps engine.db when it is ahead of the copy, and ignores a copy that holds no generation', () => {
    const edb = open();
    try {
      new OwnerSessions(edb.getDb()).raiseTo(5);
      writeFileSync(mirrorPath, '3');
      expect(new OwnerSessions(edb.getDb(), { mirrorPath }).generation()).toBe(5);
      expect(readFileSync(mirrorPath, 'utf8')).toBe('5');
      writeFileSync(mirrorPath, 'not a number');
      expect(new OwnerSessions(edb.getDb(), { mirrorPath }).generation()).toBe(5);
      expect(readFileSync(mirrorPath, 'utf8')).toBe('5');
    } finally { edb.close(); }
  });

  it('holds a copy past the clock, at the edge of a safe integer or an hour ahead, to the clock, says so, and ends what engine.db held', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      for (const ahead of [String(Number.MAX_SAFE_INTEGER), String(Date.now() + 60 * 60 * 1000)]) {
        const edb = open(`ahead-${ahead.length}.db`);
        try {
          new OwnerSessions(edb.getDb()).raiseTo(5);
          err.mockClear();
          writeFileSync(mirrorPath, ahead);
          const before = Date.now();
          const sessions = new OwnerSessions(edb.getDb(), { mirrorPath });
          expect(sessions.generation()).toBeGreaterThanOrEqual(before);
          expect(sessions.generation()).toBeLessThanOrEqual(Date.now());
          expect(sessions.ended(5)).toBe(true);
          expect(Number(readFileSync(mirrorPath, 'utf8'))).toBe(sessions.generation());
          expect(err.mock.calls.some(([line]) => String(line).includes('past the clock'))).toBe(true);
        } finally { edb.close(); }
      }
    } finally { err.mockRestore(); }
  });

  it('takes a copy written by something else when it is no later than the clock: one more login, and ends still work after it', () => {
    const edb = open();
    try {
      const before = new OwnerSessions(edb.getDb());
      before.endAll();
      const injected = Date.now() - 1000;
      writeFileSync(mirrorPath, String(injected));
      const sessions = new OwnerSessions(edb.getDb(), { mirrorPath });
      // The session of generation 1 is out; a login mints the injected one, and the next end ends that.
      expect(sessions.ended(1)).toBe(true);
      expect(sessions.ended(injected)).toBe(false);
      expect(sessions.endAll()).toBe(injected + 1);
      expect(sessions.ended(injected)).toBe(true);
    } finally { edb.close(); }
  });

  it('keeps an end that engine.db took when the copy cannot be written, and says so', () => {
    const edb = open();
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // A file where the copy's directory should be: every write of the copy fails.
      writeFileSync(join(dir, 'not-a-dir'), '');
      const sessions = new OwnerSessions(edb.getDb(), { mirrorPath: join(dir, 'not-a-dir', 'owner-sessions-generation') });
      err.mockClear();
      expect(sessions.endAll()).toBe(1);
      expect(new OwnerSessions(edb.getDb()).generation()).toBe(1);
      expect(err.mock.calls.some(([line]) => String(line).includes('could not be written'))).toBe(true);
    } finally { err.mockRestore(); edb.close(); }
  });
});

describe('EngineDb.recreated', () => {
  it('says whether the open set a corrupt file aside, which is when the generation was lost', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-owner-sessions-recreate-'));
    try {
      const file = join(dir, 'engine.db');
      const healthy = new EngineDb(file, undefined, { onCorruption: 'recreate' });
      expect(healthy.recreated).toBe(false);
      healthy.close();
      writeFileSync(file, 'not a database, only text where one should be');
      const fresh = new EngineDb(file, undefined, { onCorruption: 'recreate' });
      expect(fresh.recreated).toBe(true);
      fresh.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the copy of the generation and the tool guard', () => {
  it('refuses the shell tool the copy, as every file the sessions rest on', async () => {
    const { isDangerous } = await import('../tools/permission-guard.js');
    const danger = isDangerous('bash', { command: 'echo 9007199254740991 > ~/.lynox/owner-sessions-generation' }, 'autonomous');
    expect(danger).toContain('lynox secret store');
    expect(danger).toContain('[BLOCKED');
  });
});
