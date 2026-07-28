import { describe, it, expect, vi } from 'vitest';
import { decideMagicLinkOutcome, type MagicLinkDeps } from './magic-link.js';
import { MAGIC_LINK_ERROR_CODES } from '../contract/http.js';

// A token that satisfies the shape gate (≥100 chars) — actual content doesn't
// matter because we stub the CP fetch.
const VALID_TOKEN = 'a'.repeat(120);

function mkDeps(overrides: Partial<MagicLinkDeps> = {}): MagicLinkDeps {
	const url = new URL(overrides.url?.toString() ?? `https://acme.lynox.cloud/auth/magic?token=${VALID_TOKEN}`);
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
			url: new URL('https://acme.lynox.cloud/auth/magic'),
		}));
		expect(outcome).toEqual({ type: 'redirect_login', reason: 'missing_token' });
	});

	it('returns redirect_login(missing_token) when token is below the length floor (filters obvious garbage)', async () => {
		const outcome = await decideMagicLinkOutcome(mkDeps({
			url: new URL('https://acme.lynox.cloud/auth/magic?token=tooshort'),
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
		// The KEY SET, not just the two keys we care about: the control plane
		// reads `instanceId` (camelCase) while the OAuth claim on the same
		// boundary reads `instance_id`. An extra or renamed key here is a wire
		// change, and the CP would simply see the field as missing.
		expect(Object.keys(body).sort()).toEqual(['instanceId', 'token']);
	});

	it('attaches an AbortSignal so a hung CP fetch eventually times out', async () => {
		const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
		await decideMagicLinkOutcome(mkDeps({ fetchImpl }));
		const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(call[1].signal).toBeInstanceOf(AbortSignal);
	});
});

// ── The error_code vocabulary is the contract's, not a local copy ───────────
//
// Before K-W3 this route matched `error_code` against a hand-listed union that
// happened to agree with the control plane's. The tests below fail on the two
// ways that agreement can break: a code the CP sends that the engine no longer
// maps (drop one arm of the loop's source and it is red), and a code the engine
// accepts that the CP never sends (an unvalidated CP string reaching the user's
// redirect URL).
describe('decideMagicLinkOutcome — wire error_code vocabulary', () => {
	it.each(MAGIC_LINK_ERROR_CODES)('maps the wire code %s straight through to a reason', async (code) => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'x', error_code: code }), { status: 400 }));
		const outcome = await decideMagicLinkOutcome(mkDeps({ fetchImpl }));
		// Status 400 is deliberately one the status-fallback chain does NOT
		// handle — so a green result here can only come from the error_code
		// path, never from a lucky fallback.
		expect(outcome).toEqual({ type: 'redirect_login', reason: code });
	});

	it('does not forward a code outside the contract set — unknown means cp_unreachable', async () => {
		// A CP that starts sending a code this engine predates. Forwarding it
		// would put a control-plane-controlled string into `/login?error=magic_…`
		// and would tell the user something the engine cannot actually know.
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error_code: 'quarantined' }), { status: 400 }));
		const outcome = await decideMagicLinkOutcome(mkDeps({ fetchImpl }));
		expect(outcome).toEqual({ type: 'redirect_login', reason: 'cp_unreachable' });
	});

	it('ignores a non-string error_code rather than trusting the body', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error_code: { evil: true } }), { status: 400 }));
		const outcome = await decideMagicLinkOutcome(mkDeps({ fetchImpl }));
		expect(outcome).toEqual({ type: 'redirect_login', reason: 'cp_unreachable' });
	});

	it('every reason the route can return is a safe URL token', () => {
		// The reason is interpolated into `/login?error=magic_<reason>`. Keeping
		// the set closed is what makes that interpolation safe; this pins the
		// property rather than leaving it to the reader of the route.
		for (const reason of [...MAGIC_LINK_ERROR_CODES, 'missing_token', 'unmanaged', 'cp_unreachable']) {
			expect(reason).toMatch(/^[a-z_]+$/);
		}
	});
});
