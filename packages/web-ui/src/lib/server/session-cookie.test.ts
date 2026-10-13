import { describe, it, expect } from 'vitest';
import type { Cookies } from '@sveltejs/kit';
import { SESSION_COOKIE, setSessionCookie } from './session-cookie.js';

function capture(): { cookies: Cookies; calls: Array<[string, string, Record<string, unknown>]> } {
	const calls: Array<[string, string, Record<string, unknown>]> = [];
	return { cookies: { set: (n: string, v: string, o: Record<string, unknown>) => { calls.push([n, v, o]); } } as unknown as Cookies, calls };
}

describe('setSessionCookie', () => {
	it('writes lynox_session for the whole site, httpOnly, Lax, with the session\'s age', () => {
		const { cookies, calls } = capture();
		setSessionCookie(cookies, { token: 'TOKEN', maxAge: 900 }, true);
		expect(SESSION_COOKIE).toBe('lynox_session');
		expect(calls).toEqual([['lynox_session', 'TOKEN', { path: '/', httpOnly: true, secure: true, sameSite: 'lax', maxAge: 900 }]]);
	});

	it('marks it Secure only over HTTPS', () => {
		const { cookies, calls } = capture();
		setSessionCookie(cookies, { token: 'TOKEN', maxAge: 60 }, false);
		expect(calls[0]![2]).toMatchObject({ secure: false, maxAge: 60 });
	});
});
