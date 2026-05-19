import { describe, it, expect, vi } from 'vitest';
import { decideMagicLinkOutcome, type MagicLinkDeps } from './magic-link.js';

// A token that satisfies the shape gate (≥100 chars) — actual content doesn't
// matter because we stub the CP fetch.
const VALID_TOKEN = 'a'.repeat(120);

function mkDeps(overrides: Partial<MagicLinkDeps> = {}): MagicLinkDeps {
	const url = new URL(overrides.url?.toString() ?? `https://cat.lynox.cloud/auth/magic?token=${VALID_TOKEN}`);
	return {
		url,
		hasValidSession: false,
		rateLimited: false,
		managed: { instanceId: 'inst-1', controlPlaneUrl: 'https://cp.example' },
		instanceSecret: 'engine-secret',
		clientIp: '203.0.113.1',
		fetchImpl: vi.fn(async () => new Response(JSON.stringify({ valid: true }), { status: 200 })),
		onFailedLogin: vi.fn(),
		...overrides,
	};
}

describe('decideMagicLinkOutcome — short-circuit guards', () => {
	it('returns already_logged_in when a valid session cookie is already present (skips CP call)', async () => {
		const fetchImpl = vi.fn();
		const outcome = await decideMagicLinkOutcome(mkDeps({ hasValidSession: true, fetchImpl }));
		expect(outcome.type).toBe('already_logged_in');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('returns redirect_login(missing_token) when ?token is absent', async () => {
		const outcome = await decideMagicLinkOutcome(mkDeps({
			url: new URL('https://cat.lynox.cloud/auth/magic'),
		}));
		expect(outcome).toEqual({ type: 'redirect_login', reason: 'missing_token' });
	});

	it('returns redirect_login(missing_token) when token is below the length floor (filters obvious garbage)', async () => {
		const outcome = await decideMagicLinkOutcome(mkDeps({
			url: new URL('https://cat.lynox.cloud/auth/magic?token=tooshort'),
		}));
		expect(outcome).toEqual({ type: 'redirect_login', reason: 'missing_token' });
	});

	it('returns redirect_login(unmanaged) when no LYNOX_MANAGED_* env is set (self-host)', async () => {
		const outcome = await decideMagicLinkOutcome(mkDeps({ managed: null }));
		expect(outcome).toEqual({ type: 'redirect_login', reason: 'unmanaged' });
	});

	it('returns redirect_login(rate_limited) when the IP is already throttled', async () => {
		const fetchImpl = vi.fn();
		const outcome = await decideMagicLinkOutcome(mkDeps({ rateLimited: true, fetchImpl }));
		expect(outcome).toEqual({ type: 'redirect_login', reason: 'rate_limited' });
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe('decideMagicLinkOutcome — CP fetch outcomes', () => {
	it('returns success on a CP 200 response', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ valid: true }), { status: 200 }));
		const outcome = await decideMagicLinkOutcome(mkDeps({ fetchImpl }));
		expect(outcome.type).toBe('success');
	});

	it('forwards the structured error_code from the CP body (expired)', async () => {
		const onFailedLogin = vi.fn();
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error_code: 'expired' }), { status: 410 }));
		const outcome = await decideMagicLinkOutcome(mkDeps({ fetchImpl, onFailedLogin }));
		expect(outcome).toEqual({ type: 'redirect_login', reason: 'expired' });
		expect(onFailedLogin).toHaveBeenCalledOnce();
	});

	it('forwards the structured error_code from the CP body (replay)', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error_code: 'replay' }), { status: 410 }));
		const outcome = await decideMagicLinkOutcome(mkDeps({ fetchImpl }));
		expect(outcome).toEqual({ type: 'redirect_login', reason: 'replay' });
	});

	it('forwards the structured error_code from the CP body (invalid)', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error_code: 'invalid' }), { status: 401 }));
		const outcome = await decideMagicLinkOutcome(mkDeps({ fetchImpl }));
		expect(outcome).toEqual({ type: 'redirect_login', reason: 'invalid' });
	});

	it('forwards the structured error_code (rate_limited) on a 429', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error_code: 'rate_limited' }), { status: 429 }));
		const outcome = await decideMagicLinkOutcome(mkDeps({ fetchImpl }));
		expect(outcome).toEqual({ type: 'redirect_login', reason: 'rate_limited' });
	});

	it('falls back to status-based reason when error_code is absent (older CP / non-JSON body)', async () => {
		// 410 without a JSON body → assume expired
		const fetchImpl = vi.fn(async () => new Response('Gone', { status: 410 }));
		const outcome = await decideMagicLinkOutcome(mkDeps({ fetchImpl }));
		expect(outcome).toEqual({ type: 'redirect_login', reason: 'expired' });
	});

	it('falls back to invalid for 401/403 when error_code is missing', async () => {
		const fetchImpl = vi.fn(async () => new Response('Unauthorized', { status: 401 }));
		const outcome = await decideMagicLinkOutcome(mkDeps({ fetchImpl }));
		expect(outcome).toEqual({ type: 'redirect_login', reason: 'invalid' });
	});

	it('treats unrecognized 5xx as cp_unreachable', async () => {
		const fetchImpl = vi.fn(async () => new Response('upstream broke', { status: 502 }));
		const outcome = await decideMagicLinkOutcome(mkDeps({ fetchImpl }));
		expect(outcome).toEqual({ type: 'redirect_login', reason: 'cp_unreachable' });
	});

	it('returns cp_unreachable when fetch itself throws (network error / abort)', async () => {
		const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
		const onFailedLogin = vi.fn();
		const outcome = await decideMagicLinkOutcome(mkDeps({ fetchImpl, onFailedLogin }));
		expect(outcome).toEqual({ type: 'redirect_login', reason: 'cp_unreachable' });
		// Network failure isn't a credential failure — don't burn rate-limit budget
		expect(onFailedLogin).not.toHaveBeenCalled();
	});

	it('records a failed-login attempt on any non-2xx CP response (rate-limit feedback)', async () => {
		const onFailedLogin = vi.fn();
		const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 }));
		await decideMagicLinkOutcome(mkDeps({ fetchImpl, onFailedLogin }));
		expect(onFailedLogin).toHaveBeenCalledOnce();
	});
});

describe('decideMagicLinkOutcome — CP request shape', () => {
	it('POSTs token + instanceId in the body and x-instance-secret in headers', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ valid: true }), { status: 200 }));
		await decideMagicLinkOutcome(mkDeps({ fetchImpl }));
		expect(fetchImpl).toHaveBeenCalledOnce();
		// Cast through `unknown` to satisfy strict noUncheckedIndexedAccess —
		// we already asserted toHaveBeenCalledOnce, so mock.calls[0] exists.
		const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(call[0]).toBe('https://cp.example/internal/auth/verify-magic');
		expect(call[1].method).toBe('POST');
		const headers = call[1].headers as Record<string, string>;
		expect(headers['x-instance-secret']).toBe('engine-secret');
		expect(headers['x-login-ip']).toBe('203.0.113.1');
		const body = JSON.parse(call[1].body as string) as { token: string; instanceId: string };
		expect(body.token).toBe(VALID_TOKEN);
		expect(body.instanceId).toBe('inst-1');
	});

	it('attaches an AbortSignal so a hung CP fetch eventually times out', async () => {
		const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
		await decideMagicLinkOutcome(mkDeps({ fetchImpl }));
		const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(call[1].signal).toBeInstanceOf(AbortSignal);
	});
});
