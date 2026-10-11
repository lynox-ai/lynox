import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LynoxHTTPApi } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import type { MandateEnds } from '../core/mandate-ends.js';
import type { WebPushNotificationChannel } from '../integrations/push/web-push-channel.js';
import type { RequestPrincipal } from '../core/request-principal.js';

/**
 * A mandate's push subscription ends with its grant (PRD customer-granted-operator-access §3.13
 * B3) — measured on a real engine, through the channel the server builds and the store of grant
 * ends the engine keeps. The channel's own tests feed it a liveness function; this one checks
 * that the server hands it the engine's.
 */
describe('push subscription and the end of a grant (real engine)', () => {
  // Built at RUNTIME: a key-shaped literal in a fixture is what the commit-time secret
  // scan looks for, and this repo is public.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  let api: LynoxHTTPApi;
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'LYNOX_BILLING_TIER', 'LYNOX_MANAGED_MODE'];

  const pushOf = (): WebPushNotificationChannel => {
    const p = (api as unknown as { pushChannel: WebPushNotificationChannel | null }).pushChannel;
    if (p === null) throw new Error('fixture: no push channel');
    return p;
  };
  const endsOf = (): MandateEnds => {
    const e = (api as unknown as { engine: { getMandateEnds: () => MandateEnds | null } }).engine.getMandateEnds();
    if (e === null) throw new Error('fixture: no store of grant ends');
    return e;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-push-mandate-'));
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

  it('keeps a live grant\'s subscription, and the engine\'s revocation ends it', () => {
    const nowS = Math.floor(Date.now() / 1000);
    const eva: RequestPrincipal = { kind: 'mandate', email: 'eva@example.invalid', mandateId: 'TEST-MANDATE-1', mandateExp: nowS + 3600 };
    // What every verified request of the mandate does: record the end its cookie carries.
    endsOf().record(eva, nowS);
    expect(pushOf().subscribe('https://push.example/eva', 'p256dh', 'auth', eva)).toBe('ok');
    expect(pushOf().subscriptionCount(eva)).toBe(1);
    endsOf().revoke('TEST-MANDATE-1');
    expect(pushOf().subscriptionCount(eva)).toBe(0);
    expect(pushOf().addedBy('https://push.example/eva')).toBeUndefined();
  });

  it('refuses a mandate whose grant the engine never recorded', () => {
    const unknown: RequestPrincipal = { kind: 'mandate', email: 'max@example.invalid', mandateId: 'TEST-MANDATE-UNSEEN' };
    expect(pushOf().subscribe('https://push.example/max', 'p256dh', 'auth', unknown)).toBe('no_grant');
  });

  it('subscribes through the route with a mandate\'s cookie, and the grant\'s end ends it', async () => {
    await api.start(0);
    const addr = (api as unknown as { server: import('node:http').Server | null }).server?.address();
    if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('fixture: no port');
    const { loginSession } = await import('../../packages/web-ui/src/lib/server/auth.js');
    const cookie = loginSession(SECRET, {
      kind: 'mandate', email: 'ida@example.invalid', display: 'IDA', mandate_id: 'TEST-MANDATE-3',
      mandate_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    })?.token;
    if (cookie === undefined) throw new Error('fixture: no mandate cookie');
    const endpoint = 'https://fcm.googleapis.com/fcm/send/ida';
    const res = await fetch(`http://127.0.0.1:${String(addr.port)}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `lynox_session=${cookie}` },
      body: JSON.stringify({ subscription: { endpoint, keys: { p256dh: 'p256dh', auth: 'auth' } } }),
    });
    // No record step in the test: the request itself records the end the cookie carries.
    expect(res.status).toBe(201);
    expect(pushOf().addedBy(endpoint)).toEqual({ created_by: 'mandate:ida@example.invalid' });
    endsOf().revoke('TEST-MANDATE-3');
    expect(pushOf().subscriptionCount()).toBe(0);
    expect(pushOf().addedBy(endpoint)).toBeUndefined();
  });

  it('counts every mandate as ended when the engine keeps no store of grant ends', () => {
    const engine = (api as unknown as { engine: { _mandateEnds: MandateEnds | null } }).engine;
    const kept = engine._mandateEnds;
    const nowS = Math.floor(Date.now() / 1000);
    const lea: RequestPrincipal = { kind: 'mandate', email: 'lea@example.invalid', mandateId: 'TEST-MANDATE-4', mandateExp: nowS + 3600 };
    endsOf().record(lea, nowS);
    engine._mandateEnds = null;
    try {
      expect(pushOf().subscribe('https://push.example/lea', 'p256dh', 'auth', lea)).toBe('no_grant');
    } finally {
      engine._mandateEnds = kept;
    }
    expect(pushOf().subscribe('https://push.example/lea', 'p256dh', 'auth', lea)).toBe('ok');
  });
});
