import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { channels } from '../core/observability.js';
import type { Engine } from '../core/engine.js';

/**
 * The engine hands the `memory:store` subscriber a way to ask whether a thread is private.
 * Unit tests pass that predicate in themselves; this one boots a real engine, so a boot that
 * wired a predicate answering "never private" fails here.
 */
describe('memory:store subscriber on a real engine respects private threads', () => {
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  let api: LynoxHTTPApi;
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE'];
  const engineOf = (): Engine => (api as unknown as { engine: Engine }).engine;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-private-late-engine-'));
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = dir;
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    delete process.env['LYNOX_BILLING_TIER'];
    delete process.env['LYNOX_MANAGED_MODE'];
    reloadConfig();
    api = new LynoxHTTPApi();
    await api.init();
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

  it('stores a publish from a public thread and drops one from a private thread', async () => {
    const engine = engineOf();
    const threads = engine.getThreadStore();
    const kl = engine.getKnowledgeLayer();
    if (threads === null || kl === null) throw new Error('fixture: the engine booted without a thread store or knowledge layer');
    threads.createThread('t-public');
    threads.createThread('t-private');
    threads.updateThread('t-private', { skip_extraction: true });

    const publish = (threadId: string, content: string): void => {
      channels.memoryStore.publish({
        namespace: 'knowledge', content, sourceThreadId: threadId, sourceChannel: 'agent',
      });
    };
    // Private first: it starts no later than the public one, so once the public write has
    // landed (and a settle after it), a private write that was not dropped has landed too.
    publish('t-private', 'ZZMARKER the client prefers invoices in CHF.');
    publish('t-public', 'ZZMARKER the client pays within thirty days.');

    // Positive control: the public write lands, so the machinery is live.
    await expect.poll(() => kl.purgeThread('t-public'), { timeout: 10_000 }).toBe(1);
    await new Promise(r => setTimeout(r, 200));
    expect(kl.purgeThread('t-private')).toBe(0);
  }, 60_000);
});
