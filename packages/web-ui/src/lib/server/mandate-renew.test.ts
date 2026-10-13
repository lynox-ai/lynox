import { afterEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { foreignRequest, renewMandateSession, type RenewDeps } from './mandate-renew.js';
import { readSessionToken, type MandateSessionPrincipal } from './auth.js';

// The golden bodies (core src/contract/fixtures): what this sends, and what the CP answers.
const fixture = (name: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../../src/contract/fixtures/${name}`, import.meta.url)), 'utf8'));
const REQUEST_FIXTURE = fixture('mandate-renew-request.json') as { instanceId: string; mandate_id: string; email: string };
const ANSWER_FIXTURE = fixture('auth-login-success.mandate.json') as { valid: true; principal: Record<string, unknown> };

const SECRET = 'engine-secret';
const CP = 'https://cp.example.invalid';
const T = 2_000_000_000;
const DAY_S = 8 * 3600;

afterEach(() => { vi.restoreAllMocks(); });

function sessionAt(overrides: Partial<MandateSessionPrincipal> = {}): MandateSessionPrincipal {
	return {
		v: 1, kind: 'mandate',
		email: REQUEST_FIXTURE.email, display: 'TEST-DISPLAY', mandate_id: REQUEST_FIXTURE.mandate_id,
		exp: T + 200, auth_time: T - 3600,
		...overrides,
	};
}

const ok = (body: unknown = ANSWER_FIXTURE) => new Response(JSON.stringify(body), { status: 200 });

function deps(res: Response | (() => Promise<Response>), overrides: Partial<RenewDeps> = {}): RenewDeps & { calls: Array<[string, RequestInit]> } {
	const calls: Array<[string, RequestInit]> = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		calls.push([url, init]);
		return typeof res === 'function' ? res() : res;
	}) as unknown as typeof fetch;
	return {
		principal: sessionAt(),
		secret: SECRET,
		managed: { instanceId: REQUEST_FIXTURE.instanceId, controlPlaneUrl: CP },
		nowS: T,
		fetchImpl,
		throttle: new Map(),
		calls,
		...overrides,
	};
}

describe('renewMandateSession', () => {
	it('never asks the control plane for the owner, and answers owner', async () => {
		const d = deps(ok(), { principal: null });
		expect(await renewMandateSession(d)).toEqual({ kind: 'owner' });
		expect(d.calls).toHaveLength(0);
	});

	it('asks with exactly the contract body and the instance secret, and mints the next 15 minutes', async () => {
		const timeout = vi.spyOn(AbortSignal, 'timeout');
		const d = deps(ok());
		const out = await renewMandateSession(d);
		expect(d.calls).toHaveLength(1);
		const [url, init] = d.calls[0]!;
		expect(url).toBe(`${CP}/internal/auth/renew-mandate`);
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body as string)).toEqual(REQUEST_FIXTURE);
		expect((init.headers as Record<string, string>)['x-instance-secret']).toBe(SECRET);
		expect(init.redirect).toBe('error');
		expect(timeout).toHaveBeenCalledWith(5000);
		if (out.kind !== 'mandate' || !out.renewed) throw new Error(JSON.stringify(out));
		expect(out.exp).toBe(T + 900);
		expect(out.session.maxAge).toBe(900);
	});

	it('carries the login time into the renewed cookie unchanged', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(T * 1000);
		try {
			const out = await renewMandateSession(deps(ok()));
			if (out.kind !== 'mandate' || !out.renewed) throw new Error(JSON.stringify(out));
			const p = readSessionToken(out.session.token, SECRET)?.principal;
			expect(p).toMatchObject({ mandate_id: REQUEST_FIXTURE.mandate_id, email: REQUEST_FIXTURE.email, auth_time: T - 3600, exp: T + 900 });
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not renew a cookie without a login time', async () => {
		const d = deps(ok(), { principal: sessionAt({ auth_time: undefined }) });
		expect(await renewMandateSession(d)).toEqual({ kind: 'mandate', exp: T + 200, renewed: false });
		expect(d.calls).toHaveLength(0);
	});

	it('stops asking a working day after the login', async () => {
		const atDay = deps(ok(), { principal: sessionAt({ auth_time: T - DAY_S, exp: T + 1 }) });
		expect(await renewMandateSession(atDay)).toMatchObject({ renewed: false });
		expect(atDay.calls).toHaveLength(0);
		const justBefore = deps(ok(), { principal: sessionAt({ auth_time: T - DAY_S + 1, exp: T + 1 }) });
		await renewMandateSession(justBefore);
		expect(justBefore.calls).toHaveLength(1);
	});

	it('never mints past a working day after the login, whatever the control plane says', async () => {
		const out = await renewMandateSession(deps(ok(), { principal: sessionAt({ auth_time: T - DAY_S + 120, exp: T + 60 }) }));
		if (out.kind !== 'mandate' || !out.renewed) throw new Error(JSON.stringify(out));
		expect(out.exp).toBe(T + 120);
	});

	it('does not ask on an instance the control plane did not provision', async () => {
		const d = deps(ok(), { managed: null });
		expect(await renewMandateSession(d)).toMatchObject({ renewed: false });
		expect(d.calls).toHaveLength(0);
	});

	it('asks only within five minutes of the session\'s end', async () => {
		const early = deps(ok(), { principal: sessionAt({ exp: T + 301 }) });
		expect(await renewMandateSession(early)).toMatchObject({ renewed: false, exp: T + 301 });
		expect(early.calls).toHaveLength(0);
		const inside = deps(ok(), { principal: sessionAt({ exp: T + 300 }) });
		expect(await renewMandateSession(inside)).toMatchObject({ renewed: true });
		expect(inside.calls).toHaveLength(1);
	});

	it('asks at most once per mandate in 30 seconds, also for two asks at once', async () => {
		let release!: (r: Response) => void;
		const pending = new Promise<Response>((r) => { release = r; });
		const d = deps(() => pending);
		const first = renewMandateSession(d);
		const second = await renewMandateSession(d);
		expect(second).toMatchObject({ renewed: false });
		release(ok());
		expect(await first).toMatchObject({ renewed: true });
		expect(d.calls).toHaveLength(1);

		expect(await renewMandateSession({ ...d, nowS: T + 29 })).toMatchObject({ renewed: false });
		expect(d.calls).toHaveLength(1);
		await renewMandateSession({ ...d, nowS: T + 30 });
		expect(d.calls).toHaveLength(2);
	});

	it('throttles per mandate, not for everyone', async () => {
		const d = deps(() => Promise.resolve(ok()));
		await renewMandateSession(d);
		await renewMandateSession({ ...d, principal: sessionAt({ mandate_id: 'TEST-MANDATE-2' }) });
		expect(d.calls).toHaveLength(2);
	});

	it('keeps the throttle at 1000 mandates, dropping the oldest', async () => {
		const throttle = new Map<string, number>();
		const d = deps(() => Promise.resolve(ok()), { throttle });
		for (let i = 0; i < 1000; i++) await renewMandateSession({ ...d, principal: sessionAt({ mandate_id: `m-${i}` }) });
		expect(throttle.size).toBe(1000);
		await renewMandateSession(d);
		expect(throttle.size).toBe(1000);
		expect(throttle.has('m-0')).toBe(false);
		expect(throttle.has('m-1')).toBe(true);
		expect(throttle.has(REQUEST_FIXTURE.mandate_id)).toBe(true);
	});

	it('does not renew when the control plane is unreachable or slow', async () => {
		for (const err of [new TypeError('fetch failed'), new DOMException('timed out', 'TimeoutError')]) {
			const d = deps(() => Promise.reject(err));
			expect(await renewMandateSession(d)).toEqual({ kind: 'mandate', exp: T + 200, renewed: false });
		}
	});

	it('does not renew on any answer but 200, and does not leave its body open', async () => {
		for (const status of [201, 204, 302, 401, 403, 429, 500]) {
			const res = new Response(status === 204 ? null : JSON.stringify(ANSWER_FIXTURE), { status });
			const cancel = res.body ? vi.spyOn(res.body, 'cancel') : null;
			expect(await renewMandateSession(deps(res)), String(status)).toMatchObject({ renewed: false });
			if (cancel) expect(cancel, String(status)).toHaveBeenCalled();
		}
	});

	it('never turns a mandate session into the owner\'s, whatever the body', async () => {
		const answers: unknown[] = [
			{ valid: true },
			{ valid: false, principal: ANSWER_FIXTURE.principal },
			{ principal: ANSWER_FIXTURE.principal },
			{},
			null,
			{ valid: true, principal: null },
			{ valid: true, principal: { ...ANSWER_FIXTURE.principal, kind: 'owner' } },
			{ valid: true, principal: { ...ANSWER_FIXTURE.principal, mandate_id: 'TEST-MANDATE-2' } },
			{ valid: true, principal: { ...ANSWER_FIXTURE.principal, email: 'other@example.invalid' } },
			{ valid: true, principal: { ...ANSWER_FIXTURE.principal, mandate_expires_at: 'not a date' } },
		];
		for (const body of answers) {
			expect(await renewMandateSession(deps(ok(body))), JSON.stringify(body)).toEqual({ kind: 'mandate', exp: T + 200, renewed: false });
		}
		expect(await renewMandateSession(deps(new Response('ok', { status: 200 })))).toMatchObject({ renewed: false });
	});

	it('does not renew when the mandate ends no later than the session already does', async () => {
		const endsNow = { valid: true, principal: { ...ANSWER_FIXTURE.principal, mandate_expires_at: new Date((T + 200) * 1000).toISOString() } };
		expect(await renewMandateSession(deps(ok(endsNow)))).toMatchObject({ renewed: false, exp: T + 200 });
		const ended = { valid: true, principal: { ...ANSWER_FIXTURE.principal, mandate_expires_at: new Date(T * 1000).toISOString() } };
		expect(await renewMandateSession(deps(ok(ended)))).toMatchObject({ renewed: false });
		const oneLater = { valid: true, principal: { ...ANSWER_FIXTURE.principal, mandate_expires_at: new Date((T + 201) * 1000).toISOString() } };
		expect(await renewMandateSession(deps(ok(oneLater)))).toMatchObject({ renewed: true, exp: T + 201 });
	});
});

describe('foreignRequest', () => {
	const OWN = 'https://tenant.example.invalid';
	const req = (headers: Record<string, string>) => new Request(`${OWN}/auth/renew`, { method: 'POST', headers });

	it('takes Sec-Fetch-Site when the browser sends it', () => {
		expect(foreignRequest(req({ 'sec-fetch-site': 'same-origin' }), OWN)).toBe(false);
		expect(foreignRequest(req({ 'sec-fetch-site': 'same-site' }), OWN)).toBe(true);
		expect(foreignRequest(req({ 'sec-fetch-site': 'cross-site' }), OWN)).toBe(true);
		expect(foreignRequest(req({ 'sec-fetch-site': 'none' }), OWN)).toBe(true);
		// Sec-Fetch-Site wins over a matching Origin.
		expect(foreignRequest(req({ 'sec-fetch-site': 'same-site', origin: OWN }), OWN)).toBe(true);
	});

	it('falls back to Origin, and lets a request with neither through', () => {
		expect(foreignRequest(req({ origin: OWN }), OWN)).toBe(false);
		expect(foreignRequest(req({ origin: 'https://sibling.example.invalid' }), OWN)).toBe(true);
		expect(foreignRequest(req({ origin: 'null' }), OWN)).toBe(true);
		expect(foreignRequest(req({}), OWN)).toBe(false);
	});
});
