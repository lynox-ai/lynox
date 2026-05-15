// === Session-expired global state ===
//
// `lynox_session` cookies have a 30-day TTL on the engine, but Safari
// PWA frequently evicts them on its own schedule (per
// `feedback_safari_pwa_cookie_eviction.md`). When that happens,
// `/api/health` keeps returning 200 (no auth required) so the status
// bar shows "Engine OK", but every other endpoint 401s. The user sees
// generic "Laden fehlgeschlagen" toasts in every view and assumes the
// engine is down — when really their session just needs a refresh.
//
// This store + the AppShell-mounted fetch interceptor flip the flag on
// any 401 from `/api/*`, the AppShell banner offers a "neu anmelden"
// CTA. Single source of truth so two views racing at the same 401
// don't show two banners.

const DISMISS_COOLDOWN_MS = 30_000;

let _sessionExpired = $state(false);
// Soft-dismiss timestamp. When the user clicks "Später" the banner
// hides for 30s. Without this an in-flight 401 from a parallel poller
// would re-flip the flag instantly and the user feels gaslit.
let _dismissedUntil = 0;
// Set by handleSessionExpired (chat.svelte.ts) when it's already taking
// over the auth-failure UX (red chatError + auto-redirect to /login).
// A boolean — not a wall-clock window — because iOS Safari throttles
// setTimeout in backgrounded tabs, so a 5s "suppress for N seconds"
// could expire before the redirect actually fires and the orange banner
// would re-appear. The flag is implicitly cleared by the navigation
// itself (module re-evaluates on /login load).
let _redirectPending = false;

export function isSessionExpired(): boolean {
	return _sessionExpired;
}

export function markSessionExpired(): void {
	if (Date.now() < _dismissedUntil) return;
	if (_redirectPending) return;
	_sessionExpired = true;
}

export function clearSessionExpired(): void {
	_sessionExpired = false;
	_dismissedUntil = Date.now() + DISMISS_COOLDOWN_MS;
}

/**
 * Called by callers (currently chat.svelte.ts:handleSessionExpired) that
 * are already taking over the auth-failure UX — showing their own
 * dedicated message + auto-redirecting to /login. Suppresses the orange
 * banner so the user sees one notice for the same 401, not two.
 */
export function suppressSessionExpiredBanner(): void {
	_redirectPending = true;
	_sessionExpired = false;
}
