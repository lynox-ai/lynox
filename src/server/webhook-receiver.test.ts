import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineDb } from '../core/engine-db.js';
import { TriggerStore } from '../core/trigger-store.js';
import { ConnectionStore } from '../core/connection-store.js';
import { InboundEventStore } from '../core/inbound-events.js';
import { MANDATE_TAG_PREFIX } from '../core/request-principal.js';
import { mintRouteToken } from '../core/webhook-verifiers.js';
import { MAX_WAITING_EVENTS, QUEUE_FULL_RETRY_AFTER_S, SHOP_MISMATCH_REASON, WebhookReceiver, isCanonicalRequestPath, redactWebhookPath, webhookRouteToken } from './webhook-receiver.js';

/**
 * The receiver against a real engine database and a real HTTP server, so the order inside a
 * request (token, then body, then signature, then ledger) is measured on the wire.
 */

// Built at run time: the value is a test app secret and must not look like a key in the source.
const APP_SECRET = ['webhook', 'test', 'app', 'secret'].join('-');
const SHOP = 'demo-store';
const SHOP_HOST = `${SHOP}.myshopify.com`;
const FAILURE_LIMIT = 5;
const MAX_BODY = 1024;

let dir: string;
let engine: EngineDb;
let triggers: TriggerStore;
let ledger: InboundEventStore;
let receiver: WebhookReceiver;
let server: Server;
let base: string;
let secretValue: string | null;

function shopifyConnection(id: string, shop = SHOP): void {
  new ConnectionStore(engine).upsert({
    id,
    kind: 'api',
    name: 'Shop',
    subjectId: null,
    direction: 'outbound',
    configJson: JSON.stringify({
      base_url: `https://${shop}.myshopify.com/admin/api/2025-10`,
      auth: { type: 'oauth2', oauth: { preset_id: 'shopify', preset_params: { shop } } },
    }),
    vaultKeys: [],
    status: 'active',
  });
}

/** A webhook trigger reachable under the returned token. */
function webhookTrigger(id: string, opts: {
  spec?: Record<string, unknown>;
  connectionId?: string | null;
  enabled?: boolean;
  status?: string;
  createdBy?: string;
  effect?: 'run_workflow' | 'run_agent' | 'notify';
  source?: 'webhook' | 'cron';
} = {}): string {
  triggers.upsert({
    id,
    title: 'Orders',
    description: '',
    source: opts.source ?? 'webhook',
    effect: opts.effect ?? 'run_workflow',
    conditionJson: JSON.stringify({ webhook: opts.spec ?? { verifier: 'shopify-hmac' } }),
    paramsJson: '{}',
    status: opts.status ?? 'open',
    enabled: opts.enabled ?? true,
    retryCount: 0,
    createdBy: opts.createdBy ?? null,
  });
  const { token, hash } = mintRouteToken();
  engine.getDb().prepare('UPDATE triggers SET route_token_hash = ?, source_connection_id = ? WHERE id = ?')
    .run(hash, opts.connectionId === undefined ? 'shop-a' : opts.connectionId, id);
  return token;
}

function sign(body: string, secret = APP_SECRET): string {
  return createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('base64');
}

async function deliver(token: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/api/webhooks/${token}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-hmac-sha256': sign(body),
      'x-shopify-shop-domain': SHOP_HOST,
      'x-shopify-topic': 'orders/create',
      ...headers,
    },
    body,
  });
}

/**
 * Send headers that announce a body and then send none. A server that reads the body before it
 * answers never answers; one that answers without reading does.
 */
