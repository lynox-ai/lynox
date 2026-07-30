/**
 * Control-plane usage-summary proxy tests. Focus on the contract:
 * - null when not managed (missing env vars)
 * - null when fetch fails
 * - null when the CP returns something that isn't our shape
 * - pass-through on a valid response
 *
 * No real network or control plane — fetch is stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchControlPlaneUsageSummary } from './managed-usage-summary.js';

const ENV_CONTROL = 'LYNOX_MANAGED_CONTROL_PLANE_URL';
const ENV_INSTANCE = 'LYNOX_MANAGED_INSTANCE_ID';
const ENV_SECRET = 'LYNOX_HTTP_SECRET';

const originalFetch = globalThis.fetch;
beforeEach(() => {
  vi.stubEnv(ENV_CONTROL, 'https://cp.example.invalid');
  vi.stubEnv(ENV_INSTANCE, 'inst-001');
  vi.stubEnv(ENV_SECRET, 'secret-abc');
});
afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.fetch = originalFetch;
});

describe('fetchControlPlaneUsageSummary', () => {
  it('returns null when env vars are missing (non-managed boot)', async () => {
    vi.stubEnv(ENV_CONTROL, '');
    const out = await fetchControlPlaneUsageSummary();
    expect(out).toBeNull();
  });

  it('returns null when control plane is unreachable', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const out = await fetchControlPlaneUsageSummary();
    expect(out).toBeNull();
  });

  it('returns null on non-ok response', async () => {
    globalThis.fetch = vi.fn(async () => (
      new Response('nope', { status: 503 })
    )) as unknown as typeof fetch;
    const out = await fetchControlPlaneUsageSummary();
    expect(out).toBeNull();
  });

  it('returns null when response is not valid JSON shape', async () => {
    globalThis.fetch = vi.fn(async () => (
      new Response(JSON.stringify({ unexpected: 'wrong shape, no managed field' }), { status: 200, headers: { 'content-type': 'application/json' } })
    )) as unknown as typeof fetch;
    const out = await fetchControlPlaneUsageSummary();
    expect(out).toBeNull();
  });

  it('passes through a valid managed summary', async () => {
    const body = {
      managed: true,
      tier: 'managed',
      budget_cents: 3000,
      used_cents: 1200,
      balance_cents: 1800,
      period: {
        start_iso: '2026-04-01T00:00:00.000Z',
        end_iso:   '2026-05-01T00:00:00.000Z',
        source: 'stripe-billing' as const,
      },
    };
    let capturedHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (_url: unknown, init: unknown) => {
      capturedHeaders = (init as { headers?: Record<string, string> }).headers ?? {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const out = await fetchControlPlaneUsageSummary();
    expect(out).toEqual(body);
    // Auth header must be the instance secret — same contract as /status.
    expect(capturedHeaders['x-instance-secret']).toBe('secret-abc');
  });

  it('passes through managed:false for BYOK', async () => {
    globalThis.fetch = vi.fn(async () => (
      new Response(JSON.stringify({ managed: false }), { status: 200, headers: { 'content-type': 'application/json' } })
    )) as unknown as typeof fetch;
    const out = await fetchControlPlaneUsageSummary();
    expect(out).toEqual({ managed: false });
  });
});

// ── Contract fixture pair (K-W2) ────────────────────────────────────────────
// The REAL parser is driven by the SAME golden bytes the control plane's pair
// test asserts its real /summary serializer produces. A field rename on either
// side fails one of the two tests before it ships.
describe('contract fixtures: /summary parse side', () => {
  const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../contract/fixtures');
  const load = (name: string): unknown =>
    JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));

  it.each([
    'usage-summary-response.managed.json',
    'usage-summary-response.not-managed.json',
  ])('accepts and passes through %s unchanged', async (name) => {
    const fixture = load(name);
    globalThis.fetch = vi.fn(async () => (
      new Response(JSON.stringify(fixture), { status: 200, headers: { 'content-type': 'application/json' } })
    )) as unknown as typeof fetch;
    const out = await fetchControlPlaneUsageSummary();
    // Pass-through means the parser recognized the shape (a renamed `managed`
    // key would return null) and dropped nothing.
    expect(out).toEqual(fixture);
  });

  it('the managed fixture is internally consistent (available = budget + topup; used = available - balance)', () => {
    const f = load('usage-summary-response.managed.json') as {
      budget_cents: number; topup_cents: number; available_cents: number;
      used_cents: number; balance_cents: number;
    };
    expect(f.available_cents).toBe(f.budget_cents + f.topup_cents);
    expect(f.used_cents).toBe(f.available_cents - f.balance_cents);
  });
});
