// === window.fetch interceptor — flips sessionExpired on /api/* 401, and on the 403 of an ended access ===
//
// Installed once from AppShell on mount. Wraps `window.fetch` and looks
// at every response. A 401 from a `/api/*` URL that ISN'T part of the
// auth handshake itself flips the global `sessionExpired` state so the
// AppShell banner can offer a re-auth CTA — without forcing every view
// to migrate to a typed wrapper up-front.
//
// Idempotent across HMR via a `window` sentinel: the module re-evaluates
// on every Vite save, so a module-level flag would reset to false and
// stack a new wrapper on top of the already-wrapped fetch on every
// change. The sentinel lives on `window` and survives HMR.

import { markMandateMemoryBlocked, markSessionExpired } from '../stores/session.svelte.js';

// Routes that legitimately 401 while the session is fine — wrong creds
// during login, unauth check before login, etc. Triggering the
// "session expired" banner on these would gaslight the user.
const AUTH_HANDSHAKE_PATHS = ['/api/auth/', '/api/login', '/api/setup/'];

declare global {
	interface Window { __lynoxFetchPatched?: boolean }
}

export function installApiFetchInterceptor(): void {
	if (typeof window === 'undefined') return;
	if (window.__lynoxFetchPatched === true) return;
	window.__lynoxFetchPatched = true;
	const original = window.fetch;
	window.fetch = async function lynoxFetchInterceptor(...args: Parameters<typeof fetch>) {
		const response = await original(...args);
		// Only treat /api/* refusals as session-expired — third-party fetches
		// (analytics, integrations) shouldn't trigger the auth banner.
		if (response.status === 401 || response.status === 403) {
			const url = typeof args[0] === 'string'
				? args[0]
				: args[0] instanceof URL
					? args[0].href
					: (args[0] as Request).url;
			if (url.includes('/api/') && !AUTH_HANDSHAKE_PATHS.some(p => url.includes(p))) {
				if (response.status === 401) {
					markSessionExpired();
				} else {
					const code = await refusalCode(response);
					if (code === 'mandate_revoked') markSessionExpired();
					else if (code === 'mandate_memory_off') markMandateMemoryBlocked('off');
					else if (code === 'mandate_memory_missing') markMandateMemoryBlocked('missing');
				}
			}
		}
		return response;
	};
}

/**
 * The code of a 403 that is about the session, not the view: `mandate_revoked` (a delegated
 * access that has ended) and `mandate_memory_off`/`_missing` (a delegated access this instance
 * cannot let in while it runs without durable knowledge). Every other 403 is a state of the
 * view that got it (a managed instance, an owner-only action) and stays the view's to show.
 * Reads a clone, so the caller still gets the whole body.
 */
async function refusalCode(response: Response): Promise<string | null> {
	try {
		const body: unknown = await response.clone().json();
		const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
		return typeof code === 'string' ? code : null;
	} catch {
		return null;
	}
}
