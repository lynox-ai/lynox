/**
 * The engine side of the exact clearance (`exact-clearance.ts`): every outage is triggered
 * and refuses with a 60 s backoff, an ok clears only after the marker is written, the
 * clearance holds for the boot, and the re-assert asks again only on `false` with a set marker.
 */
import { describe, it, expect, vi } from 'vitest';
import { EXACT_ATTACH_BACKOFF_MS, EXACT_ATTACH_TIMEOUT_MS, ExactClearance, controlPlaneFromEnv, type ExactMarker } from './exact-clearance.js';

const CP = { url: 'https://cp.example.invalid', instanceId: 'inst-1', secret: 'instance-secret' };

function markerStub(opts: { set?: boolean; setThrows?: boolean; readThrows?: boolean } = {}): ExactMarker & { writes: number } {
  let isSet = opts.set ?? false;
  const m = {
    writes: 0,
    isSet: (): boolean => { if (opts.readThrows) throw new Error('engine.db unreadable'); return isSet; },
    set: (): void => { if (opts.setThrows) throw new Error('engine.db read-only'); m.writes++; isSet = true; },
  };
  return m;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function harness(answers: (() => Promise<Response>)[], marker = markerStub()) {
  let t = 1_000_000;
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    return next();
  }) as unknown as typeof fetch;
  const c = new ExactClearance(CP, marker, { fetch: fetchStub, now: () => t });
  return { c, calls, marker, advance: (ms: number) => { t += ms; } };
}

describe('ensure', () => {
  it('clears on ok, writes the marker first, and asks with the secret and an empty body', async () => {
    const h = harness([async () => json(200, { ok: true })]);
    expect(await h.c.ensure()).toEqual({ ok: true });
    expect(h.marker.writes).toBe(1);
    expect(h.calls[0]!.url).toBe('https://cp.example.invalid/internal/instances/inst-1/exact-attach');
    expect(h.calls[0]!.init.method).toBe('POST');
    expect(h.calls[0]!.init.body).toBe('{}');
    expect((h.calls[0]!.init.headers as Record<string, string>)['x-instance-secret']).toBe('instance-secret');
  });

  it('holds the clearance for the boot: a second attach asks nothing (boot cache)', async () => {
    const h = harness([async () => json(200, { ok: true })]);
    await h.c.ensure();
    h.advance(24 * 3_600_000);
    expect(await h.c.ensure()).toEqual({ ok: true });
    expect(h.calls).toHaveLength(1);
  });

  it('asks again after a restart (a new instance of the clearance)', async () => {
    const marker = markerStub();
    const first = harness([async () => json(200, { ok: true })], marker);
    await first.c.ensure();
    const second = harness([async () => json(200, { ok: true })], marker);
    await second.c.ensure();
    expect(second.calls).toHaveLength(1);
  });

  it.each([
    ['a refusal', async () => json(200, { ok: false, reason: 'below_floor' }), 'below_floor'],
    ['busy', async () => json(409, { ok: false, reason: 'busy' }), 'busy'],
    ['a rate limit', async () => json(429, { ok: false, reason: 'rate_limited' }), 'rate_limited'],
    ['a 5xx', async () => json(500, { error: 'x' }), 'server_error'],
    ['a 5xx that claims ok', async () => json(503, { ok: true }), 'server_error'],
    ['a body without the bit', async () => json(200, { cleared: true }), 'no_answer'],
    ['ok as a string', async () => json(200, { ok: 'true' }), 'no_answer'],
    ['a body that is not JSON', async () => new Response('<html>', { status: 200 }), 'no_answer'],
    ['an unreachable control plane', async () => { throw new TypeError('fetch failed'); }, 'unreachable'],
    ['a timeout', async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); }, 'timeout'],
  ] as const)('refuses on %s and backs off for 60 s', async (_label, answer, reason) => {
    const h = harness([answer, async () => json(200, { ok: true })]);
    expect(await h.c.ensure()).toEqual({ ok: false, reason });
    expect(h.marker.writes).toBe(0);
    h.advance(EXACT_ATTACH_BACKOFF_MS - 1);
    expect(await h.c.ensure()).toEqual({ ok: false, reason: 'backoff' });
    expect(h.calls).toHaveLength(1);
    h.advance(1);
    expect(await h.c.ensure()).toEqual({ ok: true });
  });

  it('gives the control plane 5 s', async () => {
    const h = harness([async () => json(200, { ok: true })]);
    const spy = vi.spyOn(AbortSignal, 'timeout');
    await h.c.ensure();
    expect(spy).toHaveBeenCalledWith(EXACT_ATTACH_TIMEOUT_MS);
    expect(EXACT_ATTACH_TIMEOUT_MS).toBe(5_000);
    spy.mockRestore();
  });

  it('clears nothing when the marker cannot be written', async () => {
    const h = harness([async () => json(200, { ok: true })], markerStub({ setThrows: true }));
    expect(await h.c.ensure()).toEqual({ ok: false, reason: 'marker_unwritable' });
    expect(await h.c.ensure()).toEqual({ ok: false, reason: 'backoff' });
  });

  it('refuses an engine that is not provisioned, without asking', async () => {
    const fetchStub = vi.fn() as unknown as typeof fetch;
    expect(await new ExactClearance(null, markerStub(), { fetch: fetchStub }).ensure()).toEqual({ ok: false, reason: 'not_provisioned' });
    expect(await new ExactClearance(CP, null, { fetch: fetchStub }).ensure()).toEqual({ ok: false, reason: 'not_provisioned' });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('shares one ask between concurrent first attaches', async () => {
    let release!: (r: Response) => void;
    const h = harness([() => new Promise<Response>((r) => { release = r; })]);
    const a = h.c.ensure();
    const b = h.c.ensure();
    release(json(200, { ok: true }));
    expect(await Promise.all([a, b])).toEqual([{ ok: true }, { ok: true }]);
    expect(h.calls).toHaveLength(1);
  });
});

