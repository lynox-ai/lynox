import { describe, it, expect } from 'vitest';
import { isPublic, PUBLIC_EXACT, PUBLIC_PREFIXES } from './public-paths.js';

describe('isPublic — exact matches', () => {
	it.each([
		['/login'],
		['/logout'],
		['/health'],
		['/auth/magic'],
		['/'],
	])('treats %s as public', (path) => {
		expect(isPublic(path)).toBe(true);
	});

	it('does NOT treat a similar-but-not-equal path as public', () => {
		expect(isPublic('/logins')).toBe(false);
		expect(isPublic('/health/check')).toBe(false);
		// /auth/magic is exact — /auth/magicfoo or /auth/magic/extra should be gated
		expect(isPublic('/auth/magicfoo')).toBe(false);
		expect(isPublic('/auth/magic/extra')).toBe(false);
	});
});

describe('isPublic — prefix matches', () => {
	it.each([
		['/auth/passkey'],
		['/auth/passkey/'],
		['/auth/passkey/register/start'],
		['/auth/passkey/authenticate/complete'],
	])('treats %s as public via prefix', (path) => {
		expect(isPublic(path)).toBe(true);
	});

	it('requires a path separator after the prefix (no /auth/passkeyfoo)', () => {
		// PUBLIC_PREFIXES rule is `pathname === p || pathname.startsWith(p + '/')`
		// so /auth/passkeyfoo is NOT public.
		expect(isPublic('/auth/passkeyfoo')).toBe(false);
	});
});

describe('isPublic — defaults to protected', () => {
	it('treats unknown paths as protected', () => {
		// `/` was moved into PUBLIC_EXACT (see header note on `public-paths.ts`)
		// because the root +page.server.ts is now a pure-redirect handler that
		// fires the demo-mode auto-session short-circuit on `LYNOX_DEMO_MODE=true`
		// tenants. Without the public exemption the auth gate redirects /
		// straight to /login and the short-circuit never runs.
		expect(isPublic('/app')).toBe(false);
		expect(isPublic('/app/chat')).toBe(false);
		expect(isPublic('/api/config')).toBe(false);
		expect(isPublic('/auth')).toBe(false); // bare /auth — not in either list
		expect(isPublic('')).toBe(false);
	});
});

describe('PUBLIC_EXACT + PUBLIC_PREFIXES — public-surface inventory', () => {
	// This test exists so any future addition to either list lands in a
	// PR diff loud enough to trigger a security review. If you're here
	// to bump the count, audit the new entry against the guidance in
	// `public-paths.ts`'s header comment before touching this assertion.
	it('locks the current public-path inventory', () => {
		expect([...PUBLIC_EXACT].sort()).toEqual([
			'/',
			'/auth/magic',
			'/health',
			'/login',
			'/logout',
		]);
		expect([...PUBLIC_PREFIXES].sort()).toEqual(['/auth/passkey']);
	});
});
