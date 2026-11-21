import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import type { ThreadStore } from '../core/thread-store.js';
import type { KnowledgeStore } from '../core/knowledge-store.js';

/**
 * Switching durable memory off deletes nothing: the entries a chat seeded while it was on stay in
 * engine.db. Private mode and deleting the chat must reach them while it is off, or a chat the
 * owner made private keeps what it said. On a real engine, across boots, because the store that
 * is missing while durable memory is off is the engine's own boot decision.
 */
describe('private mode and chat deletion while durable memory is off (real engine, across boots)', () => {
  // Built at RUNTIME: a key-shaped literal in a fixture is what the commit-time secret scan
  // looks for, and this repo is public.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  const VAULT = `v-${randomBytes(12).toString('hex')}`;
  const ENV = [
    'LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY',
    'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE', 'LYNOX_DURABLE_MEMORY_ENABLED', 'LYNOX_SUBJECT_GRAPH_ENABLED',
  ];
  const saved: Record<string, string | undefined> = {};
  let dir: string;
  let api: LynoxHTTPApi | undefined;
  let baseUrl = '';

  type EngineView = {
    getThreadStore: () => ThreadStore | null;
    getKnowledgeStore: () => KnowledgeStore | null;
  };
  const engine = (): EngineView => (api as unknown as { engine: EngineView }).engine;

  /** Boot an engine on `dir` with durable memory on or off. */
  async function boot(durable: boolean): Promise<void> {
    process.env['LYNOX_DURABLE_MEMORY_ENABLED'] = durable ? 'true' : 'false';
    reloadConfig();
    api = new LynoxHTTPApi();
    await api.init();
    await api.start(0);
    const addr = (api as unknown as { server: Server | null }).server?.address();
    if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${String(addr.port)}`;
  }
  async function stop(): Promise<void> {
    await api?.shutdown();
    api = undefined;
  }
  async function call(method: string, path: string, body?: unknown): Promise<number> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    await res.arrayBuffer();
    return res.status;
  }
  async function exportTexts(): Promise<string[]> {
    const res = await fetch(`${baseUrl}/api/export`, { headers: { Authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { durable_knowledge: { entries: Array<{ text: string }> } };
    return body.durable_knowledge.entries.map((e) => e.text);
  }

  /** With durable memory on: two chats, each seeding one entry. */
  async function seed(): Promise<void> {
    await boot(true);
    const ts = engine().getThreadStore();
    const ks = engine().getKnowledgeStore();
    if (!ts || !ks) throw new Error('fixture: a store is missing');
    ts.createThread('chat-a', { title: 'chat a' });
    ts.createThread('chat-b', { title: 'chat b' });
    ks.write({ text: 'Walkfalke ships in March', sourceChannel: 'user', sourceUntrusted: false, sourceThreadId: 'chat-a' });
    ks.write({ text: 'Nordberg pays monthly', sourceChannel: 'user', sourceUntrusted: false, sourceThreadId: 'chat-b' });
    await stop();
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-private-off-'));
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = VAULT;
    delete process.env['LYNOX_BILLING_TIER'];
    delete process.env['LYNOX_MANAGED_MODE'];
    delete process.env['LYNOX_SUBJECT_GRAPH_ENABLED'];
  });

  afterEach(async () => {
    try {
      await stop();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
      reloadConfig();
    }
  });

  it('private mode while off removes the chat\'s entry: after a boot with it on, neither recall nor the export has it', async () => {
    await seed();

    await boot(false);
    expect(engine().getKnowledgeStore(), 'fixture: no store while it is off').toBeNull();
    expect(await call('PATCH', '/api/threads/chat-a', { skip_extraction: true })).toBe(200);
    await stop();

    await boot(true);
    const ks = engine().getKnowledgeStore()!;
    expect(ks.recall({ query: 'Walkfalke ships' }).map((e) => e.text)).not.toContain('Walkfalke ships in March');
    // The other chat's entry stays: the removal is the private chat's only.
    expect(ks.recall({ query: 'Nordberg pays' }).map((e) => e.text)).toContain('Nordberg pays monthly');
    expect(await exportTexts()).toEqual(['Nordberg pays monthly']);
  }, 120_000);

  it('deleting a chat while off marks its entry as coming from a deleted chat, and keeps it', async () => {
    await seed();

    await boot(false);
    expect(await call('DELETE', '/api/threads/chat-a')).toBe(200);
    await stop();

    await boot(true);
    const ks = engine().getKnowledgeStore()!;
    const sources = ks.listSourcesMasked(10);
    expect(sources.find((s) => s.threadId === 'chat-a')?.threadDeletedAt, 'the deleted chat is marked').not.toBeNull();
    expect(sources.find((s) => s.threadId === 'chat-b')?.threadDeletedAt, 'the other chat is not').toBeNull();
    expect(ks.recall({ query: 'Walkfalke ships' }).map((e) => e.text)).toContain('Walkfalke ships in March');
  }, 120_000);
});
