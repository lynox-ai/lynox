/**
 * The worker tick tells the owner when a store's refresh token runs out soon
 * (`store-token-refresh.ts › claimStoreReconnectHints`): through the notification router, only
 * with a channel, and once per expiry.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerLoop } from './worker-loop.js';
import { RunHistory } from './run-history.js';
import { TaskManager } from './task-manager.js';
import type { Engine } from './engine.js';
import type { NotificationRouter } from './notification-router.js';
import type { ApiProfile } from './api-store.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2027, 0, 10, 12);

const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const c of closers.splice(0).reverse()) c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function boot(channelsOn: boolean): { loop: WorkerLoop; notify: ReturnType<typeof vi.fn>; saved: ApiProfile[] } {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-store-hint-'));
  dirs.push(dir);
  const history = new RunHistory(join(dir, 'history.db'));
  closers.push(() => { try { history.close(); } catch { /* twice is fine */ } });
  const manager = new TaskManager(history);
  let profile: ApiProfile = {
    id: 'shop-acme', name: 'Acme', base_url: 'https://acme.myshopify.com', description: 'd',
    auth: { type: 'oauth2', oauth: { preset_id: 'shopify', preset_params: { shop: 'acme' }, client_id_key: 'SHOPIFY_CLIENT_ID', client_secret_key: 'SHOPIFY_CLIENT_SECRET' } },
    oauth_grant: { origin: 'callback', state: 'connected', store_binding: 'b', refresh_expires_at: T0 + 5 * DAY },
  } as ApiProfile;
  const saved: ApiProfile[] = [];
  const apiStore = {
    getAll: () => [profile],
    save: (p: ApiProfile) => { saved.push(p); profile = p; return { ok: true }; },
  };
  const engine = {
    getTaskManager: () => manager,
    getToolContext: () => ({ containment: null }),
    getPromptStore: () => null,
    getRunHistory: () => history,
    getSecretStore: () => null,
    getBulkLedger: () => null,
    getUserConfig: () => ({}),
    workerRunModelOverride: () => ({}),
    escalateToUser: () => null,
    getEngineDb: () => null,
    getMandateEnds: () => null,
    getApiStore: () => apiStore,
    config: { language: 'de' },
  } as unknown as Engine;
  const notify = vi.fn().mockResolvedValue(undefined);
  const router = { hasChannels: () => channelsOn, notify } as unknown as NotificationRouter;
  const loop = new WorkerLoop(engine, router, 60_000);
  closers.push(() => loop.stop());
  return { loop, notify, saved };
}

async function tick(loop: WorkerLoop): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  await loop.tick();
  await new Promise((r) => setImmediate(r));
}

const hints = (notify: ReturnType<typeof vi.fn>): { title: string; body: string }[] =>
  (notify.mock.calls.map((c) => c[0]) as { title: string; body: string }[]).filter((m) => m.title.startsWith('Shop'));

describe('the worker tick and the store reconnect hint', () => {
  it('tells the owner once, through the router, when a store\'s access runs out within 14 days', async () => {
    const p = boot(true);
    await tick(p.loop);
    expect(hints(p.notify)).toEqual([expect.objectContaining({ title: 'Shop bald neu verbinden', body: expect.stringContaining('acme.myshopify.com läuft am 15. Januar 2027 ab') as string })]);
    await tick(p.loop);
    expect(hints(p.notify)).toHaveLength(1);
  });

  it('without a channel tells nothing and claims nothing, so a channel added later still gets it', async () => {
    const p = boot(false);
    await tick(p.loop);
    expect(hints(p.notify)).toEqual([]);
    expect(p.saved).toEqual([]);
  });
});
