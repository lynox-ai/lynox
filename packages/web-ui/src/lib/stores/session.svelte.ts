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

let _sessionExpired = $state(false);

export function isSessionExpired(): boolean {
	return _sessionExpired;
}

export function markSessionExpired(): void {
	_sessionExpired = true;
}

export function clearSessionExpired(): void {
	_sessionExpired = false;
}
