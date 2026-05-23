import { describe, it, expect } from 'vitest';
import type { Cookies } from '@sveltejs/kit';
import { load } from './+page.server.js';

type DeletedCookie = { name: string; opts: { path?: string } };

function makeCookies(initial: Record<string, string>): {
	cookies: Cookies;
	deletes: DeletedCookie[];
} {
	const store: Record<string, string> = { ...initial };
	const deletes: DeletedCookie[] = [];
	const cookies = {
		get: (name: string) => store[name],
		delete: (name: string, opts: { path?: string }) => {
			deletes.push({ name, opts });
			delete store[name];
		},
	} as unknown as Cookies;
	return { cookies, deletes };
}

function makeRequest(headers: Record<string, string>): Request {
	return new Request('http://app.example/logout', { headers });
}

async function callLoad(args: {
	cookie?: string;
	sec_fetch_site?: string;
	sec_fetch_dest?: string;
}): Promise<{ deletes: DeletedCookie[]; redirectedTo: string | null }> {
	const { cookies, deletes } = makeCookies(args.cookie ? { lynox_session: args.cookie } : {});
	const headers: Record<string, string> = {};
	if (args.sec_fetch_site) headers['sec-fetch-site'] = args.sec_fetch_site;
	if (args.sec_fetch_dest) headers['sec-fetch-dest'] = args.sec_fetch_dest;
	const request = makeRequest(headers);
	try {
		// load throws a `redirect()` — Symbol-tagged HttpError-like from sveltejs/kit
		await load({ cookies, request } as Parameters<typeof load>[0]);
		return { deletes, redirectedTo: null };
	} catch (thrown) {
		const redirectLocation =
			thrown && typeof thrown === 'object' && 'location' in thrown
				? (thrown as { location: string }).location
				: null;
		return { deletes, redirectedTo: redirectLocation };
	}
}

describe('logout +page.server load() — cookie-clearing guards', () => {
	it('top-level navigation with same-origin: deletes session cookie + redirects', async () => {
		const r = await callLoad({
			cookie: 'tok.123.abc',
			sec_fetch_site: 'same-origin',
			sec_fetch_dest: 'document',
		});
		expect(r.deletes).toEqual([{ name: 'lynox_session', opts: { path: '/' } }]);
		expect(r.redirectedTo).toBe('/login');
	});

	it('SvelteKit __data.json prefetch (sec-fetch-dest=empty): does NOT delete the cookie', async () => {
		// Regression: 2026-05-23 — hovering the rail logout link triggered
		// hover-prefetch (`<body data-sveltekit-preload-data="hover">`), the
		// /logout/__data.json fetch ran load(), and the user was silently
		// logged out. Confirmed against staging-engine logs at 17:29 UTC.
		const r = await callLoad({
			cookie: 'tok.123.abc',
			sec_fetch_site: 'same-origin',
			sec_fetch_dest: 'empty',
		});
		expect(r.deletes).toEqual([]);
		expect(r.redirectedTo).toBe('/login');
	});

	it('cross-site GET (sec-fetch-site=cross-site, even with document dest): does NOT delete', async () => {
		const r = await callLoad({
			cookie: 'tok.123.abc',
			sec_fetch_site: 'cross-site',
			sec_fetch_dest: 'document',
		});
		expect(r.deletes).toEqual([]);
		expect(r.redirectedTo).toBe('/login');
	});

	it('no cookie sent: no-op delete, still redirects', async () => {
		const r = await callLoad({ sec_fetch_dest: 'document', sec_fetch_site: 'same-origin' });
		expect(r.deletes).toEqual([]);
		expect(r.redirectedTo).toBe('/login');
	});

	it('missing sec-fetch-dest (older clients/curl): treats as non-document → does NOT delete', async () => {
		// Conservative default — if a fetch impl doesn't send Sec-Fetch-Dest
		// we cannot prove it's a real top-level navigation. Better to leave
		// the cookie intact than to silently log a user out.
		const r = await callLoad({ cookie: 'tok.123.abc' });
		expect(r.deletes).toEqual([]);
		expect(r.redirectedTo).toBe('/login');
	});
});
