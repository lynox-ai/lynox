import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { readDurableKnowledgeForDebug } from './http-api.js';
import { EngineDb } from '../core/engine-db.js';
import { SubjectStore } from '../core/subject-store.js';
import { KnowledgeStore } from '../core/knowledge-store.js';

type EngineArg = Parameters<typeof readDurableKnowledgeForDebug>[0];

/**
 * The debug export's durable-knowledge lists are capped at 200, so they could not say how
 * many entries there are, of which status, or since when. `status_counts` does, scoped like
 * the lists: active entries over the whole store, every status for the exported thread.
 * Checked here against a real store with more rows than the cap, in every status, and with
 * another thread's queue that must stay out.
 */
describe('debug export: durable-knowledge status counts (real store)', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  const make = (): { ks: KnowledgeStore; engine: EngineDb } => {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-dk-counts-'));
    dirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    return { ks: new KnowledgeStore(engine, new SubjectStore(engine)), engine };
  };
  const engineOf = (ks: KnowledgeStore): EngineArg => ({ getKnowledgeStore: () => ks }) as unknown as EngineArg;

  it('counts active entries over the whole store, and every status for this thread, past the 200 the lists stop at', () => {
    const { ks } = make();
    const ACTIVE = 205;
    // Captured in no thread: they count towards the store's total, not this thread's.
    for (let i = 0; i < ACTIVE; i++) ks.write({ text: `fact number ${i}`, sourceChannel: 'ui', sourceUntrusted: false });
    // This thread: two queued, one of them then declined, one retired.
    const mine = [0, 1].map(i => ks.write({ text: `queued here ${i}`, sourceChannel: 'mail', sourceUntrusted: true, sourceThreadId: 'this-thread' }));
    ks.reviewEntry(mine[0]!.id, 'reject');
    const retired = ks.write({ text: 'retired here', sourceChannel: 'ui', sourceUntrusted: false, sourceThreadId: 'this-thread' });
    ks.retireEntry(retired.id, 'user_asserted');
    const keptHere = [0, 1].map(i => ks.write({ text: `kept here ${i}`, sourceChannel: 'ui', sourceUntrusted: false, sourceThreadId: 'this-thread' }));
    // ANOTHER thread's queue and declined entry: they must not show up, not even as numbers.
    const theirs = [0, 1, 2].map(i => ks.write({ text: `queued elsewhere ${i}`, sourceChannel: 'mail', sourceUntrusted: true, sourceThreadId: 'other-thread' }));
    ks.reviewEntry(theirs[0]!.id, 'reject');
    // Every row above was written in the same second; spread two active rows apart so the
    // range has two distinct ends to get wrong.
    const db = (ks as unknown as { db: Database.Database }).db;
    const activeIds = (db.prepare("SELECT id FROM knowledge_entries WHERE status = 'active' ORDER BY rowid LIMIT 2").all() as Array<{ id: string }>).map(r => r.id);
    db.prepare('UPDATE knowledge_entries SET created_at = ? WHERE id = ?').run('2026-01-02 03:04:05', activeIds[0]);
    db.prepare('UPDATE knowledge_entries SET created_at = ? WHERE id = ?').run('2027-06-07 08:09:10', activeIds[1]);
    db.prepare('UPDATE knowledge_entries SET created_at = ? WHERE id = ?').run('2026-03-03 00:00:00', keptHere[0]!.id);
    db.prepare('UPDATE knowledge_entries SET created_at = ? WHERE id = ?').run('2026-04-04 00:00:00', keptHere[1]!.id);

    const block = readDurableKnowledgeForDebug(engineOf(ks), 'this-thread');

    expect(block.entries_shown, 'precondition: the list is capped').toBe(200);
    expect(block.status_counts).not.toBeNull();
    const all = block.status_counts!.active_all_threads;
    expect(all.count).toBe(ACTIVE + 2);
    expect(all.first_created_at).toBe('2026-01-02 03:04:05');
    expect(all.last_created_at).toBe('2027-06-07 08:09:10');
    const here = block.status_counts!.this_thread;
    expect(here.pending_review.count).toBe(1);
    expect(here.rejected.count).toBe(1);
    expect(here.superseded.count).toBe(1);
    expect(here.active.count, 'only the two captured here').toBe(2);
    expect(here.active.first_created_at).toBe('2026-03-03 00:00:00');
    expect(here.active.last_created_at).toBe('2026-04-04 00:00:00');
    expect(block.error).toBeUndefined();
  });

  it('reports a status with no rows as 0, not as missing', () => {
    const { ks } = make();
    ks.write({ text: 'only one fact', sourceChannel: 'ui', sourceUntrusted: false, sourceThreadId: 't' });
    const c = readDurableKnowledgeForDebug(engineOf(ks), 't').status_counts!;
    expect(c.this_thread.active.count).toBe(1);
    expect(c.this_thread.rejected).toEqual({ count: 0, first_created_at: null, last_created_at: null });
    expect(Object.keys(c.this_thread).sort()).toEqual(['active', 'pending_review', 'rejected', 'superseded']);
  });

  it('a count that cannot be read says so, and keeps the readable entries', () => {
    const { ks } = make();
    ks.write({ text: 'a readable fact', sourceChannel: 'ui', sourceUntrusted: false });
    vi.spyOn(ks, 'statusSummary').mockImplementation(() => { throw new Error('database is locked'); });
    const block = readDurableKnowledgeForDebug(engineOf(ks), 't');
    expect(block.status_counts).toBeNull();
    expect(block.error).toBe('status counts unreadable');
    expect(block.entries).toHaveLength(1);
  });

  it('has no counts when the instance has no durable-knowledge store', () => {
    const block = readDurableKnowledgeForDebug(({ getKnowledgeStore: () => null }) as unknown as EngineArg, 't');
    expect(block.available).toBe(false);
    expect(block.status_counts).toBeNull();
  });
});