function answerWithoutBody(path: string, contentLength: number): Promise<string> {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), '127.0.0.1');
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no answer without the body: ${data}`)); }, 2000);
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (data.includes('\r\n\r\n')) { clearTimeout(timer); socket.destroy(); resolve(data); }
    });
    socket.on('error', (err) => { clearTimeout(timer); reject(err); });
    socket.write(`POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: ${String(contentLength)}\r\n\r\n`);
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lynox-webhook-'));
  engine = new EngineDb(join(dir, 'engine.db'), '');
  triggers = new TriggerStore(engine);
  ledger = new InboundEventStore(engine);
  const connections = new ConnectionStore(engine);
  secretValue = APP_SECRET;
  shopifyConnection('shop-a');
  // A Shopify profile's shape under another kind: only the kind refuses it.
  connections.upsert({
    id: 'mail-a', kind: 'mail', name: 'Mail', subjectId: null, direction: 'outbound',
    configJson: JSON.stringify({ base_url: `https://${SHOP_HOST}/admin/api/2025-10`, auth: { type: 'oauth2', oauth: { preset_id: 'shopify', preset_params: { shop: SHOP } } } }),
    vaultKeys: [], status: 'active',
  });
  connections.upsert({
    id: 'other-a', kind: 'api', name: 'Other', subjectId: null, direction: 'outbound',
    configJson: JSON.stringify({ base_url: `https://${SHOP_HOST}/admin/api/2025-10`, auth: { type: 'oauth2', oauth: { preset_id: 'bexio' } } }),
    vaultKeys: [], status: 'active',
  });
  receiver = new WebhookReceiver({
    findReceiver: (hash) => triggers.findWebhookReceiver(hash),
    connection: (id) => connections.get(id),
    secret: (name) => (name === 'SHOPIFY_CLIENT_SECRET' ? secretValue : null),
    ledger,
  }, { maxBodyBytes: MAX_BODY, failureLimit: FAILURE_LIMIT });
  server = createServer((req, res) => {
    const token = webhookRouteToken(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (token === null) { res.writeHead(404); res.end(); return; }
    void receiver.handle(req, res, token);
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve(); }); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('not bound');
  base = `http://127.0.0.1:${String(address.port)}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the route shape', () => {
  it('admits exactly one token-shaped segment', () => {
    const { token } = mintRouteToken();
    expect(webhookRouteToken(`/api/webhooks/${token}`)).toBe(token);
    expect(webhookRouteToken(`/api/webhooks/${token}/x`)).toBeNull();
    expect(webhookRouteToken(`/api/webhooks/${token.slice(1)}`)).toBeNull();
    expect(webhookRouteToken(`/api/webhooks/${token}=`)).toBeNull();
    expect(webhookRouteToken('/api/webhooks/')).toBeNull();
    expect(webhookRouteToken(`/api/webhooksx/${token}`)).toBeNull();
  });

  it('redacts whatever follows /webhooks/ in a log line, token-shaped or not', () => {
    const { token } = mintRouteToken();
    expect(redactWebhookPath(`/api/webhooks/${token}?a=1`)).toBe('/api/webhooks/<redacted>?a=1');
    expect(redactWebhookPath(`/api/v1/webhooks/${token.slice(2)}`)).toBe('/api/v1/webhooks/<redacted>');
    expect(redactWebhookPath('/api/threads/abc')).toBe('/api/threads/abc');
  });

  it.each([
    ['a dot segment', (t: string) => `/api/webhooks/./${t}`],
    ['a parent segment', (t: string) => `/api/webhooks/x/../${t}`],
    ['an encoded dot', (t: string) => `/api/webhooks/%2e/${t}`],
    ['backslashes', (t: string) => `/api\\webhooks\\${t}`],
    ['an encoded slash', (t: string) => `/api/webhooks%2F${t}`],
  ])('redacts the token behind %s', (_label, path) => {
    const { token } = mintRouteToken();
    const line = redactWebhookPath(path(token));
    expect(line).not.toContain(token);
    expect(line).toContain('webhooks/<redacted>');
  });

  it('admits only a raw path that needed no resolving', () => {
    const { token } = mintRouteToken();
    const parsed = (raw: string): string => new URL(raw, 'http://localhost').pathname;
    const canonical = `/api/webhooks/${token}`;
    expect(isCanonicalRequestPath(`${canonical}?x=1`, parsed(`${canonical}?x=1`))).toBe(true);
    for (const raw of [`/api/webhooks/./${token}`, `/api/webhooks/x/../${token}`, `/api/webhooks/%2e/${token}`, `/api\\webhooks\\${token}`]) {
      expect(parsed(raw)).toBe(canonical);
      expect(isCanonicalRequestPath(raw, parsed(raw))).toBe(false);
    }
  });
});

describe('a verified delivery', () => {
  it('is recorded once as received, with its evidence headers and without the signature', async () => {
    const token = webhookTrigger('t1');
    const body = JSON.stringify({ id: 1001, total_price: '10.00' });
    const res = await deliver(token, body);
    expect(res.status).toBe(200);
    const rows = ledger.listByTrigger('t1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('received');
    expect(rows[0]!.dedupKey).toBe(`shopify-hmac:sha256:${createHash('sha256').update(body).digest('hex')}`);
    const headers = JSON.parse(rows[0]!.headersJson) as Record<string, string>;
    expect(headers['x-shopify-topic']).toBe('orders/create');
    expect(headers['x-shopify-hmac-sha256']).toBeUndefined();
  });

  it('replayed, starts nothing: the same body is a duplicate, with or without a new webhook id', async () => {
    const token = webhookTrigger('t1');
    const body = JSON.stringify({ id: 1002 });
    expect((await deliver(token, body, { 'x-shopify-webhook-id': 'a' })).status).toBe(200);
    expect((await deliver(token, body, { 'x-shopify-webhook-id': 'b' })).status).toBe(200);
    expect(ledger.count()).toBe(1);
  });

  it('at a second trigger of the same provider starts nothing: the key is instance-wide', async () => {
    const first = webhookTrigger('t1');
    const second = webhookTrigger('t2');
    const body = JSON.stringify({ id: 1003 });
    expect((await deliver(first, body)).status).toBe(200);
    expect((await deliver(second, body)).status).toBe(200);
    expect(ledger.count()).toBe(1);
    expect(ledger.listByTrigger('t2')).toHaveLength(0);
  });

  it('naming another shop is recorded dropped with the reason, so it runs nothing', async () => {
    const token = webhookTrigger('t1');
    const res = await deliver(token, JSON.stringify({ id: 1004 }), { 'x-shopify-shop-domain': 'other-store.myshopify.com' });
    expect(res.status).toBe(200);
    const [row] = ledger.listByTrigger('t1');
    expect(row?.state).toBe('dropped');
    expect(row?.reason).toBe(SHOP_MISMATCH_REASON);
  });

  it('naming its shop in other letter case is its own shop', async () => {
    const token = webhookTrigger('t1');
    expect((await deliver(token, '{"id":1005}', { 'x-shopify-shop-domain': SHOP_HOST.toUpperCase() })).status).toBe(200);
    expect(ledger.listByTrigger('t1')[0]?.state).toBe('received');
  });

  it('with the same bytes under another verifier is a separate event', async () => {
    const shared = ['shared', 'token', 'other'].join('-');
    const hash = createHash('sha256').update(shared).digest('hex');
    const shop = webhookTrigger('t1');
    const other = webhookTrigger('t2', { spec: { verifier: 'shared-token', shared_token_hash: hash }, connectionId: null });
    const body = '{"id":1006}';
    expect((await fetch(`${base}/api/webhooks/${other}`, { method: 'POST', headers: { 'x-lynox-webhook-token': shared }, body })).status).toBe(200);
    expect((await deliver(shop, body)).status).toBe(200);
    expect(ledger.listByTrigger('t1')).toHaveLength(1);
    expect(ledger.listByTrigger('t2')).toHaveLength(1);
  });

  it('through a shared token is keyed per trigger: one sender cannot pre-empt another\'s body', async () => {
    const tokenA = ['shared', 'token', 'a'].join('-');
    const tokenB = ['shared', 'token', 'b'].join('-');
    const a = webhookTrigger('ta', { spec: { verifier: 'shared-token', shared_token_hash: createHash('sha256').update(tokenA).digest('hex') }, connectionId: null });
    const b = webhookTrigger('tb', { spec: { verifier: 'shared-token', shared_token_hash: createHash('sha256').update(tokenB).digest('hex') }, connectionId: null });
    const body = '{"ticket":1}';
    expect((await fetch(`${base}/api/webhooks/${a}`, { method: 'POST', headers: { 'x-lynox-webhook-token': tokenA }, body })).status).toBe(200);
    expect((await fetch(`${base}/api/webhooks/${b}`, { method: 'POST', headers: { 'x-lynox-webhook-token': tokenB }, body })).status).toBe(200);
    expect(ledger.listByTrigger('ta')).toHaveLength(1);
    expect(ledger.listByTrigger('tb')).toHaveLength(1);
  });

  it('without a shop header is dropped as well', async () => {
    const token = webhookTrigger('t1');
    const res = await fetch(`${base}/api/webhooks/${token}`, {
      method: 'POST',
      headers: { 'x-shopify-hmac-sha256': sign('{"id":1}') },
      body: '{"id":1}',
    });
    expect(res.status).toBe(200);
    expect(ledger.listByTrigger('t1')[0]?.state).toBe('dropped');
  });

  it('is accepted for any bytes the signature covers, JSON or not', async () => {
    const token = webhookTrigger('t1');
    expect((await deliver(token, 'not json at all')).status).toBe(200);
    expect(ledger.count()).toBe(1);
  });

  it('through a shared token is recorded; a wrong token is not', async () => {
    const shared = ['shared', 'token', 'value'].join('-');
    const hash = createHash('sha256').update(shared).digest('hex');
    const token = webhookTrigger('t1', { spec: { verifier: 'shared-token', shared_token_hash: hash }, connectionId: null });
    const ok = await fetch(`${base}/api/webhooks/${token}`, { method: 'POST', headers: { 'x-lynox-webhook-token': shared }, body: 'a' });
    expect(ok.status).toBe(200);
    const bad = await fetch(`${base}/api/webhooks/${token}`, { method: 'POST', headers: { 'x-lynox-webhook-token': `${shared}x` }, body: 'b' });
    expect(bad.status).toBe(401);
    expect(ledger.count()).toBe(1);
  });
});

describe('the cap on waiting events', () => {
  const fill = (n: number): void => {
    for (let i = 0; i < n; i++) ledger.record({ triggerId: 't1', dedupKey: `seed-${String(i)}`, headers: {}, state: 'received' });
  };

  it('answers a delivery over the cap 503 with Retry-After and writes no row; once drained, it is recorded', async () => {
    const token = webhookTrigger('t1', { spec: { verifier: 'shopify-hmac', mapping: { id: '/id' } } });
    fill(MAX_WAITING_EVENTS);
    const body = JSON.stringify({ id: 9001 });
    const busy = await deliver(token, body);
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe(String(QUEUE_FULL_RETRY_AFTER_S));
    expect(ledger.count()).toBe(MAX_WAITING_EVENTS);
    // The queue drains; the provider's redelivery is a new event with its values.
    engine.getDb().prepare(`UPDATE inbound_events SET state = 'done' WHERE trigger_id = 't1'`).run();
    expect((await deliver(token, body)).status).toBe(200);
    const kept = ledger.listByTrigger('t1').filter((e) => e.state === 'received');
    expect(kept).toHaveLength(1);
    expect(JSON.parse(kept[0]!.valuesJson!)).toMatchObject({ values: { id: 9001 } });
  });

  it('CONTROL: one under the cap is received', async () => {
    const token = webhookTrigger('t1');
    fill(MAX_WAITING_EVENTS - 1);
    expect((await deliver(token, JSON.stringify({ id: 9002 }))).status).toBe(200);
    expect(ledger.countWaiting('t1')).toBe(MAX_WAITING_EVENTS);
  });

  it('CONTROL: a duplicate at a full queue is still answered 200', async () => {
    const token = webhookTrigger('t1');
    const body = JSON.stringify({ id: 9003 });
    expect((await deliver(token, body)).status).toBe(200);
    fill(MAX_WAITING_EVENTS);
    expect((await deliver(token, body)).status).toBe(200);
  });
});

describe('a tombstone', () => {
  it('keeps a body that ran long ago a duplicate: replayed, it starts nothing', async () => {
    const token = webhookTrigger('t1');
    const body = JSON.stringify({ id: 9100 });
    expect((await deliver(token, body)).status).toBe(200);
    engine.getDb().prepare(`UPDATE inbound_events SET state = 'done', received_at = '2020-01-01T00:00:00.000Z' WHERE trigger_id = 't1'`).run();
    expect(ledger.tombstoneRows('2026-01-01T00:00:00.000Z')).toBe(1);
    expect((await deliver(token, body)).status).toBe(200);
    expect(ledger.listByTrigger('t1')).toHaveLength(1);
    expect(ledger.listByTrigger('t1')[0]).toMatchObject({ state: 'done', headersJson: '{}' });
  });
});

describe('what changes no state', () => {
  const refusal = async (res: Response): Promise<void> => {
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('{"error":"Unauthorized"}');
  };

  it('an unsigned request: no ledger row', async () => {
    const token = webhookTrigger('t1');
    await refusal(await fetch(`${base}/api/webhooks/${token}`, { method: 'POST', body: '{"id":1}' }));
    expect(ledger.count()).toBe(0);
  });

  it('a wrong signature, a signature under another secret, a non-canonical base64', async () => {
    const token = webhookTrigger('t1');
    const body = '{"id":2}';
    await refusal(await deliver(token, body, { 'x-shopify-hmac-sha256': sign('{"id":3}') }));
    await refusal(await deliver(token, body, { 'x-shopify-hmac-sha256': sign(body, `${APP_SECRET}x`) }));
    await refusal(await deliver(token, body, { 'x-shopify-hmac-sha256': `${sign(body)}!` }));
    expect(ledger.count()).toBe(0);
  });

  it('an unknown token answers like a bad signature and creates no budget entry', async () => {
    webhookTrigger('t1');
    await refusal(await deliver(mintRouteToken().token, '{"id":4}'));
    expect(receiver.failures.size).toBe(0);
    expect(ledger.count()).toBe(0);
  });

  it.each([
    ['switched off', { enabled: false }],
    ['stopped', { status: 'stopped' }],
    ['completed', { status: 'completed' }],
    ['made by a mandate and not confirmed', { createdBy: `${MANDATE_TAG_PREFIX}m1` }],
    ['not a webhook trigger', { source: 'cron' as const }],
    ['with another effect', { effect: 'notify' as const }],
    ['on a connection that is not an API profile', { connectionId: 'mail-a' }],
    ['on an API profile of another provider', { connectionId: 'other-a' }],
    ['without its connection', { connectionId: null }],
    ['without a verifier this engine knows', { spec: { verifier: 'none' } }],
  ])('a trigger %s accepts nothing', async (_label, opts) => {
    const token = webhookTrigger('t1', opts);
    await refusal(await deliver(token, '{"id":5}'));
    expect(ledger.count()).toBe(0);
  });

  it('a Shopify trigger whose app secret is not stored accepts nothing', async () => {
    secretValue = null;
    const token = webhookTrigger('t1');
    await refusal(await deliver(token, '{"id":6}'));
    expect(ledger.count()).toBe(0);
  });

  it('a non-POST at the route, even one whose empty body is signed', async () => {
    const token = webhookTrigger('t1');
    await refusal(await fetch(`${base}/api/webhooks/${token}`, {
      method: 'PUT',
      headers: { 'x-shopify-hmac-sha256': sign(''), 'x-shopify-shop-domain': SHOP_HOST },
      body: '',
    }));
    expect(ledger.count()).toBe(0);
  });
});

describe('the body is not read before the token is known', () => {
  it('an unknown token is answered with the announced body never sent', async () => {
    const head = await answerWithoutBody(`/api/webhooks/${mintRouteToken().token}`, 100);
    expect(head).toMatch(/^HTTP\/1\.1 401/);
  });

  it('a trigger that is switched off is answered the same way', async () => {
    const token = webhookTrigger('t1', { enabled: false });
    const head = await answerWithoutBody(`/api/webhooks/${token}`, 100);
    expect(head).toMatch(/^HTTP\/1\.1 401/);
  });

  it('a live trigger does wait for the body (the control for the two above)', async () => {
    const token = webhookTrigger('t1');
    await expect(answerWithoutBody(`/api/webhooks/${token}`, 100)).rejects.toThrow(/no answer without the body/);
  });

  it('a body announced over the limit is refused before a byte of it is read', async () => {
    const token = webhookTrigger('t1');
    const head = await answerWithoutBody(`/api/webhooks/${token}`, MAX_BODY + 1);
    expect(head).toMatch(/^HTTP\/1\.1 401/);
  });

  it('a body over the limit without a length is refused before verification', async () => {
    const token = webhookTrigger('t1');
    const big = 'x'.repeat(MAX_BODY + 1);
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); },
    });
    const res = await fetch(`${base}/api/webhooks/${token}`, {
      method: 'POST',
      headers: { 'x-shopify-hmac-sha256': sign(big), 'x-shopify-shop-domain': SHOP_HOST },
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect(res.status).toBe(401);
    expect(ledger.count()).toBe(0);
  });
});

describe('the failure budget', () => {
  it('a junk stream does not push a verified new delivery into a refusal', async () => {
    const token = webhookTrigger('t1');
    for (let i = 0; i < FAILURE_LIMIT + 3; i++) {
      expect((await deliver(token, `{"junk":${String(i)}}`, { 'x-shopify-hmac-sha256': sign('other') })).status).toBe(401);
    }
    const res = await deliver(token, '{"id":7}');
    expect(res.status).toBe(200);
    expect(ledger.count()).toBe(1);
  });

  // [SC-1]: junk spends the budget, and a provider's retry of a delivery whose 200 was lost is
  // still answered 200, records nothing more and is not charged.
  it('a duplicate is answered 200 whatever the budget, and is not charged', async () => {
    const token = webhookTrigger('t1');
    const body = '{"id":8}';
    expect((await deliver(token, body)).status).toBe(200);
    for (let i = 0; i < FAILURE_LIMIT + 3; i++) {
      expect((await deliver(token, `{"junk":${String(i)}}`, { 'x-shopify-hmac-sha256': sign('other') })).status).toBe(401);
    }
    for (let i = 0; i < 3; i++) expect((await deliver(token, body)).status).toBe(200);
    expect(ledger.count()).toBe(1);
  });

  it('CONTROL: duplicates alone spend nothing, so a junk request after many is still the first failure', async () => {
    const token = webhookTrigger('t1');
    const body = '{"id":10}';
    for (let i = 0; i < FAILURE_LIMIT + 3; i++) expect((await deliver(token, body)).status).toBe(200);
    expect(receiver.failures.charge('t1')).toBe(true);
  });

  it('is per trigger: junk at one does not spend another\'s', async () => {
    const one = webhookTrigger('t1');
    const two = webhookTrigger('t2');
    for (let i = 0; i < FAILURE_LIMIT + 1; i++) await deliver(one, `{"j":${String(i)}}`, { 'x-shopify-hmac-sha256': sign('x') });
    const body = '{"id":9}';
    expect((await deliver(two, body)).status).toBe(200);
    expect((await deliver(two, body)).status).toBe(200);
  });
});

// The mapping is read at receive time, from the verified bytes, because the body is not kept.
// Only a `received` event keeps values; a dropped one runs nothing and keeps none.
describe('the mapped values', () => {
  const MAPPING = { email: '/customer/email', total: '/total_price' };
  const values = (triggerId: string): unknown[] => ledger.listByTrigger(triggerId).map((e) => (e.valuesJson === null ? null : JSON.parse(e.valuesJson) as unknown));

  it('are read from a verified delivery and kept on its event, with what could not be read', async () => {
    const token = webhookTrigger('t1', { spec: { verifier: 'shopify-hmac', mapping: { ...MAPPING, note: '/note' } } });
    expect((await deliver(token, JSON.stringify({ customer: { email: 'kim@example.com' }, total_price: 42 }))).status).toBe(200);
    expect(values('t1')).toEqual([{ values: { email: 'kim@example.com', total: 42 }, unread: { note: 'the event has no field there' } }]);
  });

  it('keep nothing from a delivery that fails verification', async () => {
    const token = webhookTrigger('t1', { spec: { verifier: 'shopify-hmac', mapping: MAPPING } });
    const body = JSON.stringify({ customer: { email: 'kim@example.com' } });
    expect((await deliver(token, body, { 'x-shopify-hmac-sha256': sign('{}') })).status).toBe(401);
    expect(ledger.count()).toBe(0);
  });

  it('are not kept for a delivery from another shop', async () => {
    const token = webhookTrigger('t1', { spec: { verifier: 'shopify-hmac', mapping: MAPPING } });
    expect((await deliver(token, JSON.stringify({ customer: { email: 'kim@example.com' } }), { 'x-shopify-shop-domain': 'other.myshopify.com' })).status).toBe(200);
    expect(ledger.listByTrigger('t1').map((e) => e.state)).toEqual(['dropped']);
    expect(values('t1')).toEqual([null]);
  });

  // The row's values are set to a marker before the redelivery: a redelivery that wrote its
  // own values would overwrite it, though they are the same as the first ones.
  it('a redelivery leaves the first event\'s values as they were', async () => {
    const token = webhookTrigger('t1', { spec: { verifier: 'shopify-hmac', mapping: MAPPING } });
    const body = JSON.stringify({ customer: { email: 'kim@example.com' }, total_price: 1 });
    await deliver(token, body);
    engine.getDb().prepare("UPDATE inbound_events SET values_json = '{\"marker\":true}'").run();
    expect((await deliver(token, body)).status).toBe(200);
    expect(values('t1')).toEqual([{ marker: true }]);
  });

  it('are read for a shared-token trigger too', async () => {
    const shared = mintRouteToken();
    const token = webhookTrigger('t1', { spec: { verifier: 'shared-token', shared_token_hash: shared.hash, mapping: { id: '/id' } }, connectionId: null });
    const res = await fetch(`${base}/api/webhooks/${token}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lynox-webhook-token': shared.token }, body: '{"id":"T-1"}' });
    expect(res.status).toBe(200);
    expect(values('t1')).toEqual([{ values: { id: 'T-1' }, unread: {} }]);
  });

  it('CONTROL: a trigger without a mapping keeps no values', async () => {
    const token = webhookTrigger('t1');
    expect((await deliver(token, '{"id":1}')).status).toBe(200);
    expect(values('t1')).toEqual([null]);
  });

  it('a malformed mapping leaves the trigger accepting no delivery', async () => {
    const token = webhookTrigger('t1', { spec: { verifier: 'shopify-hmac', mapping: { 'not-a-name': '/a' } } });
    expect((await deliver(token, '{"a":1}')).status).toBe(401);
    expect(ledger.count()).toBe(0);
  });
});
