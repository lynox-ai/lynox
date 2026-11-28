/**
 * A bulk run reaches its host through the client the worker builds for it (`bulkClientFactory`):
 * a fresh run, a run resumed after a halt and a run picked up again after a restart all take this
 * one path. The credential attach it makes carries the instance network policy, because a store
 * token refresh that attach starts goes out under that policy (`store-token-refresh.ts`).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Engine } from './engine.js';
import type { NotificationRouter } from './notification-router.js';

const hold = vi.hoisted(() => ({
  attachStores: [] as unknown[],
  clientOpts: null as null | { attach: (url: string, headers: Record<string, string>, method: string, out: object) => Promise<unknown> },
}));

vi.mock('./bulk-external.js', async (orig) => ({
  ...(await orig<typeof import('./bulk-external.js')>()),
  parseBulkContract: () => ({}),
  externalClient: (opts: NonNullable<typeof hold.clientOpts>) => { hold.clientOpts = opts; return {}; },
}));
vi.mock('./bulk-external-writer.js', async (orig) => ({
  ...(await orig<typeof import('./bulk-external-writer.js')>()),
  bulkRunContract: () => ({}),
}));
vi.mock('../tools/builtin/http.js', async (orig) => ({
  ...(await orig<typeof import('../tools/builtin/http.js')>()),
  attachStoredCredential: async (_u: string, _h: unknown, _w: boolean, stores: unknown) => { hold.attachStores.push(stores); return null; },
}));

import { WorkerLoop } from './worker-loop.js';

describe('the client a bulk run sends through', () => {
  it('hands the instance network policy to the credential attach', async () => {
    const policy = { networkPolicy: 'deny-all' as const, allowedHosts: new Set(['x.example']), allowedWildcards: ['*.w.example'], enforceHttps: true };
    const engine = {
      getApiStore: () => ({ checkRateLimit: () => null }),
      getSecretStore: () => ({ resolve: () => null }),
      getToolContext: () => ({ ...policy, containment: null }),
      getAuditLog: () => null,
    } as unknown as Engine;
    const loop = new WorkerLoop(engine, { hasChannels: () => false, notify: async () => undefined } as unknown as NotificationRouter, 60_000);
    const factory = await (loop as unknown as { bulkClientFactory(): Promise<(run: object) => unknown> }).bulkClientFactory();
    expect(factory({ id: 'run-1', targetSystem: 'http:acme.myshopify.com', contractJson: '{}', delegatedPlanner: null })).not.toBeNull();
    await hold.clientOpts!.attach('https://acme.myshopify.com/admin/api/2025-10/graphql.json', {}, 'POST', {});
    expect(hold.attachStores).toHaveLength(1);
    const { hostPolicy } = hold.attachStores[0] as { hostPolicy: typeof policy };
    expect(hostPolicy.networkPolicy).toBe('deny-all');
    expect(hostPolicy.allowedHosts).toBe(policy.allowedHosts);
    expect(hostPolicy.allowedWildcards).toEqual(['*.w.example']);
    expect(hostPolicy.enforceHttps).toBe(true);
    loop.stop();
  });
});
