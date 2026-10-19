import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import type { ArtifactStore } from '../core/artifact-store.js';

/**
 * The gallery route (`POST /api/artifacts`, what "save to gallery" in the chat calls) refuses content
 * that holds only the engine's placeholder for an already saved document with 422 and writes
 * nothing. Real content, also a larger document that quotes the placeholder, is saved as before.
 * On a booted engine, because the store has to be the one the route uses.
 */
describe('POST /api/artifacts with the placeholder (real engine)', () => {
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY'];
  const saved: Record<string, string | undefined> = {};
  let api: LynoxHTTPApi | undefined;
  let baseUrl: string;
  let dir: string | undefined;

  const store = (): ArtifactStore => (api as unknown as { engine: { getArtifactStore: () => ArtifactStore } }).engine.getArtifactStore();

  async function post(body: Record<string, unknown>): Promise<{ status: number; text: string }> {
    const res = await fetch(`${baseUrl}/api/artifacts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-artifact-route-'));
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

  const PLACEHOLDER = '[evicted after successful save — 5251 chars. The artifact is persisted; its id and file path are in the tool result below. read_file that path if you need the content again.]';

  it('is refused with 422, as a new artifact and as an update, and nothing is written', async () => {
    const before = store().list().length;
    const refused = await post({ title: 'Pitch', content: PLACEHOLDER });
    expect(refused.status).toBe(422);
    expect(refused.text).toContain('This is the placeholder the assistant keeps for an already saved document, not the document. Nothing was saved.');
    expect(store().list()).toHaveLength(before);

    const doc = store().save({ title: 'Pitch', content: '<h1>Pitch</h1>' });
    expect((await post({ id: doc.id, title: 'Pitch', content: PLACEHOLDER })).status).toBe(422);
    expect(store().get(doc.id)?.content).toBe('<h1>Pitch</h1>');
  }, 60_000);

  it('control: a larger document that quotes the placeholder is saved', async () => {
    const quoting = `<h1>About the save bug</h1><p>The chat showed: ${PLACEHOLDER}</p>${'<p>Details.</p>'.repeat(200)}`;
    const ok = await post({ title: 'Bug report', content: quoting });
    expect(ok.status).toBe(201);
    expect(store().list().some((a) => a.title === 'Bug report')).toBe(true);
  }, 60_000);

  it('control: real content is saved', async () => {
    const ok = await post({ title: 'Plan', content: '<h1>Plan</h1>' });
    expect(ok.status).toBe(201);
    expect(store().list().some((a) => a.title === 'Plan')).toBe(true);
  }, 60_000);
});
