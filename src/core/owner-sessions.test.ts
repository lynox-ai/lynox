import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('counts two ends through two handles on the same file as two steps', () => {
    const one = new OwnerSessions(edb.getDb());
    const two = new OwnerSessions(edb.getDb());
    one.endAll();
    expect(two.endAll()).toBe(2);
    expect(one.generation()).toBe(2);
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

  it("keeps the generation through the owner's erasure", () => {
    new OwnerSessions(edb.getDb()).endAll();
    edb.deleteAllData();
    expect(new OwnerSessions(edb.getDb()).generation()).toBe(1);
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
