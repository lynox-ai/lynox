import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
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
 * `POST /api/google/claim-managed` when the control plane's answer does not parse. The answer
 * carries the tokens, and V8's parse error quotes the text around the fault, so the route
 * answers with the position only.
 */

const SECRET = 'claim-parse-test-secret-value';
const CP = 'https://cp.example.test';
const CLAIM = '/api/google/claim-managed';

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
  const dir = mkdtempSync(join(tmpdir(), 'lynox-claimparse-'));
  for (const k of OWNED) vi.stubEnv(k, undefined);
  vi.stubEnv('LYNOX_DATA_DIR', dir);
  vi.stubEnv('LYNOX_HTTP_SECRET', SECRET);
  vi.stubEnv('LYNOX_ALLOW_PLAIN_HTTP', 'true');
  // A mandate is let in only on the durable memory tools, as on the fleet: without them the
  // mandate test would meet that refusal before the owner gate it is about.
  vi.stubEnv('LYNOX_DURABLE_MEMORY_ENABLED', 'true');
  if (managed) {
    vi.stubEnv('LYNOX_MANAGED_INSTANCE_ID', 'inst-claim-parse');
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

// Built at run time so the source holds no token-shaped literal.
const TOKEN = ['ya29', 'CLAIMPARSESECRETTOKEN0123456789'].join('.');

async function claim(base: string): Promise<Response> {
  return fetch(`${base}${CLAIM}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ claim_nonce: 'nonce-1' }),
  });
}

describe('a claim answer that does not parse', () => {
  let b: Booted;
  beforeAll(async () => { b = await boot(true); }, 60_000);
  afterAll(async () => { await b.close(); });

  it('fails without quoting the tokens it carried', async () => {
    const raw = `{"access_token": ${TOKEN}, "refresh_token": "r"}`;
    expect(() => JSON.parse(raw)).toThrow(/ya29\.CLAI/);
    cpAnswer = () => Promise.resolve(new Response(raw, { status: 200, headers: { 'content-type': 'application/json' } }));
    const res = await claim(b.base);
    expect(seen.some((s) => s.url === `${CP}/internal/oauth/google/claim`)).toBe(true);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain('not valid JSON');
    expect(text).not.toContain('ya29');
    expect(text).not.toContain('access_token');
  });
});
