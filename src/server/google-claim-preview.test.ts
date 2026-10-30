import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LynoxHTTPApi } from './http-api.js';
import { setPinnedTransportForTests, type PinnedTransportInput } from '../core/network-guard.js';
import { dnsLookupStub } from '../../tests/helpers/pinned-fetch-bridge.js';

// `fetchPinned` resolves the control plane's name before it reaches the
// transport; a public answer keeps the request on the seam below.
vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn(async () => dnsLookupStub()) },
}));

/**
 * `POST /api/google/claim-managed/preview`: which account a parked claim
 * belongs to, asked before anything is claimed.
 *
 * The control plane is replaced at the socket (`setPinnedTransportForTests`),
 * not at `fetch`: the route reaches it through `cpFetch`, and the host policy
 * still runs. What these tests hold:
 *
 * - it asks the PREVIEW route with this instance's id, secret and the nonce,
 *   and never the claim route, so nothing is consumed;
 * - only an address comes back, even when the control plane sends more;
 * - a control plane that ANSWERS without an address yields `{ unnamed: true }`,
 *   which the dialog refuses to confirm; whoever runs the consent can arrange it;
 * - no answer to go by (an error status, a network failure) is an empty 200,
 *   which the dialog reads as "cannot name it";
 * - the same gates as the claim: a session, and an instance that can claim.
 */

const SECRET = 'claim-preview-test-secret-value';
const CP = 'https://cp.example.test';
const PREVIEW = '/api/google/claim-managed/preview';

const OWNED = [
  'LYNOX_MANAGED_INSTANCE_ID',
  'LYNOX_MANAGED_CONTROL_PLANE_URL',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_SERVICE_ACCOUNT_KEY',
] as const;

const seen: PinnedTransportInput[] = [];
let cpAnswer: () => Promise<Response> = () => Promise.resolve(new Response('{}', { status: 200 }));

interface Booted { readonly base: string; readonly close: () => Promise<void> }

