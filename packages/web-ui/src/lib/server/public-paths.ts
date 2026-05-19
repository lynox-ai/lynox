/**
 * Allowlist of paths that bypass the SvelteKit auth gate in
 * `hooks.server.ts`. Extracted so the predicate can be unit-tested
 * without spinning up a SvelteKit handle.
 *
 * Adding a path here means an unauthenticated browser GET reaches the
 * route. That's correct for endpoints whose REQUEST itself carries the
 * auth (passkey assertion, magic-link HMAC token) but dangerous for
 * anything that reads state with only the session cookie. Audit any
 * addition against:
 * - Does the request carry its own credential (HMAC token, signed
 *   payload, WebAuthn assertion)?
 * - Is the response a redirect (no information leak) or does it expose
 *   user data?
 */

/** Exact paths that never require authentication. */
export const PUBLIC_EXACT: ReadonlySet<string> = new Set([
	'/login',
	'/logout',
	'/health',
	// Magic-link callback — the HMAC token in `?token=…` IS the auth.
	// Without this, the engine 401s the mail-arrival GET before the
	// route can validate the token + mint a session cookie. Single GET
	// handler, lives in PUBLIC_EXACT (not PREFIXES) because we want
	// `/auth/magicfoo` to stay protected.
	'/auth/magic',
]);

/** Prefixes that never require authentication (with trailing slash enforced). */
export const PUBLIC_PREFIXES: ReadonlyArray<string> = [
	// `/auth/passkey` covers POST register/start, register/complete,
	// authenticate/start, authenticate/complete — the WebAuthn flow
	// itself IS the auth.
	'/auth/passkey',
];

export function isPublic(pathname: string): boolean {
	if (PUBLIC_EXACT.has(pathname)) return true;
	return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
}
