/**
 * Stale-bundle recovery for warm browser tabs.
 *
 * After a deploy, an already-open tab keeps running yesterday's JS whose
 * content-hashed dynamic-import chunks 404 against the new server. Vite fires
 * a `vite:preloadError` event for every such failed dynamic import (Mermaid's
 * lazy chunk, route chunks, …). The root layout listens for it and calls
 * `triggerStaleReload()` to hard-reload onto the fresh build, and the Mermaid
 * renderer reuses `isChunkLoadError` so a stale-chunk failure is not masked as
 * a diagram-syntax error.
 *
 * The COLD-START case (cached HTML referencing missing chunks on first load)
 * is handled separately by the inline SHA guard in `app.html`.
 *
 * Loop safety: a reload is attempted at most once per `RELOAD_LOOP_WINDOW_MS`
 * per tab (persisted in `sessionStorage`), so a chunk the server can never
 * satisfy (a genuine misconfig, not a deploy) cannot spin the tab forever.
 */

/**
 * Browser messages emitted when a dynamic `import()` / module preload fails to
 * fetch — the stale-content-hashed-chunk-after-deploy signature. Deliberately
 * NOT matched: real errors thrown inside a successfully-loaded module.
 */
const CHUNK_LOAD_ERROR_RE =
	/Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

/** sessionStorage key holding the epoch-ms of the last auto-reload attempt. */
export const STALE_RELOAD_ATTEMPT_KEY = 'lyx-stale-reload-attempt';

/** Do not auto-reload more than once per this window (per-tab loop guard). */
export const RELOAD_LOOP_WINDOW_MS = 15_000;

/**
 * True when `err` looks like a failed dynamic-import / module-preload — i.e. a
 * stale content-hashed chunk 404 after a deploy, not a fault in the imported
 * module's own logic. Pure; safe in any environment (SSR, tests).
 */
export function isChunkLoadError(err: unknown): boolean {
	const message =
		err instanceof Error
			? err.message
			: typeof err === 'string'
				? err
				: typeof err === 'object' && err !== null && 'message' in err
					? String((err as { message: unknown }).message)
					: '';
	return CHUNK_LOAD_ERROR_RE.test(message);
}

/**
 * Loop guard: allow a reload only if none was attempted within the window.
 * Pure — the caller supplies the clock + last-attempt timestamp. A `null` or
 * unparseable `lastAttempt` (never reloaded / garbage in storage) allows it.
 */
export function shouldAttemptReload(now: number, lastAttempt: number | null): boolean {
	if (lastAttempt === null || Number.isNaN(lastAttempt)) return true;
	return now - lastAttempt >= RELOAD_LOOP_WINDOW_MS;
}

/**
 * Hard-reload the current tab onto the freshly-deployed bundle, cache-busting
 * so iOS WKWebView cannot re-serve the stale HTML (mirrors the cold-start guard
 * in `app.html` and StatusBar's manual "Reload now"). No-ops during SSR, shares
 * the per-load `__lynoxStaleReloadFired` flag with app.html so it never
 * double-fires, and is loop-guarded so a permanently-missing chunk cannot spin.
 */
export function triggerStaleReload(): void {
	if (typeof window === 'undefined') return;
	const flagged = window as Window & { __lynoxStaleReloadFired?: boolean };
	// Shared with app.html's cold-start guard: never double-fire within one load.
	if (flagged.__lynoxStaleReloadFired) return;

	const now = Date.now();
	let lastAttempt: number | null = null;
	try {
		const raw = window.sessionStorage.getItem(STALE_RELOAD_ATTEMPT_KEY);
		lastAttempt = raw === null ? null : Number(raw);
	} catch {
		/* private mode / storage disabled: rely on the per-load flag only */
	}
	if (!shouldAttemptReload(now, lastAttempt)) return;

	flagged.__lynoxStaleReloadFired = true;
	try {
		window.sessionStorage.setItem(STALE_RELOAD_ATTEMPT_KEY, String(now));
	} catch {
		/* ignore — the per-load flag still prevents a same-load double-fire */
	}

	try {
		const url = new URL(window.location.href);
		url.searchParams.set('_v', String(now));
		window.location.replace(url.toString());
	} catch {
		window.location.reload();
	}
}