async function boot(managed: boolean): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), 'lynox-claimpreview-'));
  for (const k of OWNED) vi.stubEnv(k, undefined);
  vi.stubEnv('LYNOX_DATA_DIR', dir);
  vi.stubEnv('LYNOX_HTTP_SECRET', SECRET);
  vi.stubEnv('LYNOX_ALLOW_PLAIN_HTTP', 'true');
  // A mandate is let in only on the durable memory tools, as on the fleet: without them the
  // mandate test would meet that refusal before the owner gate it is about.
  vi.stubEnv('LYNOX_DURABLE_MEMORY_ENABLED', 'true');
  if (managed) {
    vi.stubEnv('LYNOX_MANAGED_INSTANCE_ID', 'inst-claim-preview');
    vi.stubEnv('LYNOX_MANAGED_CONTROL_PLANE_URL', CP);
  }
  const restore = setPinnedTransportForTests(async (input) => {
    seen.push(input);
    return cpAnswer();
  });
  const api = new LynoxHTTPApi();
  await api.init();
  await api.start(0);
  const port = api.boundPort;
  if (port === undefined) throw new Error('server is not bound after start()');
  const base = `http://127.0.0.1:${String(port)}`;
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => { setTimeout(r, 50); });
  }
  return {
    base,
    close: async () => {
      await api.shutdown();
      restore();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const json = (status: number, body: unknown): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

async function preview(base: string, body: unknown = { claim_nonce: 'nonce-1' }, auth = true): Promise<Response> {
  return fetch(`${base}${PREVIEW}`, {
    method: 'POST',
    headers: { ...(auth ? { Authorization: `Bearer ${SECRET}` } : {}), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('a managed tenant', () => {
  let b: Booted;
  beforeAll(async () => { b = await boot(true); }, 60_000);
  afterAll(async () => { await b.close(); });
  beforeEach(() => { seen.length = 0; });

  it('asks the preview route, not the claim, with this instance and the nonce, and returns the address', async () => {
    cpAnswer = () => json(200, { email: ' owner@example.com ' });
    const res = await preview(b.base, { claim_nonce: 'nonce-42' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: 'owner@example.com' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`${CP}/internal/oauth/google/claim-preview`);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.headers['x-instance-secret']).toBe(SECRET);
    expect(JSON.parse(seen[0]?.body?.toString('utf8') ?? '')).toEqual({ instance_id: 'inst-claim-preview', claim_nonce: 'nonce-42' });
  });

  it('passes on only the address, even when the control plane sends more', async () => {
    cpAnswer = () => json(200, { email: 'owner@example.com', access_token: 'at', refresh_token: 'rt', scopes: ['x'] });
    const res = await preview(b.base);
    expect(await res.json()).toEqual({ email: 'owner@example.com' });
  });

  it('says unnamed when the control plane answers without a usable address', async () => {
    for (const a of [
      () => json(200, {}),
      () => json(200, { email: '' }),
      () => json(200, { email: '   ' }),
      () => json(200, { email: 'not-an-address' }),
      () => json(200, { email: 7 }),
      () => json(200, null),
      () => Promise.resolve(new Response('not json', { status: 200 })),
    ]) {
      cpAnswer = a;
      const res = await preview(b.base);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ unnamed: true });
    }
  });

  it('answers an empty 200 when there is no answer to go by', async () => {
    for (const a of [
      () => json(404, { error: 'No pending Google authorization. Start the flow again.' }),
      () => json(410, { error: 'Authorization expired. Start the flow again.' }),
      () => json(403, { email: 'owner@example.com' }),
      () => Promise.reject(new Error('socket hang up')),
    ]) {
      cpAnswer = a;
      const res = await preview(b.base);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({});
    }
  });

  it('refuses a request without a nonce, before asking the control plane', async () => {
    const res = await preview(b.base, {});
    expect(res.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('is the owner\'s alone: a mandate gets 403 for the preview and the claim, and the control plane is not asked', async () => {
    // A landing link can be passed into a mandate's session on the same instance. The control
    // plane only checks the instance, so without this a mandate would read the owner's address.
    const { loginSession } = await import('../../packages/web-ui/src/lib/server/auth.js');
    const cookie = loginSession(SECRET, {
      kind: 'mandate', email: 'ida@example.invalid', display: 'IDA', mandate_id: 'TEST-MANDATE-PREVIEW',
      mandate_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    })?.token;
    if (cookie === undefined) throw new Error('fixture: no mandate cookie');
    cpAnswer = () => json(200, { email: 'owner@example.com' });
    for (const path of [PREVIEW, '/api/google/claim-managed']) {
      const res = await fetch(`${b.base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie: `lynox_session=${cookie}` },
        body: JSON.stringify({ claim_nonce: 'nonce-1' }),
      });
      expect(res.status).toBe(403);
      // The owner gate's refusal, not an ended mandate's (`mandate_revoked` is a 403 too).
      const text = await res.text();
      expect(text).toMatch(/Only the owner of this instance can/);
      expect(text).not.toContain('mandate_revoked');
    }
    expect(seen).toHaveLength(0);
  });

  it('writes the address to no log, on success or on an error answer', async () => {
    const written: string[] = [];
    const capture = (chunk: unknown): boolean => { written.push(String(chunk)); return true; };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(capture as typeof process.stderr.write);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(capture as typeof process.stdout.write);
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { written.push(args.map(String).join(' ')); }));
    try {
      // Positive control: the capture sees what is written through it.
      process.stderr.write('capture-control\n');
      console.warn('capture-control');
      for (const a of [
        () => json(200, { email: 'owner@example.com' }),
        () => json(500, { error: 'failed for owner@example.com' }),
        () => Promise.reject(new Error('socket hang up for owner@example.com')),
      ]) {
        cpAnswer = a;
        await (await preview(b.base)).text();
      }
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
      for (const c of consoles) c.mockRestore();
    }
    expect(written.filter((w) => w.includes('capture-control'))).toHaveLength(2);
    expect(written.join('\n')).not.toContain('owner@example.com');
  });

  it('still requires a session', async () => {
    const res = await preview(b.base, { claim_nonce: 'nonce-1' }, false);
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });
});

describe('a self-host instance with no client pair', () => {
  let b: Booted;
  beforeAll(async () => { b = await boot(false); }, 60_000);
  afterAll(async () => { await b.close(); });
  beforeEach(() => { seen.length = 0; });

  it('refuses like the claim does, and asks nobody', async () => {
    const res = await preview(b.base);
    expect(res.status).toBe(503);
    expect(seen).toHaveLength(0);
  });
});