describe('reassert', () => {
  it('asks again when the control plane reports false and the marker is set', async () => {
    const h = harness([async () => json(200, { ok: true })], markerStub({ set: true }));
    await h.c.reassert(false);
    expect(h.calls).toHaveLength(1);
  });

  it('does nothing on true, on no statement, without a marker, or when the marker cannot be read', async () => {
    for (const [held, marker] of [
      [true, markerStub({ set: true })],
      [null, markerStub({ set: true })],
      [false, markerStub({ set: false })],
      [false, markerStub({ readThrows: true })],
    ] as const) {
      const h = harness([async () => json(200, { ok: true })], marker);
      await h.c.reassert(held);
      expect(h.calls, String(held)).toHaveLength(0);
    }
  });

  it('respects the backoff after a refused re-assert', async () => {
    const h = harness([async () => json(409, { ok: false, reason: 'busy' }), async () => json(200, { ok: true })], markerStub({ set: true }));
    await h.c.reassert(false);
    await h.c.reassert(false);
    expect(h.calls).toHaveLength(1);
  });

  it('a refused re-assert holds the attaches of this boot as well', async () => {
    const h = harness([async () => json(409, { ok: false, reason: 'busy' })], markerStub({ set: true }));
    await h.c.reassert(false);
    expect(h.c.blockedNow()).toBe(true);
    expect(await h.c.ensure()).toEqual({ ok: false, reason: 'backoff' });
    expect(h.calls).toHaveLength(1);
  });

  it('asks once a minute while the control plane keeps reporting false after an ok', async () => {
    const h = harness([async () => json(200, { ok: true }), async () => json(200, { ok: true })], markerStub({ set: true }));
    await h.c.reassert(false);
    h.advance(EXACT_ATTACH_BACKOFF_MS - 1);
    await h.c.reassert(false);
    expect(h.calls).toHaveLength(1);
    h.advance(1);
    await h.c.reassert(false);
    expect(h.calls).toHaveLength(2);
  });

  it('an ok re-assert does not hold the attaches', async () => {
    const h = harness([async () => json(200, { ok: true }), async () => json(200, { ok: true })], markerStub({ set: true }));
    await h.c.reassert(false);
    expect(h.c.blockedNow()).toBe(false);
    expect(await h.c.ensure()).toEqual({ ok: true });
  });
});

describe('controlPlaneFromEnv', () => {
  it('needs all three managed variables', () => {
    const full = { LYNOX_MANAGED_CONTROL_PLANE_URL: 'u', LYNOX_MANAGED_INSTANCE_ID: 'i', LYNOX_HTTP_SECRET: 's' };
    expect(controlPlaneFromEnv(full)).toEqual({ url: 'u', instanceId: 'i', secret: 's' });
    for (const k of Object.keys(full)) {
      expect(controlPlaneFromEnv({ ...full, [k]: '' }), k).toBeNull();
    }
  });
});
