import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import type { ToolContext } from '../core/tool-context.js';
import type { IMemory } from '../types/memory.js';
import type { ArtifactStore } from '../core/artifact-store.js';
import type { RunHistory } from '../core/run-history.js';

/**
 * A memory or artifact write the UI makes from a chat names it (`source_thread_id`), and from a
 * contained chat it is refused with 409 before anything is written. Without the field, or from
 * another chat, it goes through. On a booted engine, because the record has to be wired where
 * the routes look for it.
 */
describe('memory and artifact writes from a contained chat (real engine)', () => {
  // Built at runtime, never a literal: a key-shaped fixture string is what the commit-time
  // secret scan looks for, and this repo is public.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY'];
  const saved: Record<string, string | undefined> = {};
  let api: LynoxHTTPApi | undefined;
  let baseUrl: string;
  let dir: string | undefined;

  function engine(): { getToolContext: () => ToolContext; getMemory: () => IMemory | null; getArtifactStore: () => ArtifactStore | null; getRunHistory: () => RunHistory | null } {
    return (api as unknown as { engine: ReturnType<typeof engine> }).engine;
  }

  async function call(method: string, path: string, body: Record<string, unknown>): Promise<{ status: number; text: string }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-contained-writes-'));
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    reloadConfig();
    api = new LynoxHTTPApi();
    await api.init();
    await api.start(0);
    const addr = (api as unknown as { server: Server | null }).server?.address();
    if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${addr.port}`;
    engine().getToolContext().containment!.contain({ kind: 'thread', id: 't-contained' }, { kind: 'api', connectionId: 'shop-acme' });
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

  const REFUSAL = 'Not saved: this chat read data through a store connection, or this engine cannot read whether it did, and what it holds stays in it.';
  const memory = async (): Promise<string> => (await engine().getMemory()!.load('knowledge')) ?? '';

  it('PUT /api/memory/:ns: refused from a contained chat; written without the field or from another chat', async () => {
    const refused = await call('PUT', '/api/memory/knowledge', { content: 'put-from-contained', source_thread_id: 't-contained' });
    expect(refused.status).toBe(409);
    expect(refused.text).toContain(REFUSAL);
    expect(await memory()).not.toContain('put-from-contained');
    expect((await call('PUT', '/api/memory/knowledge', { content: 'put-plain' })).status).toBe(200);
    expect(await memory()).toContain('put-plain');
    expect((await call('PUT', '/api/memory/knowledge', { content: 'put-free', source_thread_id: 't-free' })).status).toBe(200);
    expect(await memory()).toContain('put-free');
  }, 60_000);

  it('POST /api/memory/:ns/append: the same', async () => {
    expect((await call('POST', '/api/memory/knowledge/append', { text: 'append-from-contained', source_thread_id: 't-contained' })).status).toBe(409);
    expect(await memory()).not.toContain('append-from-contained');
    expect((await call('POST', '/api/memory/knowledge/append', { text: 'append-plain' })).status).toBe(200);
    expect((await call('POST', '/api/memory/knowledge/append', { text: 'append-free', source_thread_id: 't-free' })).status).toBe(200);
    const after = await memory();
    expect(after).toContain('append-plain');
    expect(after).toContain('append-free');
  }, 60_000);

  it('PATCH /api/memory/:ns: the same', async () => {
    expect((await call('PUT', '/api/memory/knowledge', { content: 'line-one' })).status).toBe(200);
    expect((await call('PATCH', '/api/memory/knowledge', { old_content: 'line-one', new_content: 'patched-contained', source_thread_id: 't-contained' })).status).toBe(409);
    expect(await memory()).toContain('line-one');
    expect(await memory()).not.toContain('patched-contained');
    expect((await call('PATCH', '/api/memory/knowledge', { old_content: 'line-one', new_content: 'patched-free', source_thread_id: 't-free' })).status).toBe(200);
    expect(await memory()).toContain('patched-free');
  }, 60_000);

  it('POST /api/artifacts: refused from a contained chat; saved without the field or from another chat', async () => {
    const titles = (): string[] => engine().getArtifactStore()!.list().map((a) => a.title);
    const refused = await call('POST', '/api/artifacts', { title: 'from-contained', content: 'x', source_thread_id: 't-contained' });
    expect(refused.status).toBe(409);
    expect(refused.text).toContain(REFUSAL);
    expect(titles()).not.toContain('from-contained');
    expect((await call('POST', '/api/artifacts', { title: 'plain', content: 'x' })).status).toBe(201);
    expect((await call('POST', '/api/artifacts', { title: 'from-free', content: 'x', source_thread_id: 't-free' })).status).toBe(201);
    expect(titles()).toEqual(expect.arrayContaining(['plain', 'from-free']));
  }, 60_000);

  it('the "Fixen" chat context of a run a contained chat started contains the session\'s chat; another run does not (control)', async () => {
    const history = engine().getRunHistory()!;
    const containment = engine().getToolContext().containment!;
    history.insertPipelineRun({ id: 'run-contained', manifestName: 'r', status: 'failed', manifestJson: '{}', originThreadId: 't-contained' });
    history.insertPipelineRun({ id: 'run-free', manifestName: 'r', status: 'failed', manifestJson: '{}', originThreadId: 't-free' });
    const open = async (runId: string): Promise<string> => {
      const created = await call('POST', '/api/sessions', {});
      const { sessionId } = JSON.parse(created.text) as { sessionId: string };
      // No model key in this test: the run stops at the preflight, after the context is resolved.
      await call('POST', `/api/sessions/${sessionId}/run`, { task: 'fix it', context: { kind: 'run', id: runId } });
      return sessionId;
    };
    const reader = await open('run-contained');
    expect(containment.isContained({ threadId: reader })).toBe(true);
    const other = await open('run-free');
    expect(containment.isContained({ threadId: other })).toBe(false);
  }, 60_000);
});
