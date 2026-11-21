import { ARTIFACT_FRAME_PATH } from '../utils/artifact-frame-protocol.js';
import { APP_FALLBACK_CSP } from './app-csp.js';

/**
 * The response headers the hooks own, as functions of the path and the headers, so they can be
 * tested without a SvelteKit server.
 */

/** `Sec-Fetch-Dest` values of a request that wants to be displayed inside a frame. */
const FRAME_DESTINATIONS = new Set(['iframe', 'frame']);

/**
 * Refuse a request that asks to be framed, on every path but the frame endpoint.
 *
 * Why before anything else runs: an artifact can navigate its own frame. If that frame could
 * load an app URL, the request would carry the session cookie, and a GET with a side effect
 * (the magic-link callback sets a session) would take effect before any `frame-ancestors`
 * check on the response. Refusing on the request's own `Sec-Fetch-Dest` stops it before the
 * route runs. Browsers without Fetch Metadata send no such header and are not refused here;
 * the pages' `frame-ancestors 'none'` still keeps them from being shown in a frame.
 */
export function refuseFraming(pathname: string, secFetchDest: string | null): Response | null {
	if (pathname === ARTIFACT_FRAME_PATH) return null;
	if (secFetchDest === null || !FRAME_DESTINATIONS.has(secFetchDest.toLowerCase())) return null;
	return new Response('This page cannot be shown in a frame.', {
		status: 403,
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
			'X-Frame-Options': 'DENY',
			'X-Content-Type-Options': 'nosniff',
			'Cache-Control': 'no-store',
		},
	});
}

/**
 * Set the security headers on a response for `pathname`.
 *
 * - The page policy comes from SvelteKit (`kit.csp`), with this response's nonce. When a
 *   response has no policy at all (a static error page, another endpoint) it gets the strict
 *   fallback, which allows no inline script. A policy that is there is never replaced: that
 *   would drop the nonce, or the frame endpoint's sandbox.
 * - HTML is never cached (see below), except the frame endpoint, which is versioned per build
 *   and sets its own caching.
 * - `X-Frame-Options` for browsers that predate `frame-ancestors`: only the frame endpoint may
 *   be framed, and only by the app.
 */
export function applySecurityHeaders(pathname: string, headers: Headers): void {
	const isFrameEndpoint = pathname === ARTIFACT_FRAME_PATH;
	headers.set('X-Content-Type-Options', 'nosniff');
	headers.set('X-Frame-Options', isFrameEndpoint ? 'SAMEORIGIN' : 'DENY');
	headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	headers.set('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
	// HTML pages must NEVER be cached. Without this, iOS WKWebView (PWA + Safari)
	// picks a heuristic max-age and keeps serving the stale `index.html` even
	// after a `location.reload()` or `location.replace(?_v=…)` — the toast in
	// PR #251 and the cold-start guard in PR #252 both bypass-fail because
	// they trigger a network request that iOS satisfies from its own cache.
	// Hashed `_app/immutable/*.{js,css}` assets are safe to cache forever
	// (different filename per build); only the HTML driver document needs
	// no-store. Caught after a canary v1.3.10 incident —
	// the iPhone PWA was stuck reloading to the same cached HTML.
	const ct = headers.get('Content-Type') ?? '';
	if (ct.startsWith('text/html') && !isFrameEndpoint) {
		headers.set('Cache-Control', 'no-store, must-revalidate');
	}
	if (!headers.has('Content-Security-Policy')) {
		headers.set('Content-Security-Policy', APP_FALLBACK_CSP);
	}
}
