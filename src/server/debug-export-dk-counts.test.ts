import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readDurableKnowledgeForDebug } from './http-api.js';
import { EngineDb } from '../core/engine-db.js';
import { SubjectStore } from '../core/subject-store.js';
import { KnowledgeStore } from '../core/knowledge-store.js';

type EngineArg = Parameters<typeof readDurableKnowledgeForDebug>[0];

/**
 * The debug export's durable-knowledge lists are capped at 200 and the queue list covers the
 * exported thread only, so neither could say how many entries the store holds, of which
 * status, or since when. `status_counts` does, over the whole store; checked here against a
 * real store with more rows than the cap, in every status.
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

  it('counts every status over the whole store, past the 200 the lists stop at', () => {
    const { ks } = make();
    const ACTIVE = 205;
    for (let i = 0; i < ACTIVE; i++) ks.write({ text: `fact number ${i}`, sourceChannel: 'ui', sourceUntrusted: false });
    // Queued in ANOTHER thread: the thread-scoped queue list cannot see them; the count must.
    const queued = [0, 1, 2].map(i => ks.write({ text: `queued ${i}`, sourceChannel: 'mail', sourceUntrusted: true, sourceThreadId: 'other-thread' }));
    ks.reviewEntry(queued[0]!.id, 'reject');
    const retired = ks.write({ text: 'retired fact', sourceChannel: 'ui', sourceUntrusted: false });
    ks.retireEntry(retired.id, 'user_asserted');

    const block = readDurableKnowledgeForDebug(engineOf(ks), 'this-thread');

    expect(block.entries_shown, 'precondition: the list is capped').toBe(200);
    expect(block.pending_shown, 'precondition: the queue list sees this thread only').toBe(0);
    expect(block.status_counts).not.toBeNull();
    const c = block.status_counts!;
    expect(c.active.count).toBe(ACTIVE);
    expect(c.pending_review.count).toBe(2);
    expect(c.rejected.count).toBe(1);
    expect(c.superseded.count).toBe(1);
    // The range is real: both ends present, in order, for a status with rows.
    expect(c.active.first_created_at).not.toBeNull();
    expect(c.active.first_created_at! <= c.active.last_created_at!).toBe(true);
    expect(block.error).toBeUndefined();
  });

  it('reports a status with no rows as 0, not as missing', () => {
    const { ks } = make();
    ks.write({ text: 'only one fact', sourceChannel: 'ui', sourceUntrusted: false });
    const c = readDurableKnowledgeForDebug(engineOf(ks), 't').status_counts!;
    expect(c.active.count).toBe(1);
    expect(c.rejected).toEqual({ count: 0, first_created_at: null, last_created_at: null });
    expect(Object.keys(c).sort()).toEqual(['active', 'pending_review', 'rejected', 'superseded']);
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
