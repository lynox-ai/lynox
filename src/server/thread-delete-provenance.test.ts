import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type Database from 'better-sqlite3';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import type { ThreadStore } from '../core/thread-store.js';
import type { KnowledgeStore } from '../core/knowledge-store.js';
import type { KnowledgeLayer } from '../core/knowledge-layer.js';

/**
 * Deleting a chat keeps what was learned in it, and marks the source as a deleted chat.
 *
 * Through the route, on a real engine: the durable entries and the legacy memories live in two
 * stores reached through different objects, and a mocked route test can only check that a
 * method was called, not what the rows hold afterwards.
 */
describe('DELETE /api/threads/:id keeps what was learned and marks its source as deleted (real engine)', () => {
  // Built at RUNTIME, never a literal: a key-shaped fixture string is what the commit-time
  // secret scan looks for, and this repo is public.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  const ENV = [
    'LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY',
    'LYNOX_DURABLE_MEMORY_ENABLED', 'LYNOX_SUBJECT_GRAPH_ENABLED',
  ];
  const saved: Record<string, string | undefined> = {};
  let api: LynoxHTTPApi | undefined;
  let baseUrl: string;
  let dir: string | undefined;

  function stores(): { ts: ThreadStore; ks: KnowledgeStore; kl: KnowledgeLayer } {
    const e = (api as unknown as { engine: {
      getThreadStore: () => ThreadStore | null;
      getKnowledgeStore: () => KnowledgeStore | null;
      getKnowledgeLayer: () => KnowledgeLayer | null;
    } }).engine;
    const ts = e.getThreadStore();
    const ks = e.getKnowledgeStore();
    const kl = e.getKnowledgeLayer();
    if (!ts || !ks || !kl) throw new Error('fixture: a store is missing — is LYNOX_DURABLE_MEMORY_ENABLED set?');
    return { ts, ks, kl };
  }

  /** The stores' own connections, for reading the legacy column and planting an earlier stamp. */
  function legacyDb(): Database.Database {
    return (stores().kl.getDb() as unknown as { db: Database.Database }).db;
  }
  function durableDb(): Database.Database {
    return (stores().ks as unknown as { db: Database.Database }).db;
  }

  /** The legacy row's marker. Read off the table: no store method returns this column. */
  function legacyMarker(memoryId: string): string | null | undefined {
    const raw = legacyDb();
    const row = raw.prepare('SELECT source_thread_deleted_at AS at FROM memories WHERE id = ?').get(memoryId) as { at: string | null } | undefined;
    return row === undefined ? undefined : row.at;
  }

  async function deleteChat(threadId: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}/api/threads/${threadId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }

  /** One chat with an active and a queued durable entry, plus a legacy memory. */
  function seedThread(threadId: string): { durable: string[]; legacy: string } {
    const { ts, ks, kl } = stores();
    ts.createThread(threadId, { title: `chat ${threadId}` });
    const active = ks.write({ text: `Walkfalke ships in March (${threadId})`, sourceChannel: 'user', sourceUntrusted: false, sourceThreadId: threadId });
    const queued = ks.write({ text: `Walkfalke budget is 40000 (${threadId})`, sourceChannel: 'agent', sourceUntrusted: true, sourceThreadId: threadId });
    const legacy = kl.getDb().createMemory({
      text: `Walkfalke has two sites (${threadId})`, namespace: 'knowledge',
      scopeType: 'global', scopeId: '', sourceThreadId: threadId, embedding: [0.1, 0.2, 0.3],
    });
    return { durable: [active.id, queued.id], legacy };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-thread-delete-'));
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    // Off by default; without it `getKnowledgeStore()` is null and the durable half of this
    // file would pass for a reason that has nothing to do with the route.
    process.env['LYNOX_DURABLE_MEMORY_ENABLED'] = 'true';
    // Pinned rather than inherited: `process.env` is shared across files in a fork.
    delete process.env['LYNOX_SUBJECT_GRAPH_ENABLED'];
    reloadConfig();
    api = new LynoxHTTPApi();
    await api.init();
    await api.start(0);
    const addr = (api as unknown as { server: Server | null }).server?.address();
    if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 120_000);

  afterAll(async () => {
    try {
      await api?.shutdown();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      reloadConfig();
    }
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('keeps the chat\'s entries and memories, marks them, and leaves another chat\'s unmarked', async () => {
    const { ts, ks, kl } = stores();
    const gone = seedThread('t-deleted');
    const kept = seedThread('t-kept');
    // Positive control: nothing is marked before the delete.
    for (const id of [...gone.durable, ...kept.durable]) expect(ks.getEntry(id)?.sourceThreadDeletedAt).toBeNull();
    expect(legacyMarker(gone.legacy)).toBeNull();

    const { status, body } = await deleteChat('t-deleted');

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(ts.getThread('t-deleted')).toBeUndefined();
    // Kept, with the id, and marked.
    for (const id of gone.durable) {
      const entry = ks.getEntry(id);
      expect(entry?.sourceThreadId).toBe('t-deleted');
      expect(entry?.sourceThreadDeletedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    }
    expect(kl.getDb().getMemoryIdsByThread('t-deleted')).toEqual([gone.legacy]);
    expect(legacyMarker(gone.legacy)).toMatch(/^\d{4}-\d{2}-\d{2} /);
    // Still recallable.
    expect(ks.recall({ query: 'Walkfalke ships in March' }).map(e => e.id)).toContain(gone.durable[0]);
    // The other chat is untouched.
    for (const id of kept.durable) expect(ks.getEntry(id)?.sourceThreadDeletedAt).toBeNull();
    expect(legacyMarker(kept.legacy)).toBeNull();
  });

  it('the access export lists each source\'s wording', async () => {
    const { ks } = stores();
    seedThread('t-export');
    const res = await fetch(`${baseUrl}/api/export`, { headers: { Authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { durable_knowledge?: { sources?: Array<{ threadId: string | null; text: string }> } };
    const mine = (body.durable_knowledge?.sources ?? []).filter(s => s.threadId === 't-export').map(s => s.text);
    expect(mine).toContain('Walkfalke ships in March (t-export)');
    expect(ks.listSourcesMasked().length).toBeGreaterThan(0);
  });

  it('a failed durable marking answers 500 and leaves the chat; the retry marks the rest and keeps the first stamp', async () => {
    const { ts, ks } = stores();
    const seeded = seedThread('t-mark-fails');
    vi.spyOn(ks, 'markThreadDeleted').mockImplementationOnce(() => { throw new Error('disk I/O error'); });

    const first = await deleteChat('t-mark-fails');

    expect(first.status).toBe(500);
    expect(first.body['failed']).toEqual([expect.stringContaining('durable knowledge')]);
    expect(ts.getThread('t-mark-fails')).toBeDefined();
    // Each store is marked on its own: the legacy half went through, the durable half did not.
    expect(legacyMarker(seeded.legacy)).not.toBeNull();
    for (const id of seeded.durable) expect(ks.getEntry(id)?.sourceThreadDeletedAt).toBeNull();
    // An earlier stamp the retry must not move.
    const FIRST = '2000-01-01 00:00:00';
    legacyDb().prepare('UPDATE memories SET source_thread_deleted_at = ? WHERE id = ?').run(FIRST, seeded.legacy);

    const second = await deleteChat('t-mark-fails');

    expect(second.status).toBe(200);
    expect(ts.getThread('t-mark-fails')).toBeUndefined();
    for (const id of seeded.durable) expect(ks.getEntry(id)?.sourceThreadDeletedAt).toMatch(/^\d{4}-/);
    expect(legacyMarker(seeded.legacy)).toBe(FIRST);
  });

  it('a failed legacy marking answers 500 and leaves the chat; the retry keeps the durable first stamp', async () => {
    const { ts, ks, kl } = stores();
    const seeded = seedThread('t-legacy-fails');
    vi.spyOn(kl, 'markThreadDeleted').mockImplementationOnce(() => { throw new Error('database is locked'); });

    const first = await deleteChat('t-legacy-fails');

    expect(first.status).toBe(500);
    expect(first.body['failed']).toEqual([expect.stringContaining('memories')]);
    expect(ts.getThread('t-legacy-fails')).toBeDefined();
    expect(legacyMarker(seeded.legacy)).toBeNull();
    for (const id of seeded.durable) expect(ks.getEntry(id)?.sourceThreadDeletedAt).not.toBeNull();
    const FIRST = '2000-01-01 00:00:00';
    durableDb().prepare('UPDATE knowledge_entries SET source_thread_deleted_at = ? WHERE source_thread_id = ?').run(FIRST, 't-legacy-fails');

    const second = await deleteChat('t-legacy-fails');

    expect(second.status).toBe(200);
    expect(ts.getThread('t-legacy-fails')).toBeUndefined();
    expect(legacyMarker(seeded.legacy)).toMatch(/^\d{4}-/);
    for (const id of seeded.durable) expect(ks.getEntry(id)?.sourceThreadDeletedAt).toBe(FIRST);
  });
});
