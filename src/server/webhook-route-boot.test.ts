import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LynoxHTTPApi } from './http-api.js';
import { TriggerStore } from '../core/trigger-store.js';
import { InboundEventStore } from '../core/inbound-events.js';
import { mintRouteToken } from '../core/webhook-verifiers.js';
import type { EngineDb } from '../core/engine-db.js';

/**
 * The webhook route inside the real server: where it sits in the request (before auth and before
 * the per-IP limiter), that it exists only with its switch on, and that its token never reaches
 * the request log. The receiver's own cases are in `webhook-receiver.test.ts`.
 */

const SECRET = 'webhook-route-boot-test-secret';
const SHARED = ['boot', 'shared', 'token'].join('-');

let api: LynoxHTTPApi;
let baseUrl: string;
let dataDir: string;
let engineDb: EngineDb;
let token: string;

function rateKeys(): number {
  const counts: unknown = Reflect.get(api, 'rateCounts');
  if (!(counts instanceof Map)) throw new Error('rateCounts is not a Map');
  return counts.size;
}

function post(path: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'x-lynox-webhook-token': SHARED, ...headers }, body });
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'lynox-webhook-boot-'));
  vi.stubEnv('LYNOX_DATA_DIR', dataDir);
  vi.stubEnv('LYNOX_HTTP_SECRET', SECRET);
  vi.stubEnv('LYNOX_ALLOW_PLAIN_HTTP', 'true');
  api = new LynoxHTTPApi();
  await api.init();
  await api.start(0);
  const port = api.boundPort;
  if (port === undefined) throw new Error('server is not bound after start()');
  baseUrl = `http://127.0.0.1:${String(port)}`;
  const engine: unknown = Reflect.get(api, 'engine');
  const db = (engine as { getEngineDb(): EngineDb | null }).getEngineDb();
  if (db === null) throw new Error('engine has no engine.db');
  engineDb = db;
  new TriggerStore(engineDb).upsert({
    id: 'wh1',
    title: 'Hook',
    description: '',
    source: 'webhook',
    effect: 'run_workflow',
    conditionJson: JSON.stringify({ webhook: { verifier: 'shared-token', shared_token_hash: createHash('sha256').update(SHARED).digest('hex') } }),
    paramsJson: '{}',
    status: 'open',
    enabled: true,
    retryCount: 0,
  });
  const minted = mintRouteToken();
  token = minted.token;
  engineDb.getDb().prepare('UPDATE triggers SET route_token_hash = ? WHERE id = ?').run(minted.hash, 'wh1');
}, 30_000);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('LYNOX_DATA_DIR', dataDir);
  vi.stubEnv('LYNOX_HTTP_SECRET', SECRET);
  vi.stubEnv('LYNOX_ALLOW_PLAIN_HTTP', 'true');
  vi.restoreAllMocks();
});

afterAll(async () => {
  await api.shutdown();
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the webhook route in the server', () => {
  it('with the switch off does not exist: a valid delivery meets auth and nothing is recorded', async () => {
    // Auth's refusal reads like the receiver's, so the answer does not tell whether the switch
    // is on. The ledger does: the same delivery is recorded in the next case.
    vi.stubEnv('LYNOX_FEATURE_INBOUND_WEBHOOKS', '0');
    const res = await post(`/api/webhooks/${token}`, '{"id":1}', { 'content-type': 'text/plain' });
    expect(res.status).toBe(401);
    expect(new InboundEventStore(engineDb).count()).toBe(0);
  });

  it('with the switch on is reached before auth: a verified delivery is recorded without a session', async () => {
    vi.stubEnv('LYNOX_FEATURE_INBOUND_WEBHOOKS', '1');
    const res = await post(`/api/webhooks/${token}`, '{"id":1}', { 'content-type': 'text/plain' });
    expect(res.status).toBe(200);
    expect(new InboundEventStore(engineDb).listByTrigger('wh1')).toHaveLength(1);
  });

  it('also under /api/v1/', async () => {
    vi.stubEnv('LYNOX_FEATURE_INBOUND_WEBHOOKS', '1');
    const res = await post(`/api/v1/webhooks/${token}`, '{"id":2}');
    expect(res.status).toBe(200);
  });

  it('an unknown token creates no per-IP limiter key, even with credentials that pass auth', async () => {
    // With a valid bearer the request would reach the limiter if the route sat below it; an
    // unauthenticated one never does, so it could not tell where the route is.
    vi.stubEnv('LYNOX_FEATURE_INBOUND_WEBHOOKS', '1');
    const before = rateKeys();
    for (let i = 0; i < 3; i++) {
      const res = await post(`/api/webhooks/${mintRouteToken().token}`, 'x', { authorization: `Bearer ${SECRET}` });
      expect(res.status).toBe(401);
    }
    expect(rateKeys()).toBe(before);
    // The control: the same bearer on an ordinary route does create one.
    await fetch(`${baseUrl}/api/threads`, { headers: { authorization: `Bearer ${SECRET}` } });
    expect(rateKeys()).toBeGreaterThan(before);
  });

  it('a path that needed resolving is not admitted, and its token is not logged', async () => {
    vi.stubEnv('LYNOX_FEATURE_INBOUND_WEBHOOKS', '1');
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
    const before = new InboundEventStore(engineDb).count();
    // `fetch` and a URL string resolve the dot segment before sending; a `path` option is sent as written.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: api.boundPort, path: `/api/webhooks/./${token}`, method: 'POST', headers: { 'x-lynox-webhook-token': SHARED } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end('{"id":5}');
    });
    expect(status).toBe(401);
    expect(new InboundEventStore(engineDb).count()).toBe(before);
    const logged = lines.join('');
    // The control: the line was captured, so the absence below is not an empty capture.
    expect(logged).toContain('webhooks/<redacted>');
    expect(logged).not.toContain(token);
  });

  it('never writes the token to the request log', async () => {
    vi.stubEnv('LYNOX_FEATURE_INBOUND_WEBHOOKS', '1');
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    });
    await post(`/api/webhooks/${token}`, '{"id":3}');
    await post(`/api/webhooks/${token}x`, '{"id":4}');
    const logged = lines.join('');
    expect(logged).toContain('/api/webhooks/<redacted>');
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(token.slice(0, 20));
  });
});
