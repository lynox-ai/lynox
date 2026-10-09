import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import type { ThreadStore } from '../core/thread-store.js';
import type { KnowledgeStore } from '../core/knowledge-store.js';
import type { KnowledgeLayer } from '../core/knowledge-layer.js';

/**
 * Switching private mode on removes what the conversation already put into memory — both
 * stores, through the route, on a real engine.
 *
 * The UI says "this chat is kept out of memory", and people switch it on AFTER the sensitive
 * part was said. Until this, the switch reaped the legacy memories and left every durable
 * entry the thread had produced: `source_thread_id` is a soft reference, nothing cascades,
 * and the store had no delete keyed on it. A real engine because the two stores are reached
 * through different objects, and a mocked route test can only check that a method was called,
 * not that the entry is gone.
 */
describe('PATCH /api/threads/:id { skip_extraction: true } purges the thread from memory (real engine)', () => {
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

  function engineOf(): {
    getThreadStore: () => ThreadStore | null;
    getKnowledgeStore: () => KnowledgeStore | null;
    getKnowledgeLayer: () => KnowledgeLayer | null;
  } {
    return (api as unknown as { engine: ReturnType<typeof engineOf> }).engine;
  }

  function stores(): { ts: ThreadStore; ks: KnowledgeStore; kl: KnowledgeLayer } {
    const e = engineOf();
    const ts = e.getThreadStore();
    const ks = e.getKnowledgeStore();
    const kl = e.getKnowledgeLayer();
    if (!ts || !ks || !kl) throw new Error('fixture: a store is missing — is LYNOX_DURABLE_MEMORY_ENABLED set?');
    return { ts, ks, kl };
  }

  async function setPrivate(threadId: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}/api/threads/${threadId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ skip_extraction: true }),
    });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }

  /** One thread with a durable entry in each status that holds text, plus a legacy memory. */
  function seedThread(threadId: string): { durable: string[]; legacy: string } {
    const { ts, ks, kl } = stores();
    ts.createThread(threadId, { title: `chat ${threadId}` });
    const active = ks.write({ text: `Jana Reber lives in Bern (${threadId})`, sourceChannel: 'user', sourceUntrusted: false, sourceThreadId: threadId });
    const queued = ks.write({ text: `Jana Reber earns 9000 (${threadId})`, sourceChannel: 'agent', sourceUntrusted: true, sourceThreadId: threadId });
    const legacy = kl.getDb().createMemory({
      text: `Jana Reber has two children (${threadId})`, namespace: 'knowledge',
      scopeType: 'global', scopeId: '', sourceThreadId: threadId, embedding: [0.1, 0.2, 0.3],
    });
    return { durable: [active.id, queued.id], legacy };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-private-purge-'));
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    // Off by default; without it `getKnowledgeStore()` is null and the durable half of this
    // file would pass for a reason that has nothing to do with the purge.
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

  it('removes the thread\'s durable entries and legacy memories, and leaves another thread\'s alone', async () => {
    const { ks, kl } = stores();
    const priv = seedThread('t-private');
    const other = seedThread('t-other');
    // Positive control: the seeds are there before the switch.
    for (const id of [...priv.durable, ...other.durable]) expect(ks.getEntry(id)).not.toBeNull();
    expect(kl.getDb().getMemoryIdsByThread('t-private')).toEqual([priv.legacy]);

    const { status, body } = await setPrivate('t-private');

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    for (const id of priv.durable) expect(ks.getEntry(id)).toBeNull();
    expect(kl.getDb().getMemoryIdsByThread('t-private')).toEqual([]);
    for (const id of other.durable) expect(ks.getEntry(id)).not.toBeNull();
    expect(kl.getDb().getMemoryIdsByThread('t-other')).toEqual([other.legacy]);
  });

  it('a failed durable purge answers 500 with the stored state — never "ok" while the facts remain', async () => {
    const { ts, ks } = stores();
    const seeded = seedThread('t-durable-fails');
    vi.spyOn(ks, 'deleteByThread').mockImplementation(() => { throw new Error('disk I/O error'); });

    const { status, body } = await setPrivate('t-durable-fails');

    expect(status).toBe(500);
    expect(body['skip_extraction']).toBe(true);
    expect(String(body['error'])).toContain('could not all be removed');
    expect(body['failed']).toEqual(['durable knowledge: disk I/O error']);
    // The flag itself is stored: future writes stay off whatever the purge did.
    expect(ts.getThread('t-durable-fails')?.skip_extraction).toBe(1);
    // And the legacy half still ran — one failing store does not skip the other.
    expect(stores().kl.getDb().getMemoryIdsByThread('t-durable-fails')).toEqual([]);
    for (const id of seeded.durable) expect(ks.getEntry(id)).not.toBeNull();
  });

  it('a profile line that cannot be removed answers 500 — never "ok" over a copy that keeps loading', async () => {
    const { ks } = stores();
    const line = 'Jana Reber prefers calls after 18:00';
    ks.setBlockContent('profile', line);
    const seeded = ks.write({ text: line, sourceChannel: 'user', sourceUntrusted: false, sourceThreadId: 't-block-fails' });
    stores().ts.createThread('t-block-fails', { title: 'chat t-block-fails' });
    vi.spyOn(ks, 'setBlockContent').mockImplementation(() => { throw new Error('disk full'); });

    const { status, body } = await setPrivate('t-block-fails');

    expect(status).toBe(500);
    expect(body['failed']).toEqual(['durable knowledge: disk full']);
    expect(ks.getBlock('profile')?.content).toContain(line);
    expect(ks.getEntry(seeded.id)).not.toBeNull(); // kept, so switching again can finish the job
  });

  it('a failed legacy purge answers 500 too, and the durable half still runs', async () => {
    const { ks, kl } = stores();
    const seeded = seedThread('t-legacy-fails');
    vi.spyOn(kl, 'purgeThread').mockImplementation(() => { throw new Error('mirror parity loss'); });

    const { status, body } = await setPrivate('t-legacy-fails');

    expect(status).toBe(500);
    expect(body['failed']).toEqual(['memories: mirror parity loss']);
    for (const id of seeded.durable) expect(ks.getEntry(id)).toBeNull();
  });
});
